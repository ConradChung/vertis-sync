-- An explicit per-lead {{compliance_law}} is sent as stored, and copy never
-- writes "the" before the variable, so an override carries its own article.
comment on column public.lead_bank.compliance_law is 'Explicit {{compliance_law}} for this lead, sent as stored: a law name WITH its own article ("the RTA", "the Renters'' Rights Act", "Chapter 83"); copy never writes "the" before it. Null = resolved from jurisdictions at push time.';
