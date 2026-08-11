-- Campaign templates + ETA fields.
--
-- Templates live in the database rather than in function code so a new one can
-- be added with an insert instead of a redeploy, and so the Telegram buttons
-- and the dashboard read the same source.
--
-- The seeded sequence is transcribed verbatim from
-- "Zenport Campaign Copy.docx": 3 subject variants on step 1 (3-day delay),
-- then two threaded follow-ups with an empty subject at 1-day delays. Body
-- lengths were checked against the live "Scaleport - R3" campaign, which was
-- built by hand from the same doc, and match exactly (562/472/675).

create table if not exists campaign_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  -- Instantly's campaign.sequences shape, applied verbatim via
  -- PATCH /api/v2/campaigns/{id}
  sequences jsonb not null,
  created_at timestamptz not null default now()
);

alter table campaign_templates enable row level security;

insert into campaign_templates (name, description, sequences)
values (
  'Zenport Campaign',
  '3-step owner-acquisition sequence: 3 subject variants, then two threaded follow-ups (3d, 1d).',
  '[{"steps": [{"type": "email", "delay": 3, "variants": [{"subject": "{{companyName}}  + new homeowner leads", "body": "<div>Hey {{firstName}},</div><div><br /></div><div>I’m curious, if I could hand you 50 qualified owner appointments this month with zero upfront cost, would you have the capacity to take them on?</div><div><br /></div><div>We’re looking for one partner in {{Operating Cities Copied}} to use our owner acquisition engine.</div><div><br /></div><div>We just helped one PM go from 35 to 800 doors in 18 months. If not, no worries at all!</div><div><br /></div><div>Frank, Co-Founder</div><div>ScalePortHQ.com | (ex-PM managing 800+ Doors at RefinityHomes.com)</div>"}, {"subject": "quick question about homeowner for {{companyName}}", "body": "<div>Hi {{firstName}},</div><div><br /></div><div>Found {{companyName}} on Zillow.</div><div><br /></div><div>Quick question: Are you guys still buying those shared leads from All Property Management (APM) for $75-150 a pop?</div><div><br /></div><div>I’m an ex-PM (800 doors) and I built an engine that generates exclusive homeowner leads 80% less than APM. I’m looking for exclusive partners in {{location}} interested in using the system to hand them 50 new homeowner leads, zero upfront setup fees.</div><div><br /></div><div>Once I partner with a firm in {{location}}, I close the territory to everyone else. Do you have the capacity to take those on, or should I reach out to another firm in the area?</div><div><br /></div><div>Frank, Co-Founder</div><div>ScalePortHQ.com | (ex-PM managing 800+ Doors at RefinityHomes.com)</div>"}, {"subject": "{{location}} homeowner growth plan for {{companyName}}", "body": "<div>Hey {{firstName}},</div><div><br /></div><div>I recently sold my property management business (800 doors) to Sutton Realty.</div><div><br /></div><div>I put together a Growth Plan that shows the exact systems we used to go from 1-3 doors a month to 20-30 new doors a month, without buying those $125 \"shared\" leads from All Property Management (APM).</div><div><br /></div><div>It covers the owner acquisition engine and the sales process we used to scale from 35 to 800+ properties.</div><div><br /></div><div>Want me to send our Blueprint PDF over?</div><div><br /></div><div>(Heads up: I only want to send this if you actually have the ops/capacity to take on new owners—this moves pretty fast once it’s turned on.)</div><div><br /></div><div>Frank, Co-Founder</div><div>ScalePortHQ.com | (ex-PM managing 800+ Doors at RefinityHomes.com)</div>"}]}, {"type": "email", "delay": 1, "variants": [{"subject": "", "body": "<div>Hey {{firstName}},</div><div><br /></div><div>Quick check before I move on.</div><div><br /></div><div>We recently helped a PM grow from 35 → 800 doors using owner appointments with a ~30% close rate.</div><div><br /></div><div>Should I:</div><div><br /></div><div>A) send a quick overview, or</div><div><br /></div><div>B) close this out?</div><div><br /></div><div>Frank, Co-Founder</div><div>ScalePortHQ.com | (ex-PM managing 800+ Doors at RefinityHomes.com)</div>"}]}, {"type": "email", "delay": 1, "variants": [{"subject": "", "body": "<div>Hey {{firstName}},</div><div><br /></div><div>Maybe for {{companyName}} it’s just not the right time — totally fair.</div><div><br /></div><div>We’ve been working with a small number of PMs to help them add doors by getting more qualified owner conversations, and it’s worked well (one recently went from 35 → 800 doors).</div><div><br /></div><div>If it makes sense to revisit later, I’m happy to circle back.If not, I’ll step aside and keep this on ice.</div><div><br /></div><div>Either way, appreciate you letting me know.</div><div><br /></div><div>Best,</div><div>Frank, Co-Founder</div><div>ScalePortHQ.com | (ex-PM managing 800+ Doors at RefinityHomes.com)</div>"}]}]}]'::jsonb
)
on conflict (name) do update
  set sequences = excluded.sequences,
      description = excluded.description;

-- Rolling ETA for the whole pipeline, refreshed as each stage learns its real
-- throughput rather than staying on the seeded estimate.
alter table validation_jobs
  add column if not exists eta_seconds int,
  add column if not exists eta_updated_at timestamptz;
