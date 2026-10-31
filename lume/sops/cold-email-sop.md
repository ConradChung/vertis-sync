---
# Cold-email SOP, BASE — machine rules (read by lib/copy/sop.ts, linted by lib/copy/sopLint.ts).
# This file is the source of truth for general rules and generic fallbacks: the
# agent's system prompt, the update_sequence lint gate and the PDF
# (cold-email-sop.Rmd) all read it. Client overlays in sops/clients/<client>.md
# extend or override it for their campaigns (see sops/README.md).
#
# Owner's general playbook, 2026-10-29: generalized from the Kaspen SOP
# (sops/clients/kaspen.md), keeping the rules that hold for any client and
# leaving out Kaspen's proof points, sender, steps and angles. A malformed block
# (unknown key, wrong type, min > max, duplicate id) fails the tests, the build
# and every sequence edit loudly; linting is never skipped.
version: 1
# false: these rules BLOCK an edit for every campaign, with or without a client SOP.
placeholder: false

# Case-insensitive, whole-word/phrase matches in subjects and bodies.
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
  - just following up
  - touching base
  - any thoughts
  - I wanted to
  - hope this finds you well

no_exclamation: true

subject:
  casing: lowercase # lowercase | sentence | any
  min_words: 2
  max_words: 4
  allowed_capitalized: []
  no_company: true # no {{company}} / {{companyName}}

# Words per email body; a {{variable}} counts as one word.
word_count:
  step1: { min: 60, max: 90 }
  followup: { min: 1, max: 59 } # steps 2+: under 60

# Proof points are client-specific: each client SOP lists its own (each at most
# once per sequence thread). The base only caps how many one email may cite.
proof_points: []
max_proof_points_per_email: 1

# {{variables}} that count as personalization. {{company}} and {{companyName}}
# are the same field; {{firstName}} is not personalization.
# {{compliance_law}} is the NAME of the compliance law the lead's place follows
# ("Residential Tenancies Act, 2006"), or fallbacks.compliance_law. Always sent,
# never blank. Write it inline after "the": "keeping up with the {{compliance_law}}".
personalization_fields: [company, city, door_count, pms, open_role, after_hours, review_signal, jurisdiction, compliance_law, hook]
max_personalization_fields_per_email: 1

# Step 1 may not ask a yes/no question that requires a meeting: a sentence
# ending in "?" that contains a meeting word (whole words) or matches a
# meeting pattern (regex).
step1_cta:
  forbid_yes_no_meeting: true
  meeting_words: [a call, quick call, a meeting, meet, demo, a chat, hop on, jump on, zoom, calendar, screen share, show you]
  meeting_patterns: ['\b(10|15|20|30)[ -]?min(ute)?s?\b']

step_rules:
  "4": # the last note is a lead magnet, never a funnel
    forbid: [program, apply, application]

sequence: # warning only, never blocks
  steps: 4
  delays_days: [0, 3, 4, 5]
  step1_variants: 5

# Optional rules a client SOP usually sets:
#   proof_points: [{ id: snake_case, patterns: [<regex>] }]
#   allowed_proof_point_combos: [[id_a, id_b]]  may share one email past the cap
#   subject: { forbid: [brand name] }
#   only_in_step: { Vancouver: [1] }  a phrase allowed only in those steps
#   step_rules: { "3": { forbid_patterns: [{ pattern: <regex>, label: <text> }] },
#                 "4": { require: [{ pattern: <regex>, label: <text> }] } }
#   signoff: { "1": Full Name, "2": First }  the body's last line, per step

# Used when a lead has no high-confidence value for the field. Never guess a
# value. A client SOP should replace these with an operator line from its own
# diagnosis.
fallbacks:
  generic: Most owners end up as the middle manager of their own portfolio.
  open_role: Most owners end up as the middle manager of their own portfolio.
  door_count: Most owners end up as the middle manager of their own portfolio.
  pms: Most owners end up as the middle manager of their own portfolio.
  jurisdiction: Most owners end up as the middle manager of their own portfolio.
  # A noun phrase, not a sentence: it reads after "the" and without it. The same
  # for every client. Also in supabase/functions/_shared/research/jurisdiction.ts
  # (edge functions can't read this file); lume/tests/copy/jurisdiction.test.ts
  # keeps them equal.
  compliance_law: local landlord-tenant law
---

# Cold-email playbook (base)

The general rules for every client. Each client SOP (`sops/clients/<client>.md`)
adds its own proof points, sender, angles and sequence on top. Distilled from
the Kaspen iterations (Sep–Oct 2026), where the copy failed for the reasons
below.

## Mistakes we don't repeat

1. **The opener is never about the sender.** Credibility is saying something
   only an operator in the prospect's seat would say. The sender's credential
   goes in sentence two, as confirmation.
2. **The step-1 CTA never costs a meeting.** A yes/no ask for a call, a demo or
   "let me show you" undoes the operator voice, and prospects reach for the only
   concrete thing left: price.
3. **No email goes out without a reason we picked this prospect.** Lead with a
   high-confidence fact about them, or the operator line; never one template
   for every size and market.
4. **Nothing repeats across the thread.** Each proof point appears at most once
   in a sequence.
5. **No vague claims.** "Catches mistakes" is not an image; "a renewal with no
   notice sent" is. Every claim is concrete, with an example.
6. **No feature lists.** One idea per email, carried by an operator line.
7. **The last note is never a program, an application or a course funnel.**
8. **Send on a signal, not a spray.** The bigger lever is who gets emailed and
   when: accounts with a live signal (open role, new market, growth).

## Voice

- Operator to operator. The first sentence is about their problem and could
  only be written by someone who has done the job. Credential second.
- Plain and short. No selling adjectives, no exclamation marks.
- Subjects: lowercase, 2–4 words, never the company name.
- Step 1: 60–90 words. Follow-ups: under 60.
- When a high-confidence field exists, the first sentence references it. One
  personalization field per email, never stacked.
- Banned phrases are listed in the rules above; write the plain version
  instead ("I built X", not "I'd love to show you how we can").

## Proof points

Client-specific; each client SOP lists them with exact wording. At most one per
email (a client SOP may allow a named pair) and each at most once per sequence.

## CTA rules

- **Step 1:** one qualifying question, answerable in a sentence with no
  commitment, chosen so the answer hands us a specific offer ("Which part of
  ops still lands on your desk?"). A soft asset ask ("want a 2-minute
  recording of it?") is the alternative.
- **Step 2:** the concrete offer, stated small, with a proposed day.
- **Step 3:** a different one-line question tied to that step's angle.
- **Step 4:** reply-word lead magnet only (reply "rules"). No program or
  application line.

## Sequence structure

Four steps in one thread (empty follow-up subjects): day 0, +3, +4, +5. Five
step-1 variants, one per angle. Each later step takes a new angle and a proof
point not used before.

## Fallback sentences

No high-confidence value for a field: use the fallback sentence. Never guess a
value and never invent a fact to fill the gap.

`{{compliance_law}}` needs no fallback sentence: it is the name of the
compliance law the lead's place follows (the reviewed jurisdiction's short
name, e.g. "RTA", else its full name, e.g. "Residential Tenancies Act, 2006"),
or `fallbacks.compliance_law` ("local landlord-tenant law"), so it is never
blank. Use it inline, always after "the" and never at the start of a sentence:
"Keeping up with the {{compliance_law}} is a job of its own." Never write
`{{jurisdiction}}` bare in copy: Instantly renders a missing variable as
nothing.
