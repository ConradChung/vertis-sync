'use client'

import { useState } from 'react'

interface Props {
  url: string | null
  acknowledged: boolean
  onAcknowledge: () => void
}

export default function DocuSignSection({ url, acknowledged, onAcknowledge }: Props) {
  const [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false)

  if (acknowledged) {
    return (
      <div className="flex items-center gap-2 text-[#2ECC71] text-[13px]">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
        Agreement signed
      </div>
    )
  }

  if (!url) {
    return (
      <div className="border border-[#1E1E1E] rounded px-5 py-4">
        <p className="text-[13px] text-[#6B6B6B]">
          Agreement pending — your account manager will send this shortly.
        </p>
      </div>
    )
  }

  return (
    <div className="border border-[#5E6AD2]/40 bg-[#5E6AD2]/5 rounded px-5 py-5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-[#5E6AD2] mb-1">
        Step 1 of 1 — Agreement
      </p>
      <h3 className="text-base font-medium text-white mb-1">Sign your client agreement</h3>
      <p className="text-[13px] text-[#6B6B6B] mb-4">
        Review and sign the agreement before we begin your onboarding.
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors mb-4"
      >
        Sign Agreement
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </a>
      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={e => setChecked(e.target.checked)}
          className="sr-only"
        />
        <div
          className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${
            checked ? 'bg-[#5E6AD2] border-[#5E6AD2]' : 'border-[#3A3A3A] bg-transparent'
          }`}
        >
          {checked && (
            <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
        <span className="text-[13px] text-[#A0A0A0]">I've signed the agreement</span>
      </label>
      {checked && (
        <button
          onClick={async () => {
            setSaving(true)
            await onAcknowledge()
            setSaving(false)
          }}
          disabled={saving}
          className="mt-3 px-4 py-1.5 bg-[#5E6AD2] text-white text-sm font-medium rounded hover:bg-[#4E5AC2] transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Continue to Onboarding →'}
        </button>
      )}
    </div>
  )
}
