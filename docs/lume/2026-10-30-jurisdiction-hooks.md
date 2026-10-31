# Compliance law variable: owner review (2026-10-30, revised)

`{{compliance_law}}` is sent with every Instantly push (`instantly-push` and
`instantly-rotate`). It replaces `{{jurisdiction_line}}`, which was a hook
sentence. It is now just the **name** of the compliance law the lead's place
must follow:

| Lead in | `{{compliance_law}}` |
|---|---|
| Ontario (row active, short name set) | the RTA |
| Florida (row active, short name set) | Chapter 83 |
| Ontario (row active, no short name) | the Residential Tenancies Act, 2006 |
| no active row with a name, or uncertain country / region | local landlord-tenant law |

It is never blank. The fallback is one generic noun phrase, the same for
every client. There are no per-campaign fallback sentences any more.

## Writing it in copy

The value carries its own article, so copy writes the variable bare,
mid-sentence, never at the start of a sentence:

> Keeping up with {{compliance_law}} is a job of its own.

This reads correctly for every value: "the RTA", "the Renters' Rights Act",
"Chapter 83", "AB 1482", and the fallback "local landlord-tenant law". Some
names take an article and some don't, and only the stored value knows which.
So `short_name` and `compliance_name` are stored with their article
("the RTA"), and the resolver sends them as stored (trimmed).

The SOP linter blocks "the {{compliance_law}}" (any case) in a subject or
body. Its message says that the value already carries its article; the text
would otherwise render "the the RTA". It still blocks a bare
`{{jurisdiction}}`, now with "use {{compliance_law}}".
`{{compliance_law}}` counts as that email's one personalization field.

## What decides the value

`supabase/functions/_shared/research/jurisdiction.ts`, used by both pushes:

1. **Match.** A `jurisdictions` row matches only when the lead's country is
   certain (a full name, ISO2 or common variant) and the row is country-wide
   or names the same region exactly. A region row beats a country-wide one.
   City-scoped rows never match. These rules are unchanged.
2. **Activation.** Only rows with `active = true` **and** a non-null
   `compliance_name` take part. A `short_name` alone activates nothing.
   `copy_hook` is no longer read; the column stays in place and is marked
   deprecated.
3. **Value.** The matched row's `short_name` (operator shorthand with its
   article: "the RTA", "Chapter 83", "AB 1482") when set, else its
   `compliance_name`, else "local landlord-tenant law" (no article).

The fallback also lives in `lume/sops` as `fallbacks.compliance_law` (base and
every client). Edge functions can't read the SOP files, so
`lume/tests/copy/jurisdiction.test.ts` fails if the two copies differ.

## The table today

74 rows: 51 US (50 states + DC), 13 Canada, 8 Australia, England, and Dubai.
Singapore has no row, so it always gets the fallback. **Every row is
`active = false`**, and 4 rows have a `compliance_name` (seeded without an
article; reload them with it, e.g. "the Residential Tenancy Act", before
activating):

| Row | compliance_name |
|---|---|
| CA / British Columbia | Residential Tenancy Act |
| CA / Ontario | Residential Tenancies Act, 2006 |
| GB / England | Renters' Rights Act 2025 |
| AE / Dubai | Ejari tenancy registration |

A research agent is filling `compliance_name` for the rest. `short_name`
(migration `20261031004306_lume_jurisdictions_short_name`) is empty; its
values are loaded separately.

The UK row is England only: the Renters' Rights Act applies to England.
Wales, Scotland and Northern Ireland have their own law. An exact `State` of
"England", "Greater London", "London" or a common English county or city maps
to England. Anything else gets the fallback.

## Activate

Once a row's names are reviewed:

```sql
update public.jurisdictions set active = true, updated_at = now()
 where compliance_name is not null
   and (country, region) in (('CA', 'British Columbia'), ('CA', 'Ontario'), ('GB', 'England'), ('AE', 'Dubai'));
-- optional shorthand, with its article, sent instead of the full name:
update public.jurisdictions set short_name = 'the RTA' where country = 'CA' and region = 'Ontario';
```

Activating a row with no `compliance_name` changes nothing: it is still no
match, and the lead gets the fallback.

## The pushes

- **instantly-push:** reads Apollo's `Country`, then `Company Country`, and
  `State`, then `Company State`, from `row_data`. It loads the active, named
  rows once per push. The value no longer depends on the target campaign. If
  Instantly doesn't echo `compliance_law` on the first lead, the push
  continues: the warning is logged and recorded on that row's
  `instantly_result` and in the completion report. Missing location variables
  still stop the push, as before.
- **instantly-rotate:** uses `lead_bank.compliance_law` when it is set (an
  explicit per-lead law name, normally null). Otherwise it resolves
  `lead_bank.country` / `region` against the active rows at push time, so
  activating a row also covers leads that are already queued. Lume fills
  `country` / `region` when it queues leads.

## Migration and deploy notes

- `20261031004055_lume_lead_bank_compliance_law` renamed
  `lead_bank.jurisdiction_line` to `compliance_law` and recreated
  `lume_lead_bank` with `compliance_law`. Both also keep a deprecated
  `jurisdiction_line` that is always null, because the Lume in production
  still reads and inserts that name. After the next Lume deploy, a follow-up
  migration should drop the deprecated column from the view and the table.
- The edge functions running now still send `jurisdiction_line` until
  `instantly-push` / `instantly-rotate` are redeployed (push to `main`).
  Sequences should switch from `{{jurisdiction_line}}` to
  `{{compliance_law}}` at that deploy.
