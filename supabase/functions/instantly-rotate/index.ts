import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { JurisdictionRow } from "../_shared/research/jurisdiction.ts";
import { rotateLeadBody } from "./lead.ts";
import { allocate, rotationCampaigns } from "./allocate.ts";

// Rotates leads for every banked Instantly campaign under one shared workspace contact cap.
// Modes: ?mode=rotate (default, twice daily) | ?mode=trim (one-time cutover: delete never-contacted leads down to cap)
//
// v3 (2026-10-09): the original campaign was deleted when the workspace moved to the Growth plan and recreated
// empty with a new id. This version targets the new campaign by default, works inside the edge-function
// wall-clock limit (time budget + bounded pushes + concurrency), always writes a rotation_runs row even when
// it stops early, trips a breaker when pushes fail in a row, and marks lead_bank rows that are no longer in
// Instantly as orphaned instead of leaving them "active" forever.
//
// v4 (2026-11-09): multi-campaign. instantly-push banks pushes above lume_settings.bank_threshold, so any
// campaign can now have queued lead_bank rows. A run serves ROTATE_CAMPAIGN_ID (always) plus every
// campaign with queued / active / replied bank rows (lead_bank_rotation_campaigns()). The cap was always
// workspace-wide (every lead Instantly lists counts); free slots go to the oldest queued rows first
// (lead_bank.id order) across campaigns, each lead into its own campaign_id (allocate.ts). With only
// ROTATE_CAMPAIGN_ID banked, a run does exactly what v3 did. For the other campaigns only leads the bank
// knows are archived and deleted (a lead pushed directly is never removed by the rotation). trim mode
// stays primary-only.
const CAMPAIGN = Deno.env.get("ROTATE_CAMPAIGN_ID") ?? "869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d";
const CAP = Number(Deno.env.get("ROTATE_CAP") ?? "1000");
const MAX_PUSH = Number(Deno.env.get("ROTATE_MAX_PUSH") ?? "450"); // per run; two runs a day fill the cap
const TIME_BUDGET_MS = Number(Deno.env.get("ROTATE_TIME_BUDGET_MS") ?? "110000"); // stay under the 150 s limit
const CONCURRENCY = 4;
const REPLY_GRACE_DAYS = 7;
const IK = Deno.env.get("INSTANTLY_API_KEY")!;
const API = "https://api.instantly.ai/api/v2";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function ik(path: string, init: RequestInit = {}, tries = 0): Promise<any> {
  // Only send a JSON content-type when there is a body: Instantly's server rejects a body-less DELETE
  // that carries the header with 400 FST_ERR_CTP_EMPTY_JSON_BODY, which is what blocked every slot release.
  const headers: Record<string, string> = { Authorization: `Bearer ${IK}`, ...(init.headers as Record<string, string> ?? {}) };
  if (init.body != null) headers["Content-Type"] = "application/json";
  const r = await fetch(API + path, { ...init, headers });
  if (r.status === 429 && tries < 5) { await new Promise((s) => setTimeout(s, 2000 * (tries + 1))); return ik(path, init, tries + 1); }
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

async function listAllLeads(): Promise<any[]> {
  const out: any[] = []; let after: string | undefined;
  for (let page = 0; page < 200; page++) {
    const body: any = { limit: 100 }; if (after) body.starting_after = after;
    const d = await ik("/leads/list", { method: "POST", body: JSON.stringify(body) });
    out.push(...(d.items ?? []));
    if (!d.next_starting_after || !d.items?.length) break;
    after = d.next_starting_after;
  }
  return out;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

Deno.serve(async (req) => {
  const started = Date.now();
  const left = () => TIME_BUDGET_MS - (Date.now() - started);
  const mode = new URL(req.url).searchParams.get("mode") ?? "rotate";
  const errors: string[] = []; const now = new Date();
  let before = 0, archived = 0, deleted = 0, pushed = 0, orphaned = 0, listed = false;
  let all: any[] = [], mine: any[] = [];

  // Campaigns this run serves. A failed read means the primary only (v3 behaviour).
  let campaigns = [CAMPAIGN];
  if (mode !== "trim") {
    const banked = await sb.rpc("lead_bank_rotation_campaigns");
    if (banked.error) errors.push(`campaigns: ${String(banked.error.message).slice(0, 150)}; rotating ${CAMPAIGN} only`);
    else campaigns = rotationCampaigns(CAMPAIGN, ((banked.data ?? []) as any[]).map((r) => String(typeof r === "string" ? r : Object.values(r ?? {})[0] ?? "")));
  }
  const served = new Set(campaigns);
  type Stat = { in_instantly: number; archived: number; deleted: number; pushed: number; orphaned: number };
  const stats: Record<string, Stat> = {};
  const stat = (c: string) => stats[c] ?? (stats[c] = { in_instantly: 0, archived: 0, deleted: 0, pushed: 0, orphaned: 0 });
  for (const c of campaigns) stat(c);

  try {
    all = await listAllLeads(); listed = true;
    before = all.length;
    // Non-primary campaigns: only the leads the bank knows (active / replied) are the rotation's to archive.
    const extras = campaigns.filter((c) => c !== CAMPAIGN);
    const known = new Set<string>();
    for (let from = 0; extras.length && from < 50000; from += 1000) {
      const { data, error } = await sb.from("lead_bank").select("campaign_id,email").in("campaign_id", extras).in("state", ["active", "replied"])
        .order("id").range(from, from + 999);
      if (error) { errors.push(`bank read: ${String(error.message).slice(0, 150)}`); break; }
      for (const r of data ?? []) known.add(`${r.campaign_id}|${String(r.email).toLowerCase()}`);
      if ((data ?? []).length < 1000) break;
    }
    mine = all.filter((l) => l.campaign === CAMPAIGN || (served.has(l.campaign) && known.has(`${l.campaign}|${String(l.email ?? "").toLowerCase()}`)));
    for (const l of all) if (served.has(l.campaign)) stat(l.campaign).in_instantly++;
  } catch (e) { errors.push(`fatal: list leads: ${String(e).slice(0, 300)}`); }

  const archive = async (l: any, state: string, del: boolean) => {
    const patch: any = { state, final_status: l.status, email_reply_count: l.email_reply_count ?? 0, email_open_count: l.email_open_count ?? 0,
      interest_status: l.lt_interest_status ?? null, finished_at: now.toISOString(), updated_at: now.toISOString() };
    if (!del) patch.delete_after = new Date(now.getTime() + REPLY_GRACE_DAYS * 864e5).toISOString();
    await sb.from("lead_bank").update(patch).eq("campaign_id", l.campaign).eq("email", l.email.toLowerCase());
    archived++; stat(l.campaign).archived++;
    if (del) { await ik(`/leads/${l.id}`, { method: "DELETE" }); deleted++; stat(l.campaign).deleted++; }
  };

  if (listed) {
    try {
      if (mode === "trim") {
        let total = before;
        for (const l of mine) {
          if (total <= CAP || left() < 5000) break;
          if (l.status === 1 && !l.timestamp_last_contact) {
            await ik(`/leads/${l.id}`, { method: "DELETE" });
            await sb.from("lead_bank").update({ state: "queued", instantly_lead_id: null, pushed_at: null, updated_at: now.toISOString() })
              .eq("campaign_id", CAMPAIGN).eq("email", l.email.toLowerCase());
            deleted++; stat(CAMPAIGN).deleted++; total--;
          }
        }
      } else {
        // 1. archive finished leads and free their slots
        for (const l of mine) {
          if (left() < 20000) { errors.push("budget: stopped archiving early"); break; }
          try {
            const replied = (l.email_reply_count ?? 0) > 0;
            if (replied) {
              const { data } = await sb.from("lead_bank").select("state,delete_after").eq("campaign_id", l.campaign).eq("email", l.email.toLowerCase()).maybeSingle();
              if (data?.state !== "replied") await archive(l, "replied", false);
              else if (data.delete_after && new Date(data.delete_after) < now) { await ik(`/leads/${l.id}`, { method: "DELETE" }); deleted++; stat(l.campaign).deleted++; }
              continue;
            }
            if (l.status === 3) await archive(l, "completed", true);
            else if (l.status === -1) await archive(l, "bounced", true);
            else if (l.status === -2) await archive(l, "unsubscribed", true);
            else if (l.status === -3) await archive(l, "skipped", true);
          } catch (e) { errors.push(`${l.email}: ${String(e).slice(0, 150)}`); }
        }

        // 2. lead_bank rows marked active/replied that Instantly no longer has (campaign deleted or lead removed by hand)
        const inInstantly = new Set(all.map((l) => String(l.email ?? "").toLowerCase()));
        const { data: open } = await sb.from("lead_bank").select("id,email,state,campaign_id").in("campaign_id", campaigns).in("state", ["active", "replied"]).limit(5000);
        const goneRows = (open ?? []).filter((r) => !inInstantly.has(String(r.email).toLowerCase()));
        const gone = goneRows.map((r) => r.id);
        for (let i = 0; i < gone.length; i += 200) {
          await sb.from("lead_bank").update({ state: "skipped", interest_status: "orphaned: not in Instantly at " + now.toISOString().slice(0, 10), finished_at: now.toISOString(), updated_at: now.toISOString() })
            .in("id", gone.slice(i, i + 200));
        }
        orphaned = gone.length;
        for (const r of goneRows) stat(r.campaign_id).orphaned++;

        // 3. fill free slots from the queue: the workspace cap is shared, the oldest queued rows go first
        //    across campaigns (lead_bank.id order), each into its own campaign, bounded by MAX_PUSH and the time budget
        const inWorkspace = before - deleted;
        const free = allocate({ cap: CAP, inWorkspace, maxPush: MAX_PUSH, queued: [] }).free;
        if (free > 0) {
          // Active jurisdictions, read once per run. A failed read means none: every lead gets the fallback law.
          const jur = await sb.from("jurisdictions").select("country,region,city_match,jurisdiction,compliance_name,short_name,active").eq("active", true);
          if (jur.error) errors.push(`jurisdictions: ${String(jur.error.message).slice(0, 150)}; fallback compliance_law used`);
          const jurisdictions = (jur.error ? [] : jur.data ?? []) as JurisdictionRow[];
          let consecutiveFailures = 0, tripped = false, attempted = 0;
          // Per-campaign breaker: a campaign whose first 5 pushes this run all fail (deleted campaign, say) is
          // skipped for the rest of the run, and a second round hands its slots to the next oldest queue.
          const campFail: Record<string, number> = {}; const campTripped = new Set<string>(); const failedIds = new Set<number>();
          for (let round = 0; round < 2; round++) {
            const eligible = campaigns.filter((c) => !campTripped.has(c));
            const want = free - pushed;
            if (tripped || !eligible.length || want <= 0) break;
            const { data: rows } = await sb.from("lead_bank").select("*").in("campaign_id", eligible).eq("state", "queued").order("id").limit(want + failedIds.size);
            const { picked } = allocate({ cap: CAP, inWorkspace: inWorkspace + pushed, maxPush: want,
              queued: ((rows ?? []) as any[]).filter((r) => !failedIds.has(r.id)) });
            attempted += picked.length;
            await pool(picked, CONCURRENCY, async (q: any) => {
              if (tripped || campTripped.has(q.campaign_id) || left() < 8000) return;
              try {
                const d = await ik("/leads", { method: "POST", body: JSON.stringify(rotateLeadBody(q, q.campaign_id, jurisdictions)) });
                await sb.from("lead_bank").update({ state: "active", instantly_lead_id: d?.id ?? null, pushed_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", q.id);
                pushed++; stat(q.campaign_id).pushed++; consecutiveFailures = 0; campFail[q.campaign_id] = 0;
              } catch (e) {
                failedIds.add(q.id);
                errors.push(`push ${q.email}: ${String(e).slice(0, 150)}`);
                campFail[q.campaign_id] = (campFail[q.campaign_id] ?? 0) + 1;
                if (++consecutiveFailures >= 5 && pushed === 0) { tripped = true; errors.push("breaker: first pushes all failed, stopped pushing"); }
                else if (campFail[q.campaign_id] >= 5 && stat(q.campaign_id).pushed === 0 && !campTripped.has(q.campaign_id)) {
                  campTripped.add(q.campaign_id); errors.push(`breaker: first pushes to ${q.campaign_id} all failed, skipped it this run`);
                }
              }
            });
            if (!campTripped.size || left() < 8000) break;
          }
          if (left() < 8000 && pushed < attempted) errors.push(`budget: pushed ${pushed} of ${attempted} this run`);
        }
      }
    } catch (e) { errors.push(`fatal: ${String(e).slice(0, 300)}`); }
  }

  const after = before - deleted + pushed;
  const note = mode + (orphaned ? ` · orphaned ${orphaned}` : "") + (campaigns.length > 1 ? ` · ${campaigns.length} campaigns` : "") + ` · ${Math.round((Date.now() - started) / 1000)}s`;
  // One row per run: campaign_id stays ROTATE_CAMPAIGN_ID (dashboards key on it); the breakdown is per_campaign.
  await sb.from("rotation_runs").insert({ campaign_id: CAMPAIGN, in_instantly_before: before, archived, deleted, pushed, in_instantly_after: after, errors, note,
    campaign_ids: campaigns, per_campaign: stats });
  return new Response(JSON.stringify({ mode, before, archived, deleted, pushed, orphaned, after, campaigns: stats, seconds: Math.round((Date.now() - started) / 1000), errors }), { headers: { "Content-Type": "application/json" } });
});
