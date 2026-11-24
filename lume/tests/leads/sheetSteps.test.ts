import { describe, expect, it } from 'vitest'
import { furthest, PIPELINE_STEPS, sheetStageLabel, stepEyebrow, stepLabel, stepName, toSheetStage, toStep } from '@/lib/leads/steps'
import { combineKey, combineSheets, rowDomain, type CombineSheet } from '@/lib/leads/combine'
import { emptyFinalForm, FinalFilter, finalFilterFromForm, planFinal, ruleReason } from '@/lib/leads/finalFilter'
import { normaliseLead } from '@/lib/review/model'
import type { ListItem } from '@/lib/leads/lists/model'

const lead = (o: Partial<ListItem>): ListItem => ({ ...normaliseLead({}), ...o })

describe('pipeline steps (GTM-18)', () => {
  it('has the five steps in order, each on its Lume page', () => {
    expect(PIPELINE_STEPS.map((s) => `${s.step} ${s.name}`)).toEqual(['1 Imported', '2 Combined', '3 Filtered', '4 Validated', '5 In campaign'])
    expect(PIPELINE_STEPS.map((s) => s.href)).toEqual(['/import', '/import/leads', '/import/leads', '/progress', '/campaigns'])
  })

  it('labels a status as "# · name", with a dropout reason after a dash', () => {
    expect(stepLabel(1)).toBe('1 · Imported')
    expect(stepLabel(5)).toBe('5 · In campaign')
    expect(stepLabel(3, 'excluded: vendor')).toBe('3 · Filtered — excluded: vendor')
    expect(stepLabel(3, '  excluded:\n  vendor  ')).toBe('3 · Filtered — excluded: vendor')
    expect(stepLabel(2, '   ')).toBe('2 · Combined')
  })

  it('treats anything out of range as step 1, and status never moves back', () => {
    expect(toStep(0)).toBe(1)
    expect(toStep(9)).toBe(1)
    expect(toStep('4')).toBe(4)
    expect(toStep(null)).toBe(1)
    expect(stepName(undefined)).toBe('Imported')
    expect(furthest(3, 2)).toBe(3)
    expect(furthest(1, 4)).toBe(4)
  })

  it('page eyebrows match the steps', () => {
    expect(stepEyebrow(1)).toBe('Step 1 · Imported')
    expect(stepEyebrow(3, 2)).toBe('Steps 2–3 · Combined → Filtered')
    expect(stepEyebrow(4)).toBe('Step 4 · Validated')
    expect(stepEyebrow(5)).toBe('Step 5 · In campaign')
  })

  it('a sheet carries its own stage', () => {
    expect(sheetStageLabel('combined')).toBe('2 · Combined master')
    expect(sheetStageLabel('final')).toBe('3 · Final sheet')
    expect(sheetStageLabel(undefined)).toBe('1 · Imported sheet')
    expect(toSheetStage('weird')).toBe('imported')
  })
})

