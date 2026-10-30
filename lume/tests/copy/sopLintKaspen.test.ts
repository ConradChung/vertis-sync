import { describe, expect, it } from 'vitest'
import { findClient, loadSopLibrary } from '@/lib/copy/sop'
import { isBlocking, lintSequence, type LintStep } from '@/lib/copy/sopLint'

// The committed Kaspen overlay merged onto the committed base: what the gate applies to "Zenport".
const RULES = findClient(loadSopLibrary(), 'kaspen')!.rules

const v = (subject: string, body: string) => ({ subject, body })

/** A Kaspen sequence written to the SOP: 5 step-1 angles, then price + demo, compliance, lead magnet. */
function zenport(): LintStep[] {
  return [
    {
      delay: 0,
      variants: [
        v(
          'the open role',
          "Hi {{firstName}},\n\nSaw you're hiring a {{open_role}}. Until that seat is filled, the 2am phone usually lands on whoever owns the place.\n\nI run about 1,000 doors in Vancouver and hit the same wall, so I built Kaspen to sit inside the property management software and take that load: maintenance intake, leasing follow-ups, the finance busywork.\n\nWhich part of ops still lands on your desk?\n\nFrank Jing"
        ),
        v(
          'no general manager',
          'Hi {{firstName}},\n\nWithout a GM, the owner becomes the middle manager: every late rent call, every vendor quote, every lease question ends up with you.\n\nI run about 1,000 doors in Vancouver and was that middle manager for years. Kaspen works inside AppFolio, Buildium or Rent Manager and handles the leasing, maintenance and finance work a GM would have taken.\n\nIs maintenance or leasing the bigger fire right now?\n\nFrank Jing'
        ),
        v(
          'the 2am phone',
          'Hi {{firstName}},\n\nSomeone on your team still sleeps next to the 2am phone, and the vendor gets called by whoever wakes up first and finds the voicemail.\n\nI run about 1,000 doors in Vancouver. Kaspen answers those calls inside your property management software, logs the work order and lines up the right vendor, so nobody on your side has to babysit the line overnight.\n\nWant a 2-minute recording of it handling a real 2am call?\n\nFrank Jing'
        ),
        v(
          'payroll math',
          'Hi {{firstName}},\n\nMost portfolios add a coordinator every time the door count jumps, and payroll ends up growing faster than rent does.\n\nA 350-unit portfolio in Miami cut $98k a year in payroll after putting Kaspen inside their property management software for maintenance intake and leasing follow-ups. I built it for my own buildings in Vancouver first.\n\nWhich role on your team would you rather not hire twice?\n\nFrank Jing'
        ),
        v(
          'what slipped last month',
          'Hi {{firstName}},\n\nThe misses that hurt are rarely big ones: a renewal with no notice sent, a work order nobody closed, an inspection that never got booked.\n\nKaspen reviews the work your team does inside the property management software and names each of those before it costs you. I built it for my own portfolio in Vancouver, where those were the misses that kept me up.\n\nWhich of those would surface late on your side?\n\nFrank Jing'
        ),
      ],
    },
    {
      delay: 3,
      delay_unit: 'days',
      variants: [
        v(
          '',
          "Hi {{firstName}},\n\nThe first agent is $1.45 per door per month. A coordinator costs more and goes home at 5.\n\nI'll show it taking one of your actual work orders from call to dispatched vendor. 15 minutes, screen share. Tuesday?\n\nFrank"
        ),
      ],
    },
    {
      delay: 4,
      delay_unit: 'days',
      variants: [
        v(
          '',
          '{{firstName}}, one more angle.\n\nKaspen schedules the fix before the tenant complains: the smoke alarm check due next week gets booked now, not after the angry email.\n\nWho on your side tracks those dates today?\n\nFrank'
        ),
      ],
    },
    {
      delay: 5,
      delay_unit: 'days',
      variants: [
        v(
          '',
          'Last note from me, {{firstName}}.\n\nI wrote down the rules we run Kaspen on in my own portfolio: what it handles alone, what it hands to a person, what it never touches.\n\nReply "rules" and I\'ll send them over.\n\nFrank Jing'
        ),
      ],
    },
  ]
}

const only = (s: LintStep[]) => lintSequence(s, RULES).map((x) => [x.rule, x.step, x.variant])

