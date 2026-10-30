# Jurisdiction hooks: owner review (2026-10-30)

`{{jurisdiction_line}}` is now sent with every Instantly push (`instantly-push`
and `instantly-rotate`). It is the lead's jurisdiction hook when one matches,
otherwise the SOP fallback sentence ("Without a GM, the owner becomes the
middle manager." for Kaspen). It is never blank.

The `jurisdictions` table has 74 rows: 51 US (50 states + DC), 13 Canada, 8
Australia, England and Wales, and Dubai. Singapore has no row, so it always
gets the fallback. **Every row is `active = false`**, so until you activate
some, every lead gets the fallback.

## Hooks to review

These four rows were verified on 2026-10-30. Every other row has no hook.

| Row | compliance_name / authority | copy_hook |
|---|---|---|
| CA / British Columbia | Residential Tenancy Act / Residential Tenancy Branch | In BC, a landlord's notice to end tenancy must be on the approved RTB form, signed and dated, or it can fail at dispute. |
| CA / Ontario | Residential Tenancies Act, 2006 / Landlord and Tenant Board | In Ontario, a tenant without the standard lease can demand one in writing and withhold a month's rent if it isn't provided within 21 days. |
| GB / (all) "England and Wales" | Renters' Rights Act 2025 / none | In England, section 21 ended on 1 May 2026, so every possession claim now needs a ground and the paperwork to prove it. |
| AE / Dubai | Ejari tenancy registration / RERA | In Dubai, the Rental Disputes Centre expects an Ejari-registered lease before it hears a case, renewals included. |

### Notes on the facts

- **Renters' Rights Act:** Royal Assent was on 27 October 2025. Phase 1
  started on 1 May 2026: section 21 was abolished, tenancies became periodic
  and rent can rise only once a year. Any section 21 notice served before that
  date had to reach court by 31 July 2026. Phase 2 (the PRS database) starts
  from late 2026. Sources: the
  [gov.uk roadmap](https://www.gov.uk/government/publications/renters-rights-act-2025-implementation-roadmap)
  and the
  [gov.uk press release of 30 April 2026](https://www.gov.uk/government/news/historic-protections-for-renters-in-action-across-england).
- **The UK row covers Scotland and Wales too.** As briefed, it has
  `region = null`, so it matches every UK lead. But the Act applies to England
  only (Wales follows the Renting Homes (Wales) Act 2016). A Scottish or Welsh
  lead would get a sentence about England. Before you activate it, consider
  scoping it to England. Apollo's `State` for UK leads is usually "England":
  `update public.jurisdictions set region = 'England', jurisdiction = 'England' where country = 'GB' and region is null;`
- **BC:** RTA s. 52 lists what a notice must include. An arbitrator can still
  amend a defective notice, which is why the hook says "can fail".
- **Ontario:** RTA 2006 s. 12.1. If the landlord still hasn't provided the
  lease 30 days after the tenant started withholding rent, the tenant keeps
  that rent.
- **Dubai:** Every guide to filing a Rental Disputes Centre case lists the
  Ejari certificate. No official DLD page was retrieved, so the hook says
  "expects".

## Activate

Activate the four rows that have hooks (one statement, Supabase SQL editor):

```sql
update public.jurisdictions set active = true, updated_at = now() where copy_hook is not null;
```

Activating a row that has no hook changes nothing in the email, because it
still sends the fallback. Edit a hook first with
`update public.jurisdictions set copy_hook = '...' where country = 'CA' and region = 'Ontario';`.

## How the line is built

- **Resolver:** `supabase/functions/_shared/research/jurisdiction.ts`. A row
  matches only when the country is certain (a full name, ISO2 or common
  variant) and the row is country-wide or names the same region exactly.
  Otherwise the lead gets the fallback.
- **instantly-push:** reads Apollo's `Country`, then `Company Country`, and
  `State`, then `Company State`, from `row_data`. It loads the active rows once
  per push.
- **instantly-rotate:** uses `lead_bank.jurisdiction_line` when it is set.
  Otherwise it resolves `lead_bank.country` / `region` against the active rows
  at push time, so activating a row also covers leads that are already queued.
  Lume fills `country` / `region` when it queues leads.
- **Fallback sentences:** edge functions can't read `lume/sops/`, so the
  sentences also live in the resolver, keyed by each client's pinned campaign
  ids. Any other campaign gets the base SOP sentence.
  `lume/tests/copy/jurisdiction.test.ts` fails if the two copies drift apart.
- **Copy:** step 3 may use `{{jurisdiction_line}}` as its own sentence. It
  counts as that email's one personalization field. Add it through Lume's
  sequence editor; the live sequence of campaign C was not changed.
