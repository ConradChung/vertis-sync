-- Grok Bot operator layer (Phase G9 data): the owner's five verticals.
-- Idempotent by name. campaign_ids are explicit ids (Instantly campaign ids, or
-- lume_campaigns.external_id for non-Instantly senders), mapped only where the
-- campaign clearly belongs to the vertical:
--   gmail:recruiter                       "Recruiter · GTM engineers (Gmail)"   → Job search / GTM roles
--   04ca2257-5ea6-434e-bf62-f55add156914  "ZenPort Rerun" (also "Scaleport Rerun") → Kaspen / Zenport
--   869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d  "Scaleport - Fall Mega" (live rotation campaign;
--                                         Scaleport is the Zenport offer: same Instantly id
--                                         was named both, and its copy is the Zenport template) → Kaspen / Zenport
-- (muse:auto-apply "Muse auto-apply" → Job search / GTM roles in 20261027021253.)
-- Left unassigned for the owner:
-- ab55afe9-b632-4e8d-ac84-48873140c56e (old "Scaleport - Fall Mega", deleted in Instantly),
-- 9a244d14-eede-4e51-b603-0b1cd0449dc1 ("Scaleport - Fall Mega — No Location").
insert into lume_verticals (name, scopes, campaign_ids, is_default) values
  ('Job search / GTM roles',   array['orders','validation','campaign'], array['gmail:recruiter'], false),
  ('PM reactions',             array['campaign','validation'],          '{}',                     false),
  ('HNWI / wealth management', array['validation','campaign'],          '{}',                     false),
  ('Kaspen / Zenport',         array['orders','validation','campaign'],
     array['04ca2257-5ea6-434e-bf62-f55add156914','869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'],             true),
  ('Roofers',                  array['campaign'],                       '{}',                     false)
on conflict (name) do nothing;
