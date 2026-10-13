import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Rotates leads for one Instantly campaign under a workspace contact cap.
// Modes: ?mode=rotate (default, twice daily) | ?mode=trim (one-time cutover: delete never-contacted leads down to cap)
//
// v3 (2026-10-09): the original campaign was deleted when the workspace moved to the Growth plan and recreated
// empty with a new id. This version targets the new campaign by default, works inside the edge-function
// wall-clock limit (time budget + bounded pushes + concurrency), always writes a rotation_runs row even when
// it stops early, trips a breaker when pushes fail in a row, and marks lead_bank rows that are no longer in
// Instantly as orphaned instead of leaving them "active" forever.
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

  try {
    all = await listAllLeads(); listed = true;
    mine = all.filter((l) => l.campaign === CAMPAIGN);
    before = all.length;
  } catch (e) { errors.push(`fatal: list leads: ${String(e).slice(0, 300)}`); }

  const archive = async (l: any, state: string, del: boolean) => {
    const patch: any = { state, final_status: l.status, email_reply_count: l.email_reply_count ?? 0, email_open_count: l.email_open_count ?? 0,
      interest_status: l.lt_interest_status ?? null, finished_at: now.toISOString(), updated_at: now.toISOString() };
    if (!del) patch.delete_after = new Date(now.getTime() + REPLY_GRACE_DAYS * 864e5).toISOString();
    await sb.from("lead_bank").update(patch).eq("campaign_id", CAMPAIGN).eq("email", l.email.toLowerCase());
    archived++;
    if (del) { await ik(`/leads/${l.id}`, { method: "DELETE" }); deleted++; }
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
            deleted++; total--;
          }
        }
      } else {
        // 1. archive finished leads and free their slots
        for (const l of mine) {
          if (left() < 20000) { errors.push("budget: stopped archiving early"); break; }
          try {
            const replied = (l.email_reply_count ?? 0) > 0;
            if (replied) {
              const { data } = await sb.from("lead_bank").select("state,delete_after").eq("campaign_id", CAMPAIGN).eq("email", l.email.toLowerCase()).maybeSingle();
              if (data?.state !== "replied") await archive(l, "replied", false);
              else if (data.delete_after && new Date(data.delete_after) < now) { await ik(`/leads/${l.id}`, { method: "DELETE" }); deleted++; }
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
        const { data: open } = await sb.from("lead_bank").select("id,email,state").eq("campaign_id", CAMPAIGN).in("state", ["active", "replied"]).limit(5000);
        const gone = (open ?? []).filter((r) => !inInstantly.has(String(r.email).toLowerCase())).map((r) => r.id);
        for (let i = 0; i < gone.length; i += 200) {
          await sb.from("lead_bank").update({ state: "skipped", interest_status: "orphaned: not in Instantly at " + now.toISOString().slice(0, 10), finished_at: now.toISOString(), updated_at: now.toISOString() })
            .in("id", gone.slice(i, i + 200));
        }
        orphaned = gone.length;

        // 3. fill free slots from the queue, bounded by MAX_PUSH and the time budget
        const free = Math.min(MAX_PUSH, CAP - (before - deleted));
        if (free > 0) {
          const { data: queue } = await sb.from("lead_bank").select("*").eq("campaign_id", CAMPAIGN).eq("state", "queued").order("id").limit(free);
          let consecutiveFailures = 0, tripped = false;
          await pool(queue ?? [], CONCURRENCY, async (q) => {
            if (tripped || left() < 8000) return;
            try {
              const d = await ik("/leads", { method: "POST", body: JSON.stringify({ campaign: CAMPAIGN, email: q.email, first_name: q.first_name, last_name: q.last_name,
                company_name: q.company_name, website: q.website, personalization: q.personalization,
                custom_variables: { location: q.location, "Operating Cities Copied": q.operating_cities }, skip_if_in_workspace: true }) });
              await sb.from("lead_bank").update({ state: "active", instantly_lead_id: d?.id ?? null, pushed_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", q.id);
              pushed++; consecutiveFailures = 0;
            } catch (e) {
              errors.push(`push ${q.email}: ${String(e).slice(0, 150)}`);
              if (++consecutiveFailures >= 5 && pushed === 0) { tripped = true; errors.push("breaker: first pushes all failed, stopped pushing"); }
            }
          });
          if (left() < 8000 && pushed < (queue?.length ?? 0)) errors.push(`budget: pushed ${pushed} of ${queue?.length ?? 0} this run`);
        }
      }
    } catch (e) { errors.push(`fatal: ${String(e).slice(0, 300)}`); }
  }

  const after = before - deleted + pushed;
  const note = mode + (orphaned ? ` · orphaned ${orphaned}` : "") + ` · ${Math.round((Date.now() - started) / 1000)}s`;
  await sb.from("rotation_runs").insert({ campaign_id: CAMPAIGN, in_instantly_before: before, archived, deleted, pushed, in_instantly_after: after, errors, note });
  return new Response(JSON.stringify({ mode, before, archived, deleted, pushed, orphaned, after, seconds: Math.round((Date.now() - started) / 1000), errors }), { headers: { "Content-Type": "application/json" } });
});
