'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Upload, RotateCcw, CheckCircle2, Download, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface ValidationRun {
  id: string
  file_name: string
  total: number
  valid_count: number
  storage_path: string
  created_at: string
}

type Step = 'upload' | 'ambiguous' | 'processing' | 'done' | 'error'

interface Progress {
  processed: number
  total: number
}

function RingChart({ pct, valid, invalid }: { pct: number; valid: number; invalid: number }) {
  const radius = 54
  const stroke = 6
  const circumference = 2 * Math.PI * radius
  const validDash = (pct / 100) * circumference
  const invalidDash = ((100 - pct) / 100) * circumference

  return (
    <div className="flex items-center gap-8">
      <div className="relative w-32 h-32 shrink-0">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 128 128">
          {/* Track */}
          <circle cx="64" cy="64" r={radius} fill="none" stroke="#1A1A1A" strokeWidth={stroke} />
          {/* Invalid arc (red, behind) */}
          {invalid > 0 && (
            <circle
              cx="64" cy="64" r={radius} fill="none"
              stroke="#ef4444" strokeWidth={stroke}
              strokeDasharray={`${invalidDash} ${circumference}`}
              strokeDashoffset={-validDash}
              strokeLinecap="round"
              className="transition-all duration-700"
            />
          )}
          {/* Valid arc (green, on top) */}
          {valid > 0 && (
            <circle
              cx="64" cy="64" r={radius} fill="none"
              stroke="#22c55e" strokeWidth={stroke}
              strokeDasharray={`${validDash} ${circumference}`}
              strokeDashoffset={0}
              strokeLinecap="round"
              className="transition-all duration-700"
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-white text-xl font-semibold tabular-nums leading-none">{pct}%</span>
          <span className="text-[10px] text-[#4A4A4A] mt-0.5">valid</span>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-8">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#22c55e]" />
            <span className="text-[13px] text-[#6B6B6B]">Valid</span>
          </div>
          <span className="text-[13px] text-white tabular-nums font-medium">{valid.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-8">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#ef4444]" />
            <span className="text-[13px] text-[#6B6B6B]">Invalid</span>
          </div>
          <span className="text-[13px] text-white tabular-nums font-medium">{invalid.toLocaleString()}</span>
        </div>
        <div className="border-t border-[#1E1E1E] pt-3 flex items-center justify-between gap-8">
          <span className="text-[13px] text-[#6B6B6B]">Total</span>
          <span className="text-[13px] text-white tabular-nums font-medium">{(valid + invalid).toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

export default function EmailValidator() {
  const [step, setStep] = useState<Step>('upload')
  const [ambiguousColumns, setAmbiguousColumns] = useState<string[]>([])
  const [error, setError] = useState<string>('')
  const [progress, setProgress] = useState<Progress>({ processed: 0, total: 0 })
  const fileRef = useRef<File | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [validCount, setValidCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [runs, setRuns] = useState<ValidationRun[]>([])
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const supabase = createClient()

  const loadRuns = useCallback(async () => {
    const { data } = await supabase
      .from('email_validation_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)
    if (data) setRuns(data)
  }, [supabase])

  useEffect(() => { loadRuns() }, [loadRuns])

  async function handleDownload(run: ValidationRun) {
    setDownloadingId(run.id)
    const { data, error } = await supabase.storage
      .from('validation-results')
      .createSignedUrl(run.storage_path, 3600)
    setDownloadingId(null)
    if (error || !data?.signedUrl) return
    const a = document.createElement('a')
    a.href = data.signedUrl
    a.download = run.file_name.replace('.csv', '') + '_validated.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

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
            loadRuns()
          }
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error')
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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    setFileName(file?.name ?? '')
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
    setFileName('')
    fileRef.current = null
  }

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-lg font-medium text-white mb-1">Email Validator</h2>
        <p className="text-[13px] text-[#6B6B6B]">
          Upload a CSV to validate each email address and download the enriched file.
        </p>
      </div>

      <div className="max-w-lg space-y-3">
        {step === 'upload' && (
          <form onSubmit={handleUpload} className="space-y-3">
            <label className="flex flex-col items-center justify-center gap-3 border border-dashed border-[#2A2A2A] rounded-xl bg-[#0F0F0F] px-6 py-10 cursor-pointer hover:border-[#3A3A3A] hover:bg-[#121212] transition-colors group">
              <div className="w-10 h-10 rounded-full bg-[#1A1A1A] border border-[#2A2A2A] flex items-center justify-center group-hover:border-[#3A3A3A] transition-colors">
                <Upload size={18} className="text-[#5A5A5A]" />
              </div>
              <div className="text-center">
                <p className="text-[13px] text-white font-medium">
                  {fileName ? fileName : 'Choose a CSV file'}
                </p>
                <p className="text-[12px] text-[#4A4A4A] mt-0.5">
                  {fileName ? 'Click to change' : 'or drag and drop here'}
                </p>
              </div>
              <input type="file" name="csv" accept=".csv" required className="sr-only" onChange={handleFileChange} />
            </label>
            <Button type="submit" className="w-full rounded-xl bg-white text-[#0A0A0A] hover:bg-[#E8E8E8] font-medium text-[13px] h-10">
              Validate Emails
            </Button>
          </form>
        )}

        {step === 'ambiguous' && (
          <div className="space-y-3">
            <div className="border border-[#1E1E1E] rounded-xl bg-[#0F0F0F] p-5">
              <p className="text-[13px] text-white font-medium mb-1">Multiple email columns found</p>
              <p className="text-[12px] text-[#6B6B6B] mb-4">Which column should we validate?</p>
              <div className="space-y-2">
                {ambiguousColumns.map(col => (
                  <button key={col} onClick={() => handleColumnSelect(col)}
                    className="w-full text-left px-4 py-2.5 border border-[#1E1E1E] rounded-lg text-[13px] text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-white hover:bg-[#141414] transition-colors">
                    {col}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={reset} className="flex items-center gap-1.5 text-[12px] text-[#4A4A4A] hover:text-[#A0A0A0] transition-colors">
              <RotateCcw size={12} /> Upload a different file
            </button>
          </div>
        )}

        {step === 'processing' && (
          <div className="border border-[#1E1E1E] rounded-xl bg-[#0F0F0F] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#6B6B6B]">Validating emails…</span>
              <span className="text-[13px] text-white tabular-nums font-medium">
                {progress.total > 0 ? `${progress.processed} / ${progress.total}` : '—'}
              </span>
            </div>
            <div className="h-1 bg-[#1E1E1E] rounded-full overflow-hidden">
              <div className="h-full bg-white rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11px] text-[#4A4A4A]">
              {progress.total > 0 ? `${pct}% complete — processing sequentially to avoid rate limits` : 'Starting…'}
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="border border-[#1E1E1E] rounded-xl bg-[#0F0F0F] p-6 flex flex-col items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#22c55e]/10 flex items-center justify-center">
              <CheckCircle2 size={20} className="text-[#22c55e]" />
            </div>
            <div className="text-center">
              <p className="text-[13px] text-white font-medium">Validation complete</p>
              <p className="text-[12px] text-[#6B6B6B] mt-0.5">CSV downloaded to your device</p>
            </div>
            <Button variant="ghost" size="sm" onClick={reset}
              className="text-[12px] text-[#4A4A4A] hover:text-white hover:bg-[#1A1A1A] rounded-lg mt-1">
              <RotateCcw size={12} className="mr-1.5" /> Validate another file
            </Button>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-3">
            <div className="border border-red-500/20 bg-red-500/5 rounded-xl p-5">
              <p className="text-[13px] text-red-400">{error}</p>
            </div>
            <button onClick={reset} className="flex items-center gap-1.5 text-[12px] text-[#4A4A4A] hover:text-[#A0A0A0] transition-colors">
              <RotateCcw size={12} /> Try again
            </button>
          </div>
        )}
      </div>

      {/* Results chart */}
      {step === 'done' && totalCount > 0 && (
        <div className="mt-6 max-w-lg border border-[#1E1E1E] rounded-xl bg-[#0F0F0F] p-6">
          <p className="text-[13px] font-medium text-white mb-5">Results</p>
          <RingChart
            pct={Math.round((validCount / totalCount) * 100)}
            valid={validCount}
            invalid={totalCount - validCount}
          />
        </div>
      )}

      {/* Previous runs */}
      <div className="mt-8 max-w-lg">
        <p className="text-[13px] font-medium text-white mb-3">Previous Runs</p>
        {runs.length === 0 ? (
          <div className="border border-[#1E1E1E] rounded-xl bg-[#0F0F0F] px-5 py-8 text-center">
            <p className="text-[13px] text-[#4A4A4A]">No previous runs yet</p>
            <p className="text-[12px] text-[#3A3A3A] mt-1">Completed validations will appear here</p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map(run => {
              const validPct = run.total > 0 ? Math.round((run.valid_count / run.total) * 100) : 0
              const date = new Date(run.created_at)
              return (
                <div key={run.id} className="flex items-center justify-between gap-4 border border-[#1E1E1E] rounded-xl bg-[#0F0F0F] px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-white truncate">{run.file_name}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[11px] text-[#4A4A4A] flex items-center gap-1">
                        <Clock size={10} />
                        {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="text-[11px] text-[#4A4A4A]">{run.total.toLocaleString()} emails</span>
                      <span className="text-[11px] text-[#22c55e]">{validPct}% valid</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDownload(run)}
                    disabled={downloadingId === run.id}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#2A2A2A] text-[12px] text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-white transition-colors disabled:opacity-40"
                  >
                    <Download size={12} />
                    {downloadingId === run.id ? 'Getting link…' : 'Download'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