describe('combine (step 2)', () => {
  const maps: CombineSheet = {
    id: 'maps',
    name: 'Maps',
    rows: [
      { idx: 0, item: lead({ name: 'Sunset PM', website: 'https://www.sunsetpm.com/about', phone: '+1 310 555 0100' }), cells: { title: 'Sunset PM', website: 'https://www.sunsetpm.com/about', phone: '+1 310 555 0100', email: '' } },
      { idx: 1, item: lead({ name: 'Harbor Homes', domain: 'harborhomes.com' }), cells: { title: 'Harbor Homes', website: 'harborhomes.com', phone: '' } },
      { idx: 2, item: lead({ name: 'No Web Co' }), cells: { title: 'No Web Co', phone: '555' } },
    ],
  }
  const apollo: CombineSheet = {
    id: 'apollo',
    name: 'Apollo',
    rows: [
      { idx: 0, item: lead({ name: 'Ann Lee', email: 'ann@sunsetpm.com', phone: '+1 999' }), cells: { email: 'ann@sunsetpm.com', phone: '+1 999', 'First Name': 'Ann' } },
      { idx: 1, item: lead({ name: 'Bo', domain: 'harborhomes.com', phone: '+1 222' }), cells: { website: 'harborhomes.com', phone: '+1 222' } },
      { idx: 2, item: lead({ name: 'Cy', email: 'cy@gmail.com' }), cells: { email: 'cy@gmail.com' } },
    ],
  }

  it('keys on domain (own, website, then work email), falling back to email; free mail is not a domain', () => {
    expect(rowDomain(lead({ website: 'https://www.acme.com/x' }))).toBe('acme.com')
    expect(rowDomain(lead({ email: 'a@acme.com' }))).toBe('acme.com')
    expect(rowDomain(lead({ email: 'a@gmail.com' }))).toBeNull()
    expect(combineKey(lead({ email: 'a@gmail.com' }), 'auto')).toBe('email:a@gmail.com')
    expect(combineKey(lead({ email: 'a@gmail.com' }), 'domain')).toBeNull()
    expect(combineKey(lead({ domain: 'acme.com', email: 'A@acme.com' }), 'email')).toBe('email:a@acme.com')
  })

  it('merges duplicates and never overwrites a filled cell by default', () => {
    const out = combineSheets([maps, apollo])
    expect(out.stats).toEqual({ input_rows: 6, output_rows: 4, merged: 2, no_key: 1, rows_with_conflicts: 1 })
    const sunset = out.rows.find((r) => r.key === 'domain:sunsetpm.com')!
    // Maps came first: its phone stays; Apollo only fills the blank email and adds its own column.
    expect(sunset.cells).toMatchObject({ phone: '+1 310 555 0100', email: 'ann@sunsetpm.com', 'First Name': 'Ann', title: 'Sunset PM' })
    expect(sunset.conflicts).toEqual(['phone'])
    expect(sunset.sources).toEqual([
      { sheet_id: 'maps', idx: 0 },
      { sheet_id: 'apollo', idx: 0 },
    ])
    // A blank phone is filled.
    expect(out.rows.find((r) => r.key === 'domain:harborhomes.com')!.cells.phone).toBe('+1 222')
    // No key: kept as its own row.
    expect(out.rows.find((r) => r.key === null)!.cells.title).toBe('No Web Co')
    expect(out.columns).toEqual(['title', 'website', 'phone', 'email', 'First Name'])
  })

  it('a preferred sheet wins where it has a value', () => {
    const out = combineSheets([maps, apollo], { rule: { kind: 'prefer', sheet_id: 'apollo' } })
    const sunset = out.rows.find((r) => r.key === 'domain:sunsetpm.com')!
    expect(sunset.cells.phone).toBe('+1 999')
    expect(sunset.cells.title).toBe('Sunset PM')
  })

  it('auto keeps two people at one company as two rows (email, then LinkedIn); domain folds them into one', () => {
    const people: CombineSheet = {
      id: 'p',
      name: 'People',
      rows: [
        { idx: 0, item: lead({ first_name: 'Ann', last_name: 'Lee', email: 'ann@sunsetpm.com' }), cells: { 'First Name': 'Ann', email: 'ann@sunsetpm.com' } },
        { idx: 1, item: lead({ first_name: 'Ben', last_name: 'Ng', email: 'ben@sunsetpm.com' }), cells: { 'First Name': 'Ben', email: 'ben@sunsetpm.com' } },
        { idx: 2, item: lead({ first_name: 'Cy', linkedin_url: 'https://www.linkedin.com/in/cy-r/' }), cells: { 'First Name': 'Cy' } },
        { idx: 3, item: lead({ first_name: 'Cy', last_name: 'R', linkedin_url: 'linkedin.com/in/cy-r', phone: '7' }), cells: { 'First Name': 'Cy', phone: '7' } },
      ],
    }
    const auto = combineSheets([people])
    expect(auto.rows.map((r) => r.key)).toEqual(['email:ann@sunsetpm.com', 'email:ben@sunsetpm.com', 'linkedin:in/cy-r'])
    expect(auto.rows[2].cells.phone).toBe('7')
    expect(combineSheets([people], { key: 'domain' }).rows.map((r) => r.key)).toEqual(['domain:sunsetpm.com', null, null])
  })

  it('duplicates inside one sheet merge too', () => {
    const one: CombineSheet = {
      id: 's',
      name: 'S',
      rows: [
        { idx: 0, item: lead({ domain: 'a.com', name: 'A' }), cells: { name: 'A', city: '' } },
        { idx: 1, item: lead({ domain: 'A.com', name: 'A2' }), cells: { name: 'A2', city: 'LA' } },
      ],
    }
    const out = combineSheets([one], { key: 'domain' })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0].cells).toEqual({ name: 'A', city: 'LA' })
  })
})

