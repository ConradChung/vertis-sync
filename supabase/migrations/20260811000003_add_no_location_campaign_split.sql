-- Leads whose operating city never resolved go to their own campaign.
--
-- Instantly rotates A/B variants across leads by its own algorithm, so a
-- single campaign cannot guarantee that a city-less lead avoids a
-- {{location}} subject line. A second campaign carrying only variant C --
-- whose subject has the {{location}} token removed, and whose body never
-- referenced a location variable in the first place -- is the only guarantee.
--
-- The "Zenport Campaign — No Location" template row is seeded separately
-- alongside the other campaign_templates rows.
alter table validation_jobs
  add column if not exists instantly_campaign_id_nolocation text,
  add column if not exists instantly_campaign_name_nolocation text,
  add column if not exists instantly_pushed_nolocation int not null default 0;
