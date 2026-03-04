'use client'

import { useState } from 'react'

const QUESTIONS = [
  {
    key: 'best_client_description',
    label: 'Describe your best-ever client\'s business',
    placeholder: 'Family-owned restaurant, 2 locations, $2M revenue',
  },
  {
    key: 'biggest_problem',
    label: 'What was their biggest problem before working with you?',
    placeholder: 'Couldn\'t get approved at a bank, needed capital fast',
  },
  {
    key: 'why_said_yes',
    label: 'What made them say yes quickly?',
    placeholder: 'Same-day approval, no collateral required',
  },
  {
    key: 'result_delivered',
    label: 'What result did you deliver and how fast?',
    placeholder: '$50K in 48 hours, renewed 3 times since',
  },
  {
    key: 'red_flags',
    label: 'Who is NOT a good fit — what\'s the red flag?',
    placeholder: 'Startups with no revenue, personal credit under 550',
  },
  {
    key: 'clone_client',
    label: 'If you could clone one client, describe them in one line',
    placeholder: 'Owner-operated service business, 3-10 years old, needs growth capital',
  },
]

interface Props {
  onComplete: () => void
}

export default function Stage2({ onComplete }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allFilled = QUESTIONS.every(q => (answers[q.key] || '').trim().length > 0)

  const handleContinue = async () => {
    if (!allFilled) return
    setSaving(true)
    setError(null)

    const res = await fetch('/api/onboarding/complete-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 2, data: answers }),
    })

    setSaving(false)
    if (res.ok) {
      onComplete()
    } else {
      setError('Failed to save. Please try again.')
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-medium text-white mb-1">Your Best Clients</h2>
        <p className="text-[13px] text-[#6B6B6B]">
          Help us understand who you serve best. Short answers are perfect.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/5 border border-red-500/20 rounded px-4 py-3 text-red-400 text-sm">{error}</div>
      )}

      <div className="space-y-5">
        {QUESTIONS.map((q, i) => (
          <div key={q.key}>
            <label className="block text-[13px] text-[#A0A0A0] mb-1.5">
              <span className="text-[#4A4A4A] mr-2">{i + 1}.</span>
              {q.label}
            </label>
            <input
              type="text"
              value={answers[q.key] || ''}
              onChange={e => setAnswers(prev => ({ ...prev, [q.key]: e.target.value }))}
              placeholder={q.placeholder}
              className="w-full px-3 py-2.5 bg-[#0F0F0F] border border-[#1E1E1E] rounded text-[13px] text-white placeholder-[#3A3A3A] focus:outline-none focus:border-[#3A3A3A] transition-colors"
            />
          </div>
        ))}
      </div>

      <div className="flex justify-end pt-2">
        <button
          onClick={handleContinue}
          disabled={!allFilled || saving}
          className="px-5 py-2 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Continue →'}
        </button>
      </div>
    </div>
  )
}
