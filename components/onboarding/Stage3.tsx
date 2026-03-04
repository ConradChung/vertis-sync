'use client'

import { useState, useRef, KeyboardEvent } from 'react'

// ── Chip component ───────────────────────────────────────────────────────────
function Chip({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-[12px] font-medium border transition-all ${
        selected
          ? 'bg-[#5E6AD2]/15 border-[#5E6AD2] text-[#8B95E2]'
          : 'bg-[#0F0F0F] border-[#1E1E1E] text-[#6B6B6B] hover:border-[#2A2A2A] hover:text-[#A0A0A0]'
      }`}
    >
      {label}
    </button>
  )
}

// ── Tag input component ──────────────────────────────────────────────────────
function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder: string
}) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addTag = (value: string) => {
    const trimmed = value.trim().replace(/,$/, '').trim()
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed])
    }
    setInput('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div
      className="min-h-[38px] px-2.5 py-1.5 bg-[#0F0F0F] border border-[#1E1E1E] rounded flex flex-wrap gap-1.5 items-center cursor-text focus-within:border-[#3A3A3A] transition-colors"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map(tag => (
        <span
          key={tag}
          className="flex items-center gap-1 px-2 py-0.5 bg-[#1E1E1E] text-[#A0A0A0] text-[11px] rounded"
        >
          {tag}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onChange(tags.filter(t => t !== tag)) }}
            className="text-[#4A4A4A] hover:text-[#A0A0A0] leading-none"
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (input.trim()) addTag(input) }}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] bg-transparent text-[12px] text-white placeholder-[#3A3A3A] outline-none"
      />
    </div>
  )
}

// ── Data ─────────────────────────────────────────────────────────────────────
const INDUSTRY_GROUPS = [
  {
    group: 'Financial Services',
    chips: ['Merchant Cash Advance', 'Alternative Lending', 'Factoring', 'Equipment Financing', 'Business Loans'],
  },
  {
    group: 'Real Estate',
    chips: ['Property Management', 'Commercial RE', 'Residential RE', 'PropTech', 'REITs'],
  },
  {
    group: 'Professional Services',
    chips: ['Accounting', 'Legal', 'Consulting', 'Staffing', 'Insurance'],
  },
  {
    group: 'Retail & Hospitality',
    chips: ['Restaurants', 'Retail', 'Hotels', 'Franchises'],
  },
  {
    group: 'Healthcare',
    chips: ['Medical Practices', 'Dental', 'Chiropractic', 'Clinics'],
  },
  {
    group: 'Construction & Trades',
    chips: ['General Contractor', 'HVAC', 'Plumbing', 'Electrical', 'Landscaping'],
  },
]

const COMPANY_SIZES = ['1-10', '11-25', '26-50', '51-100', '101-250', '251-500', '500+']
const REVENUES = ['$0-1M', '$1-10M', '$10-50M', '$50-100M', '$100M+']
const LOCATIONS = ['Northeast', 'Southeast', 'Midwest', 'Southwest', 'West Coast', 'Nationwide']
const BUYING_SIGNALS = ['Hiring', 'Funding Raised', 'New Location', 'Recent Award', 'Partnership Announced', 'Expanding', 'New Client Win']
const CTA_TYPES = ['Phone Call', 'Discovery Call', 'Demo', 'Site Visit', 'Free Audit']
const DEAL_SIZES = ['Under $5K', '$5K-15K', '$15K-50K', '$50K+']

// ── Helpers ───────────────────────────────────────────────────────────────────
function toggle(arr: string[], val: string) {
  return arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]
}
function selectOne(arr: string[], val: string) {
  return arr.includes(val) ? [] : [val]
}

// ── Form state ────────────────────────────────────────────────────────────────
interface FormState {
  industries: string[]
  company_size: string[]
  revenue_ranges: string[]
  locations: string[]
  buying_signals: string[]
  job_titles_include: string[]
  job_titles_exclude: string[]
  keywords_include: string[]
  keywords_exclude: string[]
  cta_type: string[]
  deal_size_range: string[]
  offer_description: string
  best_customer_description: string
  calendly_link: string
}

interface Props {
  onComplete: () => void
}

export default function Stage3({ onComplete }: Props) {
  const [screen, setScreen] = useState<1 | 2>(1)
  const [form, setForm] = useState<FormState>({
    industries: [],
    company_size: [],
    revenue_ranges: [],
    locations: [],
    buying_signals: [],
    job_titles_include: [],
    job_titles_exclude: [],
    keywords_include: [],
    keywords_exclude: [],
    cta_type: [],
    deal_size_range: [],
    offer_description: '',
    best_customer_description: '',
    calendly_link: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: val }))

  const screen1Valid = form.industries.length > 0 && form.locations.length > 0
  const screen2Valid = form.job_titles_include.length > 0 && form.offer_description.trim().length > 0

  const handleSubmit = async () => {
    if (!screen2Valid) return
    setSaving(true)
    setError(null)

    const payload = {
      ...form,
      cta_type: form.cta_type[0] || null,
      deal_size_range: form.deal_size_range[0] || null,
      company_size: form.company_size,
    }

    const res = await fetch('/api/onboarding/complete-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 3, data: payload }),
    })

    setSaving(false)
    if (res.ok) {
      onComplete()
    } else {
      setError('Failed to save. Please try again.')
    }
  }

  // ── Section label ──────────────────────────────────────────────────────────
  const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <p className="text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B] mb-2">{children}</p>
  )

  return (
    <div className="space-y-6">
      {/* Header + screen indicator */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-medium text-white mb-1">
            {screen === 1 ? 'Who are you targeting?' : 'What are you selling?'}
          </h2>
          <p className="text-[13px] text-[#6B6B6B]">
            {screen === 1 ? 'Select all that apply.' : 'Be specific — this drives your copy.'}
          </p>
        </div>
        <div className="flex gap-1.5 items-center shrink-0">
          <div className="w-5 h-1 rounded bg-[#5E6AD2]" />
          <div className={`w-5 h-1 rounded ${screen === 2 ? 'bg-[#5E6AD2]' : 'bg-[#2A2A2A]'}`} />
          <span className="text-[11px] text-[#4A4A4A] ml-1">Screen {screen}/2</span>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/5 border border-red-500/20 rounded px-4 py-3 text-red-400 text-sm">{error}</div>
      )}

      {/* ── Screen 1 ─────────────────────────────────────────────────────── */}
      {screen === 1 && (
        <div className="space-y-6">
          {/* Industry */}
          <div>
            <SectionLabel>Industry</SectionLabel>
            <div className="space-y-3">
              {INDUSTRY_GROUPS.map(g => (
                <div key={g.group}>
                  <p className="text-[11px] text-[#4A4A4A] mb-1.5">{g.group}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {g.chips.map(chip => (
                      <Chip
                        key={chip}
                        label={chip}
                        selected={form.industries.includes(chip)}
                        onClick={() => set('industries', toggle(form.industries, chip))}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Company Size */}
          <div>
            <SectionLabel>Company Size (employees)</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {COMPANY_SIZES.map(s => (
                <Chip
                  key={s}
                  label={s}
                  selected={form.company_size.includes(s)}
                  onClick={() => set('company_size', selectOne(form.company_size, s))}
                />
              ))}
            </div>
          </div>

          {/* Revenue */}
          <div>
            <SectionLabel>Revenue Range</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {REVENUES.map(r => (
                <Chip
                  key={r}
                  label={r}
                  selected={form.revenue_ranges.includes(r)}
                  onClick={() => set('revenue_ranges', toggle(form.revenue_ranges, r))}
                />
              ))}
            </div>
          </div>

          {/* Location */}
          <div>
            <SectionLabel>Location</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {LOCATIONS.map(l => (
                <Chip
                  key={l}
                  label={l}
                  selected={form.locations.includes(l)}
                  onClick={() => set('locations', toggle(form.locations, l))}
                />
              ))}
            </div>
          </div>

          {/* Buying Signals */}
          <div>
            <SectionLabel>When is a good time to reach out?</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {BUYING_SIGNALS.map(s => (
                <Chip
                  key={s}
                  label={s}
                  selected={form.buying_signals.includes(s)}
                  onClick={() => set('buying_signals', toggle(form.buying_signals, s))}
                />
              ))}
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => setScreen(2)}
              disabled={!screen1Valid}
              className="px-5 py-2 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* ── Screen 2 ─────────────────────────────────────────────────────── */}
      {screen === 2 && (
        <div className="space-y-6">
          {/* Job Titles */}
          <div>
            <SectionLabel>Job Titles</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] text-[#4A4A4A] mb-1.5">Include</p>
                <TagInput
                  tags={form.job_titles_include}
                  onChange={v => set('job_titles_include', v)}
                  placeholder="CEO, Owner, Managing Director…"
                />
              </div>
              <div>
                <p className="text-[11px] text-[#4A4A4A] mb-1.5">Exclude</p>
                <TagInput
                  tags={form.job_titles_exclude}
                  onChange={v => set('job_titles_exclude', v)}
                  placeholder="Intern, Assistant…"
                />
              </div>
            </div>
          </div>

          {/* Keywords */}
          <div>
            <SectionLabel>Keywords</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] text-[#4A4A4A] mb-1.5">Include</p>
                <TagInput
                  tags={form.keywords_include}
                  onChange={v => set('keywords_include', v)}
                  placeholder="merchant cash advance, business funding…"
                />
              </div>
              <div>
                <p className="text-[11px] text-[#4A4A4A] mb-1.5">Exclude</p>
                <TagInput
                  tags={form.keywords_exclude}
                  onChange={v => set('keywords_exclude', v)}
                  placeholder="enterprise, Fortune 500…"
                />
              </div>
            </div>
          </div>

          {/* CTA Type */}
          <div>
            <SectionLabel>CTA Type</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {CTA_TYPES.map(c => (
                <Chip
                  key={c}
                  label={c}
                  selected={form.cta_type.includes(c)}
                  onClick={() => set('cta_type', selectOne(form.cta_type, c))}
                />
              ))}
            </div>
          </div>

          {/* Deal Size */}
          <div>
            <SectionLabel>Deal Size</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {DEAL_SIZES.map(d => (
                <Chip
                  key={d}
                  label={d}
                  selected={form.deal_size_range.includes(d)}
                  onClick={() => set('deal_size_range', selectOne(form.deal_size_range, d))}
                />
              ))}
            </div>
          </div>

          {/* Freetext */}
          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B] mb-1.5">
                Describe your offer in one sentence
              </label>
              <input
                type="text"
                value={form.offer_description}
                onChange={e => set('offer_description', e.target.value)}
                placeholder="We help restaurant owners get $10K-$500K in working capital within 48 hours"
                className="w-full px-3 py-2.5 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-[13px] text-white placeholder-[#3A3A3A] focus:outline-none focus:border-[#3A3A3A] transition-colors"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B] mb-1.5">
                Describe your best ever customer
              </label>
              <input
                type="text"
                value={form.best_customer_description}
                onChange={e => set('best_customer_description', e.target.value)}
                placeholder="Family-owned restaurant, 2 locations, needed capital fast, closed in 3 days"
                className="w-full px-3 py-2.5 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-[13px] text-white placeholder-[#3A3A3A] focus:outline-none focus:border-[#3A3A3A] transition-colors"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B] mb-1.5">
                Your Calendly or booking link
              </label>
              <input
                type="text"
                value={form.calendly_link}
                onChange={e => set('calendly_link', e.target.value)}
                placeholder="calendly.com/yourname"
                className="w-full px-3 py-2.5 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-[13px] text-white placeholder-[#3A3A3A] focus:outline-none focus:border-[#3A3A3A] transition-colors"
              />
            </div>
          </div>

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setScreen(1)}
              className="text-[13px] text-[#6B6B6B] hover:text-white transition-colors"
            >
              ← Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={!screen2Valid || saving}
              className="px-5 py-2 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {saving ? 'Submitting…' : 'Submit →'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
