-- Review fixes on lume_jurisdictions_seed (20261030101145, already applied).
--
-- 1. UK: the Renters' Rights Act 2025 applies to England only (Wales: Renting
--    Homes (Wales) Act 2016; Scotland and Northern Ireland have their own law).
--    A country-wide GB row would hand an England-only sentence to every UK
--    lead, so the row becomes region 'England', jurisdiction 'England'. The
--    resolver maps "England" and common English counties/cities ("Greater
--    London", "London", ...) to 'England'; Scotland, Wales, NI and unknown
--    values get the fallback.
-- 2. Dubai: drop the unsourced "renewals included" from the hook.
--
-- Still inactive: the owner reviews and activates.

update public.jurisdictions
   set region = 'England', jurisdiction = 'England', updated_at = now()
 where country = 'GB' and region is null and city_match is null and jurisdiction = 'England and Wales';

update public.jurisdictions
   set copy_hook = 'In Dubai, the Rental Disputes Centre expects an Ejari-registered lease before it hears a case.',
       updated_at = now()
 where country = 'AE' and region = 'Dubai' and city_match is null;
