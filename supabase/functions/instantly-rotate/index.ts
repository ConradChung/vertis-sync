import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Rotates leads for one Instantly campaign under a workspace contact cap.
// Modes: ?mode=rotate (default, daily) | ?mode=trim (one-time cutover: delete never-contacted leads down to cap)
const CAMPAIGN = Deno.env.get("ROTATE_CAMPAIGN_ID") ?? "ab55afe9-b632-4e8d-ac84-48873140c56e";
const CAP = Number(Deno.env.get("ROTATE_CAP") ?? "1000");
const REPLY_GRACE_DAYS = 7;
const IK = Deno.env.get("INSTANTLY_API_KEY")!;
const API = "https://api.instantly.ai/api/v2";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function ik(path: string, init: RequestInit = {}) {
  const r = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${IK}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (r.status === 429) { await new Promise((s) => setTimeout(s, 3000)); return ik(path, init); }
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

async function listAllLeads(): Promise<any[]> {
  const out: any[] = []; let after: string | undefined;
  for (;;) {
    const body: any = { limit: 100 }; if (after) body.starting_after = after;
    const d = await ik("/leads/list", { method: "POST", body: JSON.stringify(body) });
    out.push(...(d.items ?? []));
    if (!d.next_starting_after || !d.items?.length) break;
    after = d.next_starting_after;
  }
  return out;
}

Deno.serve(async (req) => {
  const mode = new URL(req.url).searchParams.get("mode") ?? "rotate";
  const errors: string[] = []; const now = new Date();
  const all = await listAllLeads();
  const mine = all.filter((l) => l.campaign === CAMPAIGN);
  const before = all.length;
  let archived = 0, deleted = 0, pushed = 0;

  const archive = async (l: any, state: string, del: boolean) => {
    const patch: any = { state, final_status: l.status, email_reply_count: l.email_reply_count ?? 0, email_open_count: l.email_open_count ?? 0,
      interest_status: l.lt_interest_status ?? null, finished_at: now.toISOString(), updated_at: now.toISOString() };
    if (!del) patch.delete_after = new Date(now.getTime() + REPLY_GRACE_DAYS * 864e5).toISOString();
    await sb.from("lead_bank").update(patch).eq("campaign_id", CAMPAIGN).eq("email", l.email.toLowerCase());
    archived++;
    if (del) { await ik(`/leads/${l.id}`, { method: "DELETE" }); deleted++; }
  };

  try {
    if (mode === "trim") {
      // cutover: drop never-contacted active leads until workspace total <= CAP; they go back to the queue
      let total = before;
      for (const l of mine) {
        if (total <= CAP) break;
        if (l.status === 1 && !l.timestamp_last_contact) {
          await ik(`/leads/${l.id}`, { method: "DELETE" });
          await sb.from("lead_bank").update({ state: "queued", instantly_lead_id: null, pushed_at: null, updated_at: now.toISOString() })
            .eq("campaign_id", CAMPAIGN).eq("email", l.email.toLowerCase());
          deleted++; total--;
        }
      }
    } else {
      for (const l of mine) {
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
      const free = CAP - (before - deleted);
      if (free > 0) {
        const { data: queue } = await sb.from("lead_bank").select("*").eq("campaign_id", CAMPAIGN).eq("state", "queued").order("id").limit(free);
        for (const q of queue ?? []) {
          try {
            const d = await ik("/leads", { method: "POST", body: JSON.stringify({ campaign: CAMPAIGN, email: q.email, first_name: q.first_name, last_name: q.last_name,
              company_name: q.company_name, website: q.website, personalization: q.personalization,
              custom_variables: { location: q.location, "Operating Cities Copied": q.operating_cities }, skip_if_in_workspace: true }) });
            await sb.from("lead_bank").update({ state: "active", instantly_lead_id: d?.id ?? null, pushed_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", q.id);
            pushed++;
          } catch (e) { errors.push(`push ${q.email}: ${String(e).slice(0, 150)}`); }
        }
      }
    }
  } catch (e) { errors.push(`fatal: ${String(e).slice(0, 300)}`); }

  const after = before - deleted + pushed;
  await sb.from("rotation_runs").insert({ campaign_id: CAMPAIGN, in_instantly_before: before, archived, deleted, pushed, in_instantly_after: after, errors, note: mode });
  return new Response(JSON.stringify({ mode, before, archived, deleted, pushed, after, errors: errors.length }), { headers: { "Content-Type": "application/json" } });
});
