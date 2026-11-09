-- 'acquisition' in the HNWI keywords matched "Head of Talent Acquisition" titles; keep the M&A sense only.
update public.lume_verticals
set keywords = array_replace(keywords, 'acquisition', 'business acquisition')
where name = 'HNWI / wealth management' and 'acquisition' = any(keywords);
