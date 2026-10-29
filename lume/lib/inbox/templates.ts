import { NAME_MAX } from '@/lib/agent/projectModel'

/**
 * The Inbox project template (inbox manager 3d): the five memory files of
 * the SOP (`~/Downloads/inbox-manager-appointment-setter-sop.md` §10.4),
 * seeded as project notes with the SOP's `{{placeholders}}` left for the
 * owner to fill. The Inbox Manager Grok Bot reads them through
 * GET /api/inbox/files and appends rules through POST /api/inbox/files/rule;
 * Lume's own agent reads the same project. Pure.
 */

const SUFFIX = ' · Inbox'

/** `<vertical> · Inbox`, cut to the project name limit. */
export function inboxProjectName(verticalName: string): string {
  const base = verticalName.trim().slice(0, NAME_MAX - SUFFIX.length).trim()
  return `${base}${SUFFIX}`
}

const QUALIFY_RULES = `# qualify-rules.md

> Who is worth a call. The Inbox Manager scores every new human reply GOOD / UNSURE / BAD against this file and the offer in settings.md.
> Every skip or "don't book people like this" becomes a one-line rule at the bottom (POST /api/inbox/files/rule).

## Fit criteria

{{fit criteria}}

## Verdicts

| Verdict | Meaning | Action |
|---|---|---|
| GOOD | Clearly matches the fit criteria | Reply and work toward a booking |
| UNSURE | Fit is unclear | Follow the UNSURE rule below |
| BAD | Clearly fails the criteria or is on the skip list | No reply. Block if appropriate. Log the reason |

## UNSURE rule

{{UNSURE rule}}

## Skip list

- Anyone who asked to be removed or was hostile
- Competitors

## No-shows

(Block, retry or ignore: your call. Write it here.)

## Skip log

One line per skipped lead:

\`\`\`
{{date}} | {{company}} | {{domain}} | BAD | one-sentence reason | blocked: yes/no
\`\`\`

## Rules learned
`

const VOICE_SAMPLES = `# voice-samples.md

> 3 to 5 of {{sender name}}'s own past replies to leads, pasted as they were sent. The style reference for every draft.
> Write as {{sender name}}, never as the bot. Always use the lead's real name, never an unfilled merge variable.

## Sample 1

{{past reply 1}}

## Sample 2

{{past reply 2}}

## Sample 3

{{past reply 3}}
`

const VOICE_RULES = `# voice-rules.md

> Starts empty. Grows from your edits: length, tone, sign-off, words you never use.
> Every correction to a draft becomes one line here (POST /api/inbox/files/rule). If two rules conflict, the newer one wins until you say otherwise.
`

const REPLY_TEMPLATES = `# reply-templates.md

> Structure only (SOP §6.3). Each reply: acknowledge, answer, propose the next step. Fill the content in {{sender name}}'s voice and vary the wording so replies do not look canned.

## Interested / question / more info

\`\`\`
{{greeting}} {{first name}},

{{acknowledge}}
{{their question}} -> {{answer}}   (skip if no question)
{{optional link}}

{{next step}}, e.g. propose {{times}}

{{sign-off}}
\`\`\`

## Named a time / booking confirmation

\`\`\`
{{greeting}} {{first name}},

{{confirm: day, date, time, time zone}}
{{what happens next, e.g. invite on its way}}

{{sign-off}}
\`\`\`

## Not now

\`\`\`
{{acknowledge}}
{{ask when to reconnect}}
\`\`\`

## Referral

\`\`\`
{{thank the referrer}}
{{greet the new person}} {{one line of context}}
propose {{times}}
\`\`\`

## Wrong person

\`\`\`
{{acknowledge}}
{{ask who the right person is}}
\`\`\`

## Reschedule

\`\`\`
{{acknowledge}}
{{confirm the new time}} or propose {{times}}
\`\`\`

## Follow-up

\`\`\`
{{short nudge}}
fresh {{times}} or {{a simple yes/no question}}
\`\`\`

## Rules learned
`

const SETTINGS = `# settings.md

> The Inbox Manager's settings (SOP settings table). Fill every placeholder before the bot goes live.

| Setting | Value |
|---|---|
| Sender name (signs replies) | {{sender name}} |
| Business name | {{business name}} |
| Offer (one sentence: what the cold email actually offered) | {{offer}} |
| Scheduling tool and first-call event type | {{scheduling tool}} |
| Calendar (conflict cross-check) | {{calendar}} |
| Meeting length | {{meeting length}} |
| Time offer rule | {{time offer rule}} |
| Follow-up plan | {{follow-up plan}} |
| After follow-ups | {{after follow-ups}} |
| Home time zone | {{home time zone}} |
| Optional link (blank if none) | {{optional link}} |
| CRM | Lume CRM (bookings via POST /api/inbox/booking) |

## Times never to offer

{{times never to offer}}
`

export interface NoteTemplate {
  name: string
  content: string
}

export const INBOX_NOTE_TEMPLATES: readonly NoteTemplate[] = [
  { name: 'qualify-rules.md', content: QUALIFY_RULES },
  { name: 'voice-samples.md', content: VOICE_SAMPLES },
  { name: 'voice-rules.md', content: VOICE_RULES },
  { name: 'reply-templates.md', content: REPLY_TEMPLATES },
  { name: 'settings.md', content: SETTINGS },
]

export const INBOX_NOTE_NAMES = INBOX_NOTE_TEMPLATES.map((t) => t.name)

/** The templates whose name is not already an item of the project (name match ignores case). Never overwrites. */
export function notesToSeed(existing: readonly { name: string }[]): NoteTemplate[] {
  const have = new Set(existing.map((i) => i.name.trim().toLowerCase()))
  return INBOX_NOTE_TEMPLATES.filter((t) => !have.has(t.name.toLowerCase()))
}
