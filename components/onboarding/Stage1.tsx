'use client'

import { useState, useRef } from 'react'

interface Domain {
  name: string
  available: boolean
}

interface Props {
  companyName: string
  onComplete: () => void
}

export default function Stage1({ companyName, onComplete }: Props) {
  const [profilePicUrl, setProfilePicUrl] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadingPic, setUploadingPic] = useState(false)

  const [domains, setDomains] = useState<Domain[]>([])
  const [generatingDomains, setGeneratingDomains] = useState(false)
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFileChange = async (file: File) => {
    if (!file) return
    setPreviewUrl(URL.createObjectURL(file))
    setUploadingPic(true)
    setError(null)

    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/onboarding/upload-avatar', { method: 'POST', body: form })
    const data = await res.json()

    setUploadingPic(false)
    if (data.url) {
      setProfilePicUrl(data.url)
    } else {
      setError(data.error || 'Upload failed')
    }
  }

  const generateDomains = async () => {
    setGeneratingDomains(true)
    setError(null)
    const res = await fetch('/api/generate-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: companyName }),
    })
    const data = await res.json()
    setGeneratingDomains(false)
    if (data.domains) {
      setDomains(data.domains)
    } else {
      setError(data.error || 'Failed to generate domains')
    }
  }

  const handleContinue = async () => {
    if (!profilePicUrl || !selectedDomain) return
    setSaving(true)
    const res = await fetch('/api/onboarding/complete-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: 1,
        data: {
          profile_picture_url: profilePicUrl,
          selected_domain: selectedDomain,
          generated_domains: domains,
        },
      }),
    })
    setSaving(false)
    if (res.ok) {
      onComplete()
    } else {
      setError('Failed to save. Please try again.')
    }
  }

  const canContinue = !!profilePicUrl && !!selectedDomain

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-medium text-white mb-1">Email Inbox Setup</h2>
        <p className="text-[13px] text-[#6B6B6B]">Upload a professional photo and choose your sending domain.</p>
      </div>

      {error && (
        <div className="bg-red-500/5 border border-red-500/20 rounded px-4 py-3 text-red-400 text-sm">{error}</div>
      )}

      {/* Profile picture */}
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B] mb-3">Profile Photo</p>
        <div className="flex items-center gap-5">
          <div
            onClick={() => fileRef.current?.click()}
            className="w-20 h-20 rounded-full border-2 border-dashed border-[#2A2A2A] hover:border-[#5E6AD2] transition-colors cursor-pointer overflow-hidden flex items-center justify-center bg-[#0F0F0F] shrink-0"
          >
            {previewUrl ? (
              <img src={previewUrl} alt="Preview" className="w-full h-full object-cover" />
            ) : uploadingPic ? (
              <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : (
              <svg className="w-6 h-6 text-[#3A3A3A]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
            )}
          </div>
          <div>
            <p className="text-[13px] text-[#A0A0A0] mb-1">
              {profilePicUrl ? 'Photo uploaded ✓' : 'Click to upload a photo'}
            </p>
            <p className="text-[11px] text-[#4A4A4A]">JPG, PNG or WebP · Max 5MB</p>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={e => e.target.files?.[0] && handleFileChange(e.target.files[0])}
        />
      </div>

      {/* Domain generation */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-[#6B6B6B]">
            Sending Domain
          </p>
          <button
            onClick={generateDomains}
            disabled={generatingDomains}
            className="text-[12px] text-[#5E6AD2] hover:text-[#7E8AE2] transition-colors disabled:opacity-50"
          >
            {generatingDomains ? 'Generating…' : domains.length > 0 ? '↺ Regenerate' : 'Generate Domain Names'}
          </button>
        </div>

        {domains.length === 0 && !generatingDomains && (
          <button
            onClick={generateDomains}
            className="w-full border border-dashed border-[#2A2A2A] hover:border-[#5E6AD2] rounded py-8 text-[13px] text-[#4A4A4A] hover:text-[#6B6B6B] transition-colors"
          >
            Click to generate 30 domain suggestions based on your company name
          </button>
        )}

        {generatingDomains && (
          <div className="border border-[#1E1E1E] rounded py-8 flex items-center justify-center gap-2 text-[13px] text-[#6B6B6B]">
            <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            Checking availability…
          </div>
        )}

        {domains.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {domains.map(d => (
              <button
                key={d.name}
                onClick={() => setSelectedDomain(d.name === selectedDomain ? null : d.name)}
                className={`flex items-center justify-between px-3 py-2 rounded text-[13px] border transition-all text-left ${
                  selectedDomain === d.name
                    ? 'border-[#5E6AD2] bg-[#5E6AD2]/10 text-white'
                    : 'border-[#1E1E1E] bg-[#0F0F0F] text-[#A0A0A0] hover:border-[#2A2A2A] hover:text-white'
                }`}
              >
                <span className="truncate">{d.name}</span>
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ml-2 ${
                    d.available ? 'bg-[#2ECC71]' : 'bg-[#E74C3C]'
                  }`}
                  title={d.available ? 'Likely available' : 'Likely taken'}
                />
              </button>
            ))}
          </div>
        )}

        {selectedDomain && (
          <p className="text-[12px] text-[#5E6AD2] mt-2">
            Selected: {selectedDomain}
          </p>
        )}
      </div>

      <div className="flex justify-end pt-2">
        <button
          onClick={handleContinue}
          disabled={!canContinue || saving}
          className="px-5 py-2 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Continue →'}
        </button>
      </div>
    </div>
  )
}