describe('Kaspen SOP lint', () => {
  it('passes a sequence written to the SOP', () => {
    expect(lintSequence(zenport(), RULES)).toEqual([])
  })

  it('fails the old step-1 CTA from the diagnosis on every count', () => {
    const s = zenport()
    s[0].variants[1].body = s[0].variants[1].body.replace(
      'Is maintenance or leasing the bigger fire right now?',
      'Do you want me to show you how we can save you from being stuck in the operations?'
    )
    const rules = new Set(lintSequence(s, RULES).map((x) => x.rule))
    expect([...rules].sort()).toEqual(['banned_phrase', 'step1_meeting_cta', 'step_forbid'])
  })

  it('max_proof_points_per_email: two proof points in one email', () => {
    const s = zenport()
    s[0].variants[0].body = s[0].variants[0].body.replace('Vancouver and', 'Vancouver, live on 21,000 units now, and')
    expect(only(s)).toEqual([['proof_points_per_email', 1, 'A']])
  })

  it('proof_point_repeat: a proof point from step 1 again in step 3', () => {
    const s = zenport()
    s[2].variants[0].body = s[2].variants[0].body.replace('schedules the fix before the tenant complains', 'runs the same way on my 1,000 doors')
    // Step 3 also bans door counts outright.
    expect(only(s)).toEqual([
      ['proof_point_repeat', 3, 'A'],
      ['step_forbid', 3, 'A'],
    ])
  })

  it.each(['1,000 doors', '1000 doors', '1k doors', '1,000-door', '1000-door', 'a thousand doors'])(
    'frank_1000_doors recognises "%s" (repeated in step 4)',
    (phrase) => {
      const s = zenport()
      s[3].variants[0].body = s[3].variants[0].body.replace('in my own portfolio', `in my own ${phrase} portfolio`)
      expect(only(s)).toEqual([['proof_point_repeat', 4, 'A']])
    }
  )

  it('only_in_step: "Vancouver" after step 1', () => {
    const s = zenport()
    s[1].variants[0].body = s[1].variants[0].body.replace('goes home at 5.', 'goes home at 5, even in Vancouver.')
    expect(only(s)).toEqual([['only_in_step', 2, 'A']])
  })

  it('no_exclamation: a "!" in a body or subject', () => {
    const s = zenport()
    s[2].variants[0].body = s[2].variants[0].body.replace('one more angle.', 'one more angle!')
    s[0].variants[2].subject = 'the 2am phone!'
    expect(only(s)).toEqual([
      ['no_exclamation', 1, 'C'],
      ['no_exclamation', 3, 'A'],
    ])
  })

  it('subject_content: {{companyName}} / {{company}} or "kaspen" in a subject', () => {
    const s = zenport()
    s[0].variants[1].subject = '{{companyName}} without a gm'
    s[0].variants[2].subject = 'kaspen at 2am'
    expect(only(s)).toEqual([
      ['subject_content', 1, 'B'],
      ['subject_content', 1, 'C'],
    ])
  })

  it('subject_length: under 2 or over 4 words', () => {
    const s = zenport()
    s[0].variants[0].subject = 'hiring'
    s[0].variants[1].subject = 'no general manager this year'
    expect(only(s)).toEqual([
      ['subject_length', 1, 'A'],
      ['subject_length', 1, 'B'],
    ])
  })

  it('personalization: {{companyName}} is the same field as {{company}}; {{firstName}} does not count', () => {
    const s = zenport()
    s[0].variants[0].body = s[0].variants[0].body.replace('whoever owns the place', 'whoever owns {{companyName}}')
    expect(only(s)).toEqual([['personalization_fields', 1, 'A']])
    const t = zenport()
    t[0].variants[1].body = t[0].variants[1].body.replace('ends up with you', 'ends up with you at {{company}}, {{companyName}}')
    expect(lintSequence(t, RULES)).toEqual([])
  })

  it('step_rules: step 4 forbids program/apply/application and requires a reply-word magnet', () => {
    const s = zenport()
    s[3].variants[0].body = s[3].variants[0].body.replace('Reply "rules" and I\'ll send them over.', 'Reply "rules" to apply for the program.')
    expect(only(s)).toEqual([
      ['step_forbid', 4, 'A'],
      ['step_forbid', 4, 'A'],
    ])
    const t = zenport()
    t[3].variants[0].body = t[3].variants[0].body.replace('Reply "rules" and I\'ll send them over.', 'Let me know if you want them.')
    expect(only(t)).toEqual([['step_require', 4, 'A']])
  })

  it.each([
    ['the Miami portfolio', 'Miami'],
    ['a $98k payroll saving', '$98k'],
    ['your {{door_count}} doors', '{{door_count}}'],
    ['a 350-unit portfolio', 'a door or unit count'],
    ['my 1,000 doors', 'a door or unit count'],
    ['all 21,000 units we run', 'a door or unit count'],
    ['350 rental units', 'a door or unit count'],
    ['1,000+ residential doors', 'a door or unit count'],
    ['a thousand doors', 'a door or unit count'],
    ['one thousand units', 'a door or unit count'],
    ['a 98k payroll saving', '$98k'],
    ['$98,000 a year', '$98k'],
  ])('step 3 forbids a door count and Miami: "%s"', (phrase, label) => {
    const s = zenport()
    s[2].variants[0].body = s[2].variants[0].body.replace('one more angle.', `one more angle, seen across ${phrase}.`)
    const out = lintSequence(s, RULES).filter((x) => x.rule === 'step_forbid')
    expect(out).toEqual([expect.objectContaining({ rule: 'step_forbid', step: 3, variant: 'A', message: `step 3 may not use ${label}` })])
  })

  it.each([
    ['5 days late', ''],
    ['198k in rent', ''],
    ['2 thousand calls', ''],
  ])('step 3 leaves non-counts alone: "%s"', (phrase) => {
    const s = zenport()
    s[2].variants[0].body = s[2].variants[0].body.replace('one more angle.', `one more angle, ${phrase}.`)
    expect(lintSequence(s, RULES)).toEqual([])
  })

  it('step 3 count patterns stay linear on long adversarial input', () => {
    const inputs = ['1,'.repeat(9_000), '1 ' + 'a'.repeat(18_000), '1 a '.repeat(4_500), '98'.repeat(9_000), 'a thousand '.repeat(1_600)]
    for (const junk of inputs) {
      const s = zenport()
      s[2].variants[0].body = `${junk}\n\nFrank`
      const t = performance.now()
      lintSequence(s, RULES)
      expect(performance.now() - t).toBeLessThan(500)
    }
  })

  it('the step-3 ban leaves door counts alone elsewhere (21,000 units in step 4 passes)', () => {
    const s = zenport()
    s[3].variants[0].body = s[3].variants[0].body.replace('in my own portfolio', 'across the 21,000 units it runs on')
    expect(lintSequence(s, RULES)).toEqual([])
  })

  it('step_rules: step 1 forbids "show you" even outside a question', () => {
    const s = zenport()
    s[0].variants[2].body = s[0].variants[2].body.replace('Want a 2-minute recording', 'Happy to show you. Want a 2-minute recording')
    expect(only(s)).toEqual([['step_forbid', 1, 'C']])
  })

  it('signoff: steps 1 and 4 end "Frank Jing", steps 2 and 3 "Frank"', () => {
    const s = zenport()
    s[1].variants[0].body = s[1].variants[0].body.replace(/Frank$/, 'Frank Jing')
    s[3].variants[0].body = s[3].variants[0].body.replace(/Frank Jing$/, 'Frank')
    s[0].variants[4].body = s[0].variants[4].body.replace(/\n\nFrank Jing$/, '')
    expect(only(s)).toEqual([
      ['signoff', 1, 'E'],
      ['signoff', 2, 'A'],
      ['signoff', 4, 'A'],
    ])
  })

  it('word_count: step 1 60-90, follow-ups under 60', () => {
    const s = zenport()
    s[0].variants[1].body = 'Hi {{firstName}},\n\nIs maintenance or leasing the bigger fire right now?\n\nFrank Jing'
    s[2].variants[0].body = s[2].variants[0].body.replace('one more angle.', `one more angle. ${'word '.repeat(30)}`)
    expect(only(s)).toEqual([
      ['word_count', 1, 'B'],
      ['word_count', 3, 'A'],
    ])
  })

  it('sequence_structure is a warning: never blocks', () => {
    const s = zenport()
    s[0].variants.pop()
    s[1].delay = 2
    const out = lintSequence(s, RULES)
    expect(out.map((x) => [x.rule, x.step, x.severity])).toEqual([
      ['sequence_structure', 2, 'warning'],
      ['sequence_structure', 1, 'warning'],
    ])
    expect(out.filter(isBlocking)).toEqual([])
    expect(lintSequence(s.slice(0, 3), RULES).map((x) => x.message)).toContain('the sequence has 3 steps; the SOP plans 4')
  })
})
