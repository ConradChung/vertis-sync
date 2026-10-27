-- Grok Bot operator layer (G9 data, follow-up): "Muse auto-apply" belongs to
-- Job search / GTM roles. Idempotent: appended only when not already present.
update public.lume_verticals
   set campaign_ids = array_append(campaign_ids, 'muse:auto-apply')
 where name = 'Job search / GTM roles'
   and not ('muse:auto-apply' = any(campaign_ids));
