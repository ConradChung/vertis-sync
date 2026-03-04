'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'

type Step = 'upload' | 'ambiguous' | 'processing' | 'done' | 'error'

interface Progress {
  processed: number
  total: number
}

export default function EmailValidatorPage() {
  const [step, setStep] = useState<Step>('upload')
  const [ambiguousColumns, setAmbiguousColumns] = useState<string[]>([])
  const [error, setError] = useState<string>('')
  const [progress, setProgress] = useState<Progress>({ processed: 0, total: 0 })
  const fileRef = useRef<File | null>(null)

  async function submit(file: File, column?: string) {
    setStep('processing')
    setProgress({ processed: 0, total: 0 })
    setError('')

    const formData = new FormData()
    formData.append('file', file)
    if (column) formData.append('column', column)

    try {
      const res = await fetch('/api/validate-emails', { method: 'POST', body: formData })
      const contentType = res.headers.get('content-type') ?? ''

      // Non-streaming response: ambiguous column or error
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

      // Streaming SSE response: read progress events
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE events are separated by double newlines
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data: ')) continue
          const payload = JSON.parse(line.slice(6))

          if (payload.type === 'start') {
            setProgress({ processed: 0, total: payload.total })
          } else if (payload.type === 'progress') {
            setProgress({ processed: payload.processed, total: payload.total })
          } else if (payload.type === 'complete') {
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
    fileRef.current = null
  }

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <h1 className="text-white text-2xl font-semibold mb-1">Email Validator</h1>
        <p className="text-[#666] text-sm mb-8">
          Upload a CSV to validate each email address and download the enriched file.
        </p>

        {step === 'upload' && (
          <form onSubmit={handleUpload} className="space-y-4">
            <div className="border border-[#1E1E1E] rounded-lg p-4">
              <label className="block text-[#999] text-xs uppercase tracking-wider mb-3">
                CSV File
              </label>
              <input
                type="file"
                name="csv"
                accept=".csv"
                required
                className="block w-full text-sm text-[#999] file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:bg-[#1E1E1E] file:text-white hover:file:bg-[#2A2A2A] file:cursor-pointer cursor-pointer"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 px-4 bg-white text-black text-sm font-medium rounded-lg hover:bg-[#E5E5E5] transition-colors"
            >
              Validate Emails
            </button>
          </form>
        )}

        {step === 'ambiguous' && (
          <div className="space-y-4">
            <div className="border border-[#1E1E1E] rounded-lg p-4">
              <p className="text-white text-sm mb-4">
                Multiple email columns found. Which one should we validate?
              </p>
              <div className="space-y-2">
                {ambiguousColumns.map(col => (
                  <button
                    key={col}
                    onClick={() => handleColumnSelect(col)}
                    className="w-full text-left px-4 py-2.5 border border-[#1E1E1E] rounded-lg text-sm text-[#999] hover:border-[#444] hover:text-white transition-colors"
                  >
                    {col}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={reset} className="text-[#555] text-xs hover:text-[#999] transition-colors">
              ← Upload a different file
            </button>
          </div>
        )}

        {step === 'processing' && (
          <div className="border border-[#1E1E1E] rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[#999]">Validating emails…</span>
              <span className="text-white tabular-nums">
                {progress.total > 0 ? `${progress.processed} / ${progress.total}` : '—'}
              </span>
            </div>

            {/* Progress bar */}
            <div className="h-1.5 bg-[#1E1E1E] rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>

            <p className="text-[#555] text-xs">
              {progress.total > 0
                ? `${pct}% complete — processing sequentially to avoid rate limits`
                : 'Starting…'}
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="border border-[#1E1E1E] rounded-lg p-8 text-center space-y-4">
            <p className="text-white text-sm">Download started.</p>
            <p className="text-[#555] text-xs">
              Your enriched CSV includes a <code className="text-[#999]">validation_status</code> column.
            </p>
            <div className="flex items-center justify-center gap-4 pt-1">
              <button onClick={reset} className="text-[#555] text-xs hover:text-[#999] transition-colors">
                Validate another file
              </button>
              <span className="text-[#333] text-xs">·</span>
              <Link href="/dashboard" className="text-[#555] text-xs hover:text-[#999] transition-colors">
                ← Back to home
              </Link>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-4">
            <div className="border border-red-900 rounded-lg p-4">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
            <button onClick={reset} className="text-[#555] text-xs hover:text-[#999] transition-colors">
              ← Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
