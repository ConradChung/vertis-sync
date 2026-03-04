'use client'

import { useState, useRef } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'

type Step = 'upload' | 'ambiguous' | 'processing' | 'done' | 'error'

interface Progress {
  processed: number
  total: number
}

export default function EmailValidator() {
  const [step, setStep] = useState<Step>('upload')
  const [ambiguousColumns, setAmbiguousColumns] = useState<string[]>([])
  const [error, setError] = useState<string>('')
  const [progress, setProgress] = useState<Progress>({ processed: 0, total: 0 })
  const fileRef = useRef<File | null>(null)
  const [validCount, setValidCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)

  async function submit(file: File, column?: string) {
    setStep('processing')
    setProgress({ processed: 0, total: 0 })
    setError('')
    setValidCount(0)
    setTotalCount(0)
    let runningValid = 0
    let runningTotal = 0

    const formData = new FormData()
    formData.append('file', file)
    if (column) formData.append('column', column)

    try {
      const res = await fetch('/api/validate-emails', { method: 'POST', body: formData })
      const contentType = res.headers.get('content-type') ?? ''

      if (contentType.includes('application/json')) {
        const json = await res.json()
        if (json.status === 'ambiguous') {
          setAmbiguousColumns(json.columns)
          setStep('ambiguous')
        } else {
          setError(json.error ?? 'An unexpected error occurred')
          setStep('error')
        }
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data: ')) continue
          const payload = JSON.parse(line.slice(6))

          if (payload.type === 'start') {
            runningTotal = payload.total
            setProgress({ processed: 0, total: payload.total })
          } else if (payload.type === 'progress') {
            setProgress({ processed: payload.processed, total: payload.total })
            if (payload.status === 'valid') runningValid++
          } else if (payload.type === 'complete') {
            setValidCount(runningValid)
            setTotalCount(runningTotal)
            const blob = new Blob([payload.csv], { type: 'text/csv' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'validated_emails.csv'
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
            setStep('done')
          }
        }
      }
    } catch (err: any) {
      setError(err.message ?? 'Network error')
      setStep('error')
    }
  }

  function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const file = (e.currentTarget.elements.namedItem('csv') as HTMLInputElement).files?.[0]
    if (!file) return
    fileRef.current = file
    submit(file)
  }

  function handleColumnSelect(column: string) {
    if (!fileRef.current) return
    submit(fileRef.current, column)
  }

  function reset() {
    setStep('upload')
    setAmbiguousColumns([])
    setError('')
    setProgress({ processed: 0, total: 0 })
    setValidCount(0)
    setTotalCount(0)
    fileRef.current = null
  }

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0

  return (
    <section>
      <div className="mb-5">
        <h2 className="text-base font-medium text-white">Email Validator</h2>
        <p className="text-[#6B6B6B] text-[13px] mt-1">
          Upload a CSV to validate each email address and download the enriched file.
        </p>
      </div>

      <div className="max-w-lg">
        {step === 'upload' && (
          <form onSubmit={handleUpload} className="space-y-4">
            <div className="border border-[#1E1E1E] rounded p-4">
              <label className="block text-[#6B6B6B] text-[11px] uppercase tracking-wider font-medium mb-3">
                CSV File
              </label>
              <input
                type="file"
                name="csv"
                accept=".csv"
                required
                className="block w-full text-sm text-[#6B6B6B] file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:bg-[#1E1E1E] file:text-white hover:file:bg-[#2A2A2A] file:cursor-pointer cursor-pointer"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2 px-4 bg-white text-[#0A0A0A] text-sm font-medium rounded hover:bg-[#E0E0E0] transition-colors"
            >
              Validate Emails
            </button>
          </form>
        )}

        {step === 'ambiguous' && (
          <div className="space-y-4">
            <div className="border border-[#1E1E1E] rounded p-4">
              <p className="text-white text-sm mb-4">
                Multiple email columns found. Which one should we validate?
              </p>
              <div className="space-y-2">
                {ambiguousColumns.map(col => (
                  <button
                    key={col}
                    onClick={() => handleColumnSelect(col)}
                    className="w-full text-left px-4 py-2.5 border border-[#1E1E1E] rounded text-sm text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-white transition-colors"
                  >
                    {col}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={reset} className="text-[#4A4A4A] text-xs hover:text-[#A0A0A0] transition-colors">
              ← Upload a different file
            </button>
          </div>
        )}

        {step === 'processing' && (
          <div className="border border-[#1E1E1E] rounded p-6 space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[#6B6B6B]">Validating emails…</span>
              <span className="text-white tabular-nums">
                {progress.total > 0 ? `${progress.processed} / ${progress.total}` : '—'}
              </span>
            </div>
            <div className="h-1.5 bg-[#1E1E1E] rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-[#4A4A4A] text-xs">
              {progress.total > 0
                ? `${pct}% complete — processing sequentially to avoid rate limits`
                : 'Starting…'}
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="border border-[#1E1E1E] rounded p-6 text-center space-y-3">
            <p className="text-white text-sm">Validation complete — CSV downloaded.</p>
            <button onClick={reset} className="text-[#4A4A4A] text-xs hover:text-[#A0A0A0] transition-colors">
              Validate another file
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-4">
            <div className="border border-red-500/20 bg-red-500/5 rounded p-4">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
            <button onClick={reset} className="text-[#4A4A4A] text-xs hover:text-[#A0A0A0] transition-colors">
              ← Try again
            </button>
          </div>
        )}
      </div>

      {step === 'done' && totalCount > 0 && (() => {
        const invalid = totalCount - validCount
        const validPct = Math.round((validCount / totalCount) * 100)
        const data = [
          { name: 'Valid', value: validCount },
          { name: 'Not Valid', value: invalid },
        ]
        const COLORS = ['#22c55e', '#ef4444']

        return (
          <div className="mt-8 pt-8 border-t border-[#1E1E1E]">
            <h3 className="text-sm font-medium text-white mb-5">Results</h3>
            <div className="flex items-center gap-10">
              <div className="relative w-36 h-36 flex-shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={60}
                      paddingAngle={2}
                      dataKey="value"
                      strokeWidth={0}
                    >
                      {data.map((_, i) => (
                        <Cell key={i} fill={COLORS[i]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-white text-xl font-semibold tabular-nums">{validPct}%</span>
                </div>
              </div>

              <div className="space-y-3 min-w-[140px]">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#22c55e]"></span>
                    <span className="text-sm text-[#6B6B6B]">Valid</span>
                  </div>
                  <span className="text-sm text-white tabular-nums">{validCount}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#ef4444]"></span>
                    <span className="text-sm text-[#6B6B6B]">Not Valid</span>
                  </div>
                  <span className="text-sm text-white tabular-nums">{invalid}</span>
                </div>
                <div className="border-t border-[#1E1E1E] pt-3 flex items-center justify-between gap-4">
                  <span className="text-sm text-[#6B6B6B]">Total</span>
                  <span className="text-sm text-white tabular-nums">{totalCount}</span>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </section>
  )
}
