---
# Cold-email SOP — machine rules (read by lib/copy/sop.ts, linted by lib/copy/sopLint.ts).
# This file is the single source of truth: the agent's system prompt, the
# update_sequence lint gate and the PDF (cold-email-sop.Rmd) all read it.
#
# PLACEHOLDER: every value below is a starting placeholder. The owner replaces
# them with the real SOP, then sets `placeholder: false`. A malformed block
# (unknown key, wrong type, min > max, duplicate id) fails the tests, the
# build and every sequence edit loudly; linting is never skipped.
version: 1
placeholder: true # PLACEHOLDER: set to false once the owner's rules are in

# Case-insensitive, whole-word/phrase matches in subjects and bodies.
banned_phrases: # PLACEHOLDER
  - hope this finds you well
  - hope you're doing well
  - just checking in
  - just following up
  - touching base
  - circle back
  - quick question
  - i wanted to reach out
  - synergy
  - game-changer
  - revolutionary
  - cutting-edge
  - leverage
  - best-in-class

# Words per email body; a {{variable}} counts as one word.
word_count: # PLACEHOLDER
  step1: { min: 40, max: 120 }
  followup: { min: 15, max: 90 }

subject: # PLACEHOLDER
  casing: lowercase # lowercase | sentence | any
  max_words: 6
  # Words allowed to keep capitals in a subject (acronyms, brand names, "I").
  allowed_capitalized: [I, PMS, AI]

# Each proof point at most once per sequence thread (any step, any variant).
# Patterns are plain phrases (case-insensitive, whole words), not regexes.
proof_points: # PLACEHOLDER
  - id: example_case_study
    patterns: [PLACEHOLDER case study client, PLACEHOLDER case study]
  - id: example_metric
    patterns: [PLACEHOLDER 30% fewer after-hours calls]

# {{variables}} that count as personalization.
personalization_fields: [hook, city, door_count, pms, open_role, jurisdiction]
max_personalization_fields_per_email: 1

# Step 1 may not ask a yes/no question that requires a meeting.
step1_cta:
  forbid_yes_no_meeting: true
  meeting_words: # PLACEHOLDER
    - call
    - meeting
    - meet
    - demo
    - chat
    - hop on
    - jump on
    - zoom
    - calendar
    - 15 minutes
    - 15 mins

# One fallback sentence per field, used when a lead has no high-confidence value.
fallbacks: # PLACEHOLDER
  open_role: Teams your size usually feel after-hours maintenance calls before they hire for them.
  door_count: Portfolios like yours tend to outgrow a shared on-call phone fast.
  pms: Most of the managers we talk to want after-hours calls logged straight into their PMS.
  jurisdiction: Tenant-response rules keep tightening, and after-hours coverage is where gaps show first.
  generic: After-hours maintenance calls are where most property managers lose the most time.
---

<!-- OWNER PASTES SOP HERE. Everything below the front matter is placeholder prose. -->

> **PLACEHOLDER — owner pastes the cold-email SOP here.** Replace each section
> below with the real text. Keep the headings; the agent reads this prose on
> every run, and the PDF renders it as written.

## Voice

PLACEHOLDER. How we sound: plain, specific, peer-to-peer. Short sentences. No
hype words. Write like one operator emailing another.

## CTA rules

PLACEHOLDER. Step 1 asks for interest, not a meeting (no "open to a call?").
Later steps may offer a time once there is a reason to.

## Proof points

PLACEHOLDER. Which results and customers we may cite, with the exact wording.
Each proof point appears at most once in a sequence.

## Banned phrases

PLACEHOLDER. Why the list in the rules above exists, and what to write instead.

## Sequence structure

PLACEHOLDER. Number of steps, delays, what each step does, when to use A/B
variants, and when a follow-up stays in the same thread (empty subject).

## Fallback sentences

PLACEHOLDER. When a lead has no high-confidence value for a personalization
field, use that field's fallback sentence from the rules above. Never invent a
fact to fill the gap.
