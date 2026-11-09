-- New campaign from scratch (Lume Campaigns → New campaign): suggestions inferred from the leads.
-- Additive only.

-- 1. Keyword profile per tag (vertical): what the suggester matches lead titles / industries / keywords against.
alter table public.lume_verticals add column if not exists keywords text[] not null default '{}'::text[];

update public.lume_verticals set keywords = array[
  'property management', 'property manager', 'property managers', 'real estate', 'leasing', 'hoa', 'homeowners association',
  'apartments', 'apartment', 'multifamily', 'multi-family', 'doors', 'rental', 'rentals', 'landlord', 'tenant', 'residential management',
  'community association', 'realty', 'property'
] where name = 'Kaspen / Zenport' and keywords = '{}';

update public.lume_verticals set keywords = array[
  'hiring', 'account executive', 'sdr', 'bdr', 'gtm', 'go-to-market', 'recruiting', 'recruiter', 'talent acquisition',
  'sales development', 'revenue operations', 'revops', 'head of sales', 'vp sales', 'startup', 'saas', 'founder'
] where name = 'Job search / GTM roles' and keywords = '{}';

update public.lume_verticals set keywords = array[
  'wealth', 'wealth management', 'family office', 'insider', 'form 4', 'form 144', 'private equity', 'investment', 'investor',
  'financial advisor', 'ria', 'portfolio', 'asset management', 'liquidity', 'm&a', 'acquisition'
] where name = 'HNWI / wealth management' and keywords = '{}';

update public.lume_verticals set keywords = array[
  'roofing', 'roofer', 'roofers', 'roof', 'contractor', 'contractors', 'exteriors', 'gutters', 'siding', 'storm restoration'
] where name = 'Roofers' and keywords = '{}';

-- PM reactions is an influencer pipeline (its leads are reactors to PM posts): light on purpose.
update public.lume_verticals set keywords = array['reactions', 'influencer']
where name = 'PM reactions' and keywords = '{}';

-- 2. Templates belong to a tag (nullable; ranked first for that tag).
alter table public.campaign_templates add column if not exists vertical_id uuid null references public.lume_verticals(id) on delete set null;

update public.campaign_templates t set vertical_id = v.id
from public.lume_verticals v
where v.name = 'Kaspen / Zenport' and t.vertical_id is null and t.name ilike 'zenport%';

-- 3. The new_campaign pending action (create an Instantly campaign from scratch, as a draft).
alter table public.pending_actions drop constraint if exists pending_actions_kind_check;
alter table public.pending_actions add constraint pending_actions_kind_check check (kind = any (array[
  'push_to_instantly', 'launch_campaign', 'assign_leads', 'activate_rule', 'send_reply', 'pause_campaign', 'resume_campaign',
  'create_campaign', 'decide_gate', 'delete_rule', 'crm_close_deal', 'run_actor', 'update_sequence', 'issue_operator_key',
  'remove_leads', 'label_reply', 'influencer_run', 'influencer_reactions', 'stage_attachment', 'influencer_lookup',
  'influencer_approve', 'send_lead_list', 'delete_lead_list', 'remove_lead_rows', 'new_campaign'
]::text[]));

-- One awaiting new campaign per name (case-insensitive; payload.name_key is the lowercased name).
create unique index if not exists pending_actions_one_awaiting_new_campaign_idx
  on public.pending_actions (kind, (payload ->> 'name_key'))
  where status = 'awaiting' and kind = 'new_campaign';
