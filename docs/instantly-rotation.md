# Instantly lead rotation

Keeps the "Scaleport - Fall Mega" campaign (`ab55afe9-b632-4e8d-ac84-48873140c56e`) under the 1,000 uploaded-contact cap of the Instantly Growth plan by deleting finished leads and pushing queued ones from a Supabase lead bank. Instantly's cap counts contacts stored at one time, active or paused, and deleting frees a slot within about five minutes, so rotation by deletion is valid.

## Pieces

| Piece | Where |
|---|---|
| `lead_bank`, `rotation_runs` | `supabase/migrations/20261008222655_instantly_lead_rotation.sql` |
| cron ticks `instantly-rotate-am` (13:00 UTC) and `instantly-rotate-pm` (01:00 UTC) | `supabase/migrations/20261008223419_instantly_rotation_schedule.sql` |
| `rotation_dashboard()` aggregate RPC, anon-callable | `supabase/migrations/*_rotation_dashboard_rpc.sql` |
| `instantly-rotate` edge function | `supabase/functions/instantly-rotate/index.ts` |
| Dashboard | `dashboard/instantly-rotation.html` and the claude.ai artifact |

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

Open `dashboard/instantly-rotation.html` in a browser; it reads `rotation_dashboard()` through PostgREST with the publishable key and polls every five minutes. Inside claude.ai the same page uses the Supabase connector instead. Only counts leave the database.
