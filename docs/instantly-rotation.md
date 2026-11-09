# Instantly lead rotation

Keeps the "Scaleport - Fall Mega" campaign (`869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d`) under the 1,000 uploaded-contact cap of the Instantly Growth plan by deleting finished leads and pushing queued ones from a Supabase lead bank. Instantly's cap counts contacts stored at one time, active or paused, and deleting frees a slot within about five minutes, so rotation by deletion is valid.

## Pieces

| Piece | Where |
|---|---|
| `lead_bank`, `rotation_runs` | `supabase/migrations/20261008222655_instantly_lead_rotation.sql` |
| cron ticks `instantly-rotate-am` (13:00 UTC) and `instantly-rotate-pm` (01:00 UTC) | `supabase/migrations/20261008223419_instantly_rotation_schedule.sql` |
| `rotation_dashboard()` aggregate RPC, anon-callable | `supabase/migrations/*_rotation_dashboard_rpc.sql` |
| `instantly-rotate` edge function | `supabase/functions/instantly-rotate/index.ts` |
| Dashboard | `public/dashboard/instantly-rotation.html`, served by the Next app on Vercel at `/dashboard/instantly-rotation.html` (behind the CRM login), and the claude.ai artifact |

## Lead bank routing and multi-campaign rotation (v4, 2026-11-09)

- `instantly-push` reads `lume_settings.bank_threshold` (Lume Settings → Budget; fallback env `BANK_THRESHOLD`, then 1000). A push whose eligible leads (same `decideRow`, same barriers) exceed it is **banked**: every eligible lead is inserted into `lead_bank` as `queued` for its target campaign (main, or the no-location sibling for city-less leads), with `source_job_id`; nothing is created in Instantly. Duplicates within the push, leads already in the bank for that campaign and leads a previous push created in Instantly (`instantly_pushed_emails()`) are filtered with a reason. Rows become `validation_rows.instantly_status = 'banked'`; the job gets `instantly_route = 'bank'`, `instantly_banked`, and ends `done` like a direct push. The route is decided once and kept across self re-invokes. Preview returns `route`, `banked_estimate`, `bank_threshold`.
- `instantly-rotate` serves `ROTATE_CAMPAIGN_ID` (always) plus every campaign with queued / active / replied bank rows (`lead_bank_rotation_campaigns()`). The cap is workspace-wide (everything Instantly lists counts); free slots (≤ `ROTATE_MAX_PUSH`) go to the oldest queued rows first by `lead_bank.id`, across campaigns, each into its own campaign (`allocate.ts`). Non-primary campaigns only archive / delete leads the bank knows. A campaign whose first 5 pushes in a run all fail is skipped for that run and its slots go to the next oldest queue. One `rotation_runs` row per run (`campaign_id` = primary) with `campaign_ids` and a `per_campaign` breakdown; `lume_campaign_lead_sources()` reads it per campaign. `trim` stays primary-only.
- The owner's push tap authorises both the banking and the rotation of those leads; there is no tap per rotation run.

## Lead states

`queued` never pushed · `active` in Instantly, not finished · `completed` / `bounced` / `unsubscribed` / `skipped` archived and deleted from Instantly (status 3 / -1 / -2 / -3) · `replied` kept seven days after the first reply, then deleted.

## Modes

- `?mode=rotate` (default, what cron calls): archive finished leads, delete them, fill free slots from `queued` in id order with `skip_if_in_workspace: true`.
- `?mode=trim`: one-time cutover. Deletes never-contacted active leads until the workspace total is at or under the cap and resets them to `queued`. Run once before the Growth plan downgrade takes effect:

```
curl -X POST "https://rcfrumrbauwvyzfebxck.supabase.co/functions/v1/instantly-rotate?mode=trim" \
  -H "Authorization: Bearer <anon key>"
```

Every run writes one `rotation_runs` row with before / archived / deleted / pushed / after counts and an `errors` array. A `fatal:` entry means the function could not list leads, almost always a missing `INSTANTLY_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` secret.

## Secrets the function needs

`INSTANTLY_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (set as edge-function secrets), optional `ROTATE_CAMPAIGN_ID`, `ROTATE_CAP`.

## Deploy

From disk, never inline: `npx supabase functions deploy instantly-rotate --project-ref rcfrumrbauwvyzfebxck`. The GitHub Actions workflow `deploy-functions.yml` does the same on push to `main` once `SUPABASE_ACCESS_TOKEN` is set as a repository secret.

## Dashboard

Open `/dashboard/instantly-rotation.html` on the Vercel deployment (CRM login required) or the file itself in a browser; it reads `rotation_dashboard()` through PostgREST with the publishable key and polls every five minutes. Inside claude.ai the same page uses the Supabase connector instead. Only counts leave the database.
