-- Influencer candidates live as sheets in Leads. Each influencer_candidate_batches
-- row gets one lead list (lead_review_sets, kind 'list', sheet_kind
-- 'influencer_candidates') that points at it; the Leads page renders the
-- batch's influencer_candidates inside that sheet. The lookup engine
-- (influencer-lookup, grounding, cap, lease) keeps reading and writing
-- influencer_candidates unchanged: the sheet is a link, not a copy, so nothing
-- has to be kept in sync. The sheet sits in the batch chat's project folder,
-- else the Leads page's Influencers folder. Additive.
alter table public.lead_review_sets
  add column if not exists sheet_kind text not null default 'leads' check (sheet_kind in ('leads', 'influencer_candidates')),
  add column if not exists influencer_batch_id uuid unique references public.influencer_candidate_batches(id) on delete cascade;

-- One sheet for every existing batch (the live c3a7b8cc… included).
insert into public.lead_review_sets (kind, sheet_kind, influencer_batch_id, title, source_kind, source_id, source_conversation_id, project_id, created_by, item_count, created_at, updated_at, content_changed_at)
select 'list', 'influencer_candidates', b.id, b.name, 'list', 'influencers', b.conversation_id, c.project_id, 'agent',
       (select count(*) from public.influencer_candidates x where x.batch_id = b.id), b.created_at, b.updated_at, b.updated_at
from public.influencer_candidate_batches b
left join public.agent_conversations c on c.id = b.conversation_id
where not exists (select 1 from public.lead_review_sets s where s.influencer_batch_id = b.id);
