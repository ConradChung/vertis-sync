'use client'

interface Props {
  onViewCampaign?: () => void
  hasCampaign: boolean
}

export default function OnboardingComplete({ onViewCampaign, hasCampaign }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="relative mb-6">
        <svg
          className="w-16 h-16 text-[#5E6AD2]"
          viewBox="0 0 64 64"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ animation: 'draw-check 0.6s ease forwards' }}
        >
          <circle cx="32" cy="32" r="30" strokeOpacity="0.2" />
          <path
            d="M20 32l9 9 15-18"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ animation: 'draw-check 0.5s 0.2s ease forwards', strokeDasharray: 40, strokeDashoffset: 40 }}
          />
        </svg>
      </div>

      <h2 className="text-xl font-medium text-white mb-2">You're all set.</h2>
      <p className="text-[#6B6B6B] text-[14px] max-w-sm">
        We'll have your campaign ready within 48 hours. You'll hear from us shortly.
      </p>

      {hasCampaign && onViewCampaign && (
        <button
          onClick={onViewCampaign}
          className="mt-6 text-[13px] text-[#5E6AD2] hover:text-[#7E8AE2] transition-colors"
        >
          View campaign analytics →
        </button>
      )}

      <style>{`
        @keyframes draw-check {
          to { stroke-dashoffset: 0; }
        }
      `}</style>
    </div>
  )
}
