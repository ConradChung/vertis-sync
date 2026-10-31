---
# Kaspen client overlay (Instantly campaign "Zenport"). Extends the base SOP
# (sops/cold-email-sop.md): banned_phrases are added to the base list; every
# other key set here replaces the base's (object sections merge key by key).
# Source: the owner's Kaspen SOP, 2026-10-29.
version: 1
client: kaspen
name: Kaspen
placeholder: false
match:
  campaign_names: [kaspen, zenport] # case-insensitive "name contains"
  # Pinned Instantly campaign ids, so a rename never drops Kaspen to the base
  # SOP (looked up 2026-10-29 in project rcfrumrbauwvyzfebxck):
  campaign_ids:
    - 04ca2257-5ea6-434e-bf62-f55add156914 # campaigns: "ZenPort Rerun" (also recorded as "Scaleport Rerun"); in the Kaspen / Zenport vertical
    - 869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d # in the Kaspen / Zenport vertical (lume_verticals.campaign_ids)
    - bcf7a6d2-1302-47fc-ae77-9d2a760c91c1 # named as Kaspen's by the owner; not yet in campaigns / lume_campaigns
  vertical: Kaspen / Zenport # lume_verticals.name

banned_phrases:
  - I'd love to
  - reach out
  - solution
  - streamline
  - leverage
  - show you how we can
  - save you from
  - quick call
  - hop on
  - circle back
  - just checking in
  - any thoughts
  - I wanted to

no_exclamation: true

subject:
  casing: lowercase
  min_words: 2
  max_words: 4
  allowed_capitalized: []
  no_company: true # no {{company}} / {{companyName}}
  forbid: [kaspen]

word_count:
  step1: { min: 60, max: 90 }
  followup: { min: 1, max: 59 } # steps 2-4: under 60

# Each at most once per sequence, and never more than one per email (except the
# Miami pair below).
# Patterns are case-insensitive regular expressions.
proof_points:
  - id: frank_1000_doors # Frank runs ~1,000 doors in Vancouver and uses Kaspen himself
    patterns: ['\b1,?000[- ]doors?\b', '\b1k[- ]doors?\b', '\bthousand doors']
  - id: live_21k_units # live on 21,000 units
    patterns: ['\b21,?000 units', '\b21k units']
  - id: miami_98k # a 350-unit Miami portfolio saves $98k/year in payroll
    patterns: ['\$98k', '\$?98,000', '\b350[- ]units?\b', '\bMiami\b']
  - id: price_145 # first agent is $1.45 per door per month
    patterns: ['\$1\.45']
  - id: after_hours_dispatch # takes after-hours calls and dispatches the vendor; no night shift
    patterns: ['\bno night shift', '\bwithout a night shift', '\bdispatch(es|ing)? the vendor', '\btakes? (the )?after-hours calls?']
  - id: flags_misses # reviews the team's work and flags specific misses
    patterns: ['\bflags?\b[^.?!]{0,60}\bmiss', 'renewal with no notice', 'work order (left )?open (for )?5 days', '\bmissed inspection']
  - id: before_tenant # schedules the fix before the tenant complains
    patterns: ['\bbefore the tenant']
max_proof_points_per_email: 1
# Owner, 2026-10-29: the Miami payroll variant may cite the $98k case study and
# Frank's 1,000 doors together. Nothing else may join them.
allowed_proof_point_combos:
  - [miami_98k, frank_1000_doors]

only_in_step:
  Vancouver: [1]

# {{company}} and {{companyName}} are the same field; {{firstName}} is not personalization.
# {{compliance_law}} is the name of the lead's compliance law (or the fallback
# below), sent with every push and written inline after "the"; it counts as a
# personalization field.
personalization_fields: [company, city, door_count, pms, open_role, after_hours, review_signal, jurisdiction, compliance_law]
max_personalization_fields_per_email: 1

step1_cta:
  forbid_yes_no_meeting: true
  meeting_words: [a call, quick call, a meeting, meet, demo, a chat, hop on, jump on, zoom, calendar, screen share, show you]
  meeting_patterns: ['\b(10|15|20|30)[ -]?min(ute)?s?\b']

