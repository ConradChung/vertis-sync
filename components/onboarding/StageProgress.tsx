'use client'

const STAGES = [
  { label: 'Inbox Setup', num: 1 },
  { label: 'Your Best Clients', num: 2 },
  { label: 'ICP & Targeting', num: 3 },
]

export default function StageProgress({ currentStage }: { currentStage: number }) {
  return (
    <div className="flex items-center gap-0">
      {STAGES.map((stage, i) => {
        const done = currentStage > stage.num
        const active = currentStage === stage.num
        return (
          <div key={stage.num} className="flex items-center flex-1">
            <div className="flex flex-col items-center flex-1">
              <div className="flex items-center w-full">
                {/* Left connector */}
                {i > 0 && (
                  <div className={`flex-1 h-px ${done || active ? 'bg-[#5E6AD2]' : 'bg-[#2A2A2A]'}`} />
                )}
                {/* Circle */}
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 border ${
                    done
                      ? 'bg-[#5E6AD2] border-[#5E6AD2] text-white'
                      : active
                      ? 'bg-transparent border-white text-white'
                      : 'bg-transparent border-[#3A3A3A] text-[#4A4A4A]'
                  }`}
                >
                  {done ? (
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    stage.num
                  )}
                </div>
                {/* Right connector */}
                {i < STAGES.length - 1 && (
                  <div className={`flex-1 h-px ${done ? 'bg-[#5E6AD2]' : 'bg-[#2A2A2A]'}`} />
                )}
              </div>
              <span
                className={`mt-2 text-[11px] font-medium text-center ${
                  active ? 'text-white' : done ? 'text-[#5E6AD2]' : 'text-[#4A4A4A]'
                }`}
              >
                {stage.label}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
