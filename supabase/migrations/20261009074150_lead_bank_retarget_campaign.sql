-- Applied 2026-10-09 via the Supabase MCP (version 20261009074150). Tracked here so the repo matches the DB.
-- The Instantly campaign ab55afe9-... was deleted when the workspace moved to the Growth plan (2026-10-08)
-- and recreated empty as 869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d. Point the bank at the new campaign and drop
-- the stale Instantly lead ids, which belonged to the deleted campaign.
update public.lead_bank
   set campaign_id = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d',
       instantly_lead_id = null,
       updated_at = now()
 where campaign_id = 'ab55afe9-b632-4e8d-ac84-48873140c56e';