step_rules:
  "1":
    forbid: [show you, save you from]
  "3": # proactive/compliance angle: no door count, no Miami
    forbid_patterns:
      - pattern: '\bMiami\b'
        label: Miami
      # 98k / $98k / 98,000 / $98,000, not 198k
      - pattern: '(?<![\w.,])\$?98(?:k|,000)(?![\w,])'
        label: $98k
      - pattern: '\{\{\s*door_count\s*\}\}'
        label: '{{door_count}}'
      # a number, then up to two words, then doors/units: "350-unit", "350 rental units",
      # "1,000+ residential doors" (not the 7 in "24/7"). Bounded quantifiers keep it linear on hostile input.
      - pattern: '(?<![\d/])\b\d[\d,.]{0,12}k?\+?(?:[- ]\w{1,24}){0,2}?[- ](?:doors?|units?)\b'
        label: a door or unit count
      - pattern: '\b(?:a|one) thousand[- ](?:doors?|units?)\b'
        label: a door or unit count
  "4":
    forbid: [program, apply, application]
    require:
      - pattern: '\breply\s+(with\s+)?[''"‘“][\w-]+[''"’”]'
        label: a reply-word lead magnet (e.g. reply "rules")

signoff:
  "1": Frank Jing
  "2": Frank
  "3": Frank
  "4": Frank Jing

sequence: # warning only, never blocks
  steps: 4
  delays_days: [0, 3, 4, 5]
  step1_variants: 5

# The SOP says: no high-confidence value -> the generic fallback. Every field
# falls back to the same operator line (wording from the SOP's own diagnosis).
fallbacks:
  generic: Without a GM, the owner becomes the middle manager.
  open_role: Without a GM, the owner becomes the middle manager.
  door_count: Without a GM, the owner becomes the middle manager.
  pms: Without a GM, the owner becomes the middle manager.
  jurisdiction: Without a GM, the owner becomes the middle manager.
  # The same noun phrase for every client (not a sentence). Also in
  # supabase/functions/_shared/research/jurisdiction.ts; lume/tests/copy/jurisdiction.test.ts
  # keeps them equal.
  compliance_law: local landlord-tenant law
  after_hours: Without a GM, the owner becomes the middle manager.
  review_signal: Without a GM, the owner becomes the middle manager.
  city: Without a GM, the owner becomes the middle manager.
  company: Without a GM, the owner becomes the middle manager.
---

# Kaspen — cold-email SOP

Kaspen (kaspen.ai): AI agents that work inside property management software
(AppFolio, Buildium, Rent Manager, others) across leasing, maintenance and
finance. Sender: Frank Jing, who runs ~1,000 doors in Vancouver and built
Kaspen for his own portfolio. Targets: owners/operators of property management
companies in Canada, US, UK, UAE. Instantly campaign: Zenport.

## What happened in the first two iterations

- Sep 2026: ~544 sends from inboxes that had sat idle, no warm-up ramp. Almost
  no replies, not even auto-replies in week one: a deliverability failure; the
  copy was never really tested.
- Oct 2026: ~750 sends, 11 replies. Most were out-of-office. 2 interested
  leads, both immediately asked about price and did not book.

## Do not repeat these mistakes

Treat these as established. Do not relitigate them; fix them.

1. **The opener was about the sender.** Every variant began "I run about 1,000
   doors in Vancouver." That is how a rep introduces himself; it is not
   credibility. Credibility is saying something only an operator would say
   ("without a GM the owner becomes the middle manager", "the 2am phone"). The
   credential belongs in sentence two, as confirmation.
2. **The CTA undid the operator voice.** "Do you want me to show you how we can
   save you from being stuck in the operations?" is a yes/no that costs a
   meeting, uses demo language ("show you") and pitch verbs ("save you from").
   The 2 interested replies asking about price is the symptom: the ask was
   vague, so they reached for the only concrete thing, cost.
3. **Zero personalization.** Nothing in any email signalled "I picked you."
   Same template to a 150-door shop in Dubai and a 2,000-door firm in Texas.
4. **Repetition across the thread.** "1,000 doors in Vancouver" in steps 1 and
   3; "$98k / 350 units Miami" in three of six variants. By step 3 the prospect
   had read the same two numbers three times.
5. **Vague claims.** "Catches mistakes", "tells you what's on fire",
   "compliance is tracked too": none of these is an image. A specific miss
   ("a renewal with no notice sent") is.
6. **The "proactive" variant (V5) had no operator line and stacked two
   features**; it read as a feature list. It is cut.
7. **Step 4's "1:1 program you can apply to"** reads as a course funnel to a PM
   operator.
8. **Structural: this was spray-and-pray.** No trigger decided who got emailed
   or when. The copy fix helps, but the bigger lever is sending to accounts
   with a live signal (open maintenance/PM role, new market, review complaints);
   assume that signal data exists as enrichment fields.

## Voice