describe('filter → final (step 3)', () => {
  const rows = [
    { idx: 0, item: lead({ name: 'Sunset PM', category: 'Property management company', phone: '1', rating: 4.8, state: 'CA', domain: 'sunset.com' }) },
    { idx: 1, item: lead({ name: 'Ace Supply', category: 'Hardware store', phone: '2', rating: 4.9, state: 'CA' }) },
    { idx: 2, item: lead({ name: 'Quiet PM', category: 'Property management company', phone: null, rating: 4.5, state: 'CA' }) },
    { idx: 3, item: lead({ name: 'Low PM', category: 'Property management company', phone: '3', rating: 2.1, state: 'CA' }) },
    { idx: 4, item: lead({ name: 'Vegas PM', category: 'Property management company', phone: '4', rating: 4.7, state: 'NV' }) },
    { idx: 5, item: lead({ name: 'Sunset PM 2', category: 'Property management company', phone: '5', rating: 4.6, state: 'CA', domain: 'sunset.com' }) },
  ]

  it('records why each row dropped (first rule wins) and keeps the rest', () => {
    const form = { ...emptyFinalForm(), require: ['phone' as const], exclude_categories: 'Hardware store', exclude_reason: 'vendor', min_rating: '4', only_states: 'CA', drop_duplicate_domains: true }
    const filter = finalFilterFromForm(form)!
    const plan = planFinal(rows, filter)
    expect(plan.kept).toBe(1)
    expect(plan.excluded).toBe(5)
    const by = Object.fromEntries(plan.rows.map((o) => [o.idx, o.note]))
    expect(by).toEqual({ 0: null, 1: 'excluded: vendor', 2: 'excluded: no phone', 3: 'excluded: rating below 4', 4: 'excluded: outside the chosen states', 5: 'excluded: duplicate domain' })
    expect(stepLabel(3, by[1])).toBe('3 · Filtered — excluded: vendor')
    expect(plan.reasons.map((r) => r.count)).toEqual([1, 1, 1, 1, 1])
  })

  it('an empty form asks for nothing; a rule without a reason describes itself', () => {
    expect(finalFilterFromForm(emptyFinalForm())).toBeNull()
    expect(finalFilterFromForm({ ...emptyFinalForm(), min_rating: 'abc' })).toBeNull()
    const f = FinalFilter.parse({ rules: [{ criteria: { categories_in: ['Hardware store'] } }] })
    expect(ruleReason(f.rules[0]).toLowerCase()).toContain('hardware store')
    expect(planFinal(rows, f).rows[1].note).toMatch(/^excluded: /)
  })

  it('keep_only drops everything that does not match', () => {
    const f = FinalFilter.parse({ rules: [{ criteria: { states: ['NV'] }, action: 'keep_only', reason: 'not Nevada' }] })
    const plan = planFinal(rows, f)
    expect(plan.kept).toBe(1)
    expect(plan.reasons).toEqual([{ reason: 'not Nevada', count: 5 }])
  })
})