- Operator to operator. The first sentence is about their problem and could
  only be written by someone who has run a portfolio. Credential second.
- Keep "Vancouver" in step 1 only: it reads as a real operator to international
  recipients. Do not repeat it.
- Plain, short. No selling adjectives, no exclamation marks. Subjects
  lowercase, 2-4 words, no company name.
- Every claim concrete, with an example. 60-90 words in step 1; under 60 for
  steps 2-4.
- When a high-confidence field exists, the first sentence references it. One
  field per email, never stacked.
- Banned: "I'd love to", "reach out", "solution", "streamline", "leverage",
  "show you how we can", "save you from", "quick call", "hop on", "circle
  back", "just checking in", "any thoughts", "I wanted to".

## Proof points

Each at most once per sequence, never more than one per email. One exception:
the Miami payroll variant may pair the $98k case study with Frank's 1,000 doors.

- Frank runs ~1,000 doors in Vancouver and uses Kaspen himself.
- Live on 21,000 units.
- A 350-unit Miami portfolio saves $98k/year in payroll.
- First agent is $1.45 per door per month.
- Takes after-hours calls and dispatches the vendor; no night shift.
- Reviews the team's work and flags specific misses (renewal with no notice,
  work order open 5 days, missed inspection).
- Schedules the fix before the tenant complains.

## Enrichment fields

Per lead, each with a confidence flag. Use one only if high-confidence;
otherwise the generic fallback. Never guess.

`{{firstName}} {{company}} {{city}} {{door_count}} {{pms}} {{open_role}}
{{after_hours}} {{review_signal}} {{jurisdiction}}`

`{{company}}` is the same field as Instantly's `{{companyName}}`.

`{{compliance_law}}` is the name of the compliance law the lead's place
follows, sent with every push: the reviewed jurisdiction's short name (e.g.
"RTA") or full name (e.g. "Residential Tenancies Act, 2006") when its country
and state/province match an active jurisdiction (e.g. BC, Ontario, England,
Dubai), otherwise "local landlord-tenant law". It is never blank. Write it
inline after "the", never at the start of a sentence: "Keeping up with the
{{compliance_law}} is a job of its own." Never write `{{jurisdiction}}` bare in
copy: Instantly renders a missing variable as nothing.

## CTA rules

This is the part that failed, so follow it exactly.

- **Step 1:** one qualifying question, answerable in a sentence with no
  commitment, chosen so the answer hands us a specific demo offer. "Is
  maintenance or leasing the bigger fire right now?" / "Who takes the 2am call
  on your side?" / "Which part of ops still lands on your desk?" For the
  after-hours angle, the alternative is a soft asset ask: "want a 2-minute
  recording of it handling a real 2am call?"
- **Step 2:** the concrete demo offer, stated small, with a proposed day: "I'll
  show it taking one of your actual work orders from call to dispatched vendor.
  15 minutes, screen share. Tuesday?"
- **Step 3:** a different one-line question tied to that step's angle.
- **Step 4:** reply-word lead magnet only ("reply 'rules'"). No
  program/application line.

## Sequence structure

All steps in the same thread.

- **Step 1:** five variants: short-staffed, no general manager, after-hours,
  payroll case study, mistakes & compliance.
- **Step 2 (+3 days):** price contrast ($1.45/door vs a hire who goes home at
  5) + demo offer.
- **Step 3 (+4 days):** proactive/compliance angle. It may name the law
  inline, "keeping up with the {{compliance_law}}" (the lead's law, or "local
  landlord-tenant law" when there is none); it is the email's one
  personalization field. Never `{{jurisdiction}}` bare. No door count, no
  Miami.
- **Step 4 (+5 days):** last note, lead magnet.

Sign step 1 and step 4 "Frank Jing"; steps 2 and 3 "Frank".

## Fallback sentences

No high-confidence value for a field: use the generic fallback ("Without a GM,
the owner becomes the middle manager."). Never guess a value.

## Reply handling

For each likely answer to the step-1 question (maintenance / leasing / finance
/ "we're fine" / "how much?"), a two-sentence reply that makes the demo offer
concrete and proposes a time. For "how much?", answer the price in one line
AND make the demo offer in the next; never answer price alone.

## Test plan

- Which two angles to send first, and what to hold constant.
- The one metric that decides: positive reply rate, not open rate.
- Minimum sends per arm before reading the result.
- Deliverability precondition, met before any copy conclusion is drawn: warmed
  inboxes and ramped volume.

## Output, when drafting the sequence

For each email: subject, body, fields used, generic fallback sentence. Then the
reply scripts, then the test plan.
