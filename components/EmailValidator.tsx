'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Upload, RotateCcw, CheckCircle2, Download, Clock, Clipboard, ClipboardCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface ValidationRun {
  id: string
  filename: string
  total_rows: number
  valid_count: number
  invalid_count: number
  processed_rows: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  error_message: string | null
  storage_path: string | null
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
          <span className="text-[var(--text-primary)] text-xl font-semibold tabular-nums leading-none">{pct}%</span>
          <span className="text-[10px] text-[var(--text-placeholder)] mt-0.5">valid</span>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-8">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#22c55e]" />
            <span className="text-[13px] text-[var(--text-secondary)]">Valid</span>
          </div>
          <span className="text-[13px] text-[var(--text-primary)] tabular-nums font-medium">{valid.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-8">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#ef4444]" />
            <span className="text-[13px] text-[var(--text-secondary)]">Invalid</span>
          </div>
          <span className="text-[13px] text-[var(--text-primary)] tabular-nums font-medium">{invalid.toLocaleString()}</span>
        </div>
        <div className="border-t border-[var(--border)] pt-3 flex items-center justify-between gap-8">
          <span className="text-[13px] text-[var(--text-secondary)]">Total</span>
          <span className="text-[13px] text-[var(--text-primary)] tabular-nums font-medium">{(valid + invalid).toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

interface Props {
  onStatusChange?: (status: { step: Step; processed: number; total: number } | null) => void
}

export default function EmailValidator({ onStatusChange }: Props) {
  const [step, setStep] = useState<Step>('upload')
  const [ambiguousColumns, setAmbiguousColumns] = useState<string[]>([])
  const [error, setError] = useState<string>('')
  const [progress, setProgress] = useState<Progress>({ processed: 0, total: 0 })
  const fileRef = useRef<File | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [validCount, setValidCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [runs, setRuns] = useState<ValidationRun[]>([])
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [validCsv, setValidCsv] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    if (step === 'processing') {
      onStatusChange?.({ step, processed: progress.processed, total: progress.total })
    } else {
      onStatusChange?.(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, progress.processed, progress.total])

  // Clear polling interval on unmount
  useEffect(() => {
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  }, [])

  const loadRuns = useCallback(async () => {
    const { data } = await supabase
      .from('validation_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)
    if (data) setRuns(data as ValidationRun[])
  }, [supabase])

  useEffect(() => { loadRuns() }, [loadRuns])

  async function handleDownload(run: ValidationRun) {
    setDownloadingId(run.id)

    if (run.storage_path) {
      const { data, error: urlError } = await supabase.storage
        .from('validation-results')
        .createSignedUrl(run.storage_path, 3600)
      setDownloadingId(null)
      if (urlError || !data?.signedUrl) return
      const a = document.createElement('a')
      a.href = data.signedUrl
      a.download = run.filename.replace(/\.csv$/i, '') + '_validated.csv'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } else {
      try {
        const res = await fetch(`/api/validate/results?job_id=${run.id}`)
        setDownloadingId(null)
        if (!res.ok) return
        const csv = await res.text()
        const blob = new Blob([csv], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = run.filename.replace(/\.csv$/i, '') + '_validated.csv'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } catch {
        setDownloadingId(null)
      }
    }
  }

  async function submit(file: File, column?: string) {
    setStep('processing')
    setProgress({ processed: 0, total: 0 })
    setError('')
    setValidCount(0)
    setTotalCount(0)

    const formData = new FormData()
    formData.append('file', file)
    if (column) formData.append('column', column)

    try {
      const res = await fetch('/api/validate/start', { method: 'POST', body: formData })
      const json = await res.json()

      if (json.status === 'ambiguous') {
        setAmbiguousColumns(json.columns)
        setStep('ambiguous')
        return
      }
      if (json.error) {
        setError(json.error)
        setStep('error')
        return
      }

      const { job_id, total } = json
      jobIdRef.current = job_id
      setProgress({ processed: 0, total })

      // Poll status endpoint every 2s
      pollingRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/validate/status?job_id=${job_id}`)
          const poll = await pollRes.json()

          setProgress({ processed: poll.processed_rows ?? 0, total: poll.total_rows })
          setValidCount(poll.valid_count ?? 0)
          setTotalCount(poll.total_rows)

          if (poll.status === 'completed') {
            clearInterval(pollingRef.current!)
            pollingRef.current = null

            if (poll.storage_path) {
              // Fetch via signed URL
              const { data } = await supabase.storage
                .from('validation-results')
                .createSignedUrl(poll.storage_path, 3600)
              if (data?.signedUrl) {
                const csvRes = await fetch(data.signedUrl)
                setValidCsv(await csvRes.text())
              }
            } else {
              // Fetch from results API
              const csvRes = await fetch(`/api/validate/results?job_id=${job_id}`)
              setValidCsv(await csvRes.text())
            }

            setStep('done')
            loadRuns()
          } else if (poll.status === 'failed') {
            clearInterval(pollingRef.current!)
            pollingRef.current = null
            setError(poll.error_message || 'Validation failed in Edge Function.')
            setStep('error')
          }
        } catch {
          // transient poll error — keep retrying
        }
      }, 2000)
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

  function csvToTsv(csv: string): string {
    return csv.split('\r\n').map(row => {
      // Simple CSV→TSV: replace comma delimiters with tabs (handles quoted fields)
      const fields: string[] = []
      let cur = '', inQ = false
      for (let i = 0; i < row.length; i++) {
        if (row[i] === '"') { inQ = !inQ }
        else if (row[i] === ',' && !inQ) { fields.push(cur); cur = '' }
        else { cur += row[i] }
      }
      fields.push(cur)
      return fields.join('\t')
    }).join('\n')
  }

  function downloadCurrent() {
    if (!validCsv) return
    const blob = new Blob([validCsv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'validated_emails.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function copyForClay() {
    if (!validCsv) return
    await navigator.clipboard.writeText(csvToTsv(validCsv))
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  async function copyRunForClay(run: ValidationRun) {
    setCopyingId(run.id)
    let csv = ''

    if (run.storage_path) {
      const { data } = await supabase.storage
        .from('validation-results')
        .createSignedUrl(run.storage_path, 60)
      if (!data?.signedUrl) { setCopyingId(null); return }
      const res = await fetch(data.signedUrl)
      csv = await res.text()
    } else {
      const res = await fetch(`/api/validate/results?job_id=${run.id}`)
      if (!res.ok) { setCopyingId(null); return }
      csv = await res.text()
    }

    await navigator.clipboard.writeText(csvToTsv(csv))
    setCopyingId(null)
    setCopiedId(run.id)
    setTimeout(() => setCopiedId(null), 2500)
  }

  function reset() {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null }
    jobIdRef.current = null
    setStep('upload')
    setAmbiguousColumns([])
    setError('')
    setProgress({ processed: 0, total: 0 })
    setValidCount(0)
    setTotalCount(0)
    setFileName('')
    setValidCsv('')
    setCopied(false)
    fileRef.current = null
  }

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-lg font-medium text-[var(--text-primary)] mb-1">Email Validator</h2>
        <p className="text-[13px] text-[var(--text-secondary)]">
          Upload a CSV to validate each email address and download the enriched file.
        </p>
      </div>

      <div className="max-w-lg space-y-3">
        {step === 'upload' && (
          <form onSubmit={handleUpload} className="space-y-3">
            <label className="flex flex-col items-center justify-center gap-3 border border-dashed border-[var(--border)] rounded-xl bg-[var(--surface-raised)] px-6 py-10 cursor-pointer hover:border-[var(--border)] hover:bg-[var(--surface-raised)] transition-colors group">
              <div className="w-10 h-10 rounded-full bg-[var(--border-subtle)] border border-[var(--border)] flex items-center justify-center group-hover:border-[var(--border)] transition-colors">
                <Upload size={18} className="text-[var(--text-secondary)]" />
              </div>
              <div className="text-center">
                <p className="text-[13px] text-[var(--text-primary)] font-medium">
                  {fileName ? fileName : 'Choose a CSV file'}
                </p>
                <p className="text-[12px] text-[var(--text-placeholder)] mt-0.5">
                  {fileName ? 'Click to change' : 'or drag and drop here'}
                </p>
              </div>
              <input type="file" name="csv" accept=".csv" required className="sr-only" onChange={handleFileChange} />
            </label>
            <Button type="submit" className="w-full rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90 font-medium text-[13px] h-10">
              Validate Emails
            </Button>
          </form>
        )}

        {step === 'ambiguous' && (
          <div className="space-y-3">
            <div className="border border-[var(--border)] rounded-xl bg-[var(--surface-raised)] p-5">
              <p className="text-[13px] text-[var(--text-primary)] font-medium mb-1">Multiple email columns found</p>
              <p className="text-[12px] text-[var(--text-secondary)] mb-4">Which column should we validate?</p>
              <div className="space-y-2">
                {ambiguousColumns.map(col => (
                  <button key={col} onClick={() => handleColumnSelect(col)}
                    className="w-full text-left px-4 py-2.5 border border-[var(--border)] rounded-lg text-[13px] text-[var(--text-secondary)] hover:border-[var(--border)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-raised)] transition-colors">
                    {col}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={reset} className="flex items-center gap-1.5 text-[12px] text-[var(--text-placeholder)] hover:text-[var(--text-secondary)] transition-colors">
              <RotateCcw size={12} /> Upload a different file
            </button>
          </div>
        )}

        {step === 'processing' && (
          <div className="border border-[var(--border)] rounded-xl bg-[var(--surface-raised)] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[var(--text-secondary)]">Validating emails…</span>
              <span className="text-[13px] text-[var(--text-primary)] tabular-nums font-medium">
                {progress.total > 0 ? `${progress.processed} / ${progress.total}` : '—'}
              </span>
            </div>
            <div className="h-1 bg-[#1E1E1E] rounded-full overflow-hidden">
              <div className="h-full bg-white rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11px] text-[var(--text-placeholder)]">
              {progress.total > 0 ? `${pct}% complete — running on Supabase Edge Function, safe to close this tab` : 'Queued — waiting for Supabase Edge Function to start…'}
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="border border-[var(--border)] rounded-xl bg-[var(--surface-raised)] p-6 flex flex-col items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#22c55e]/10 flex items-center justify-center">
              <CheckCircle2 size={20} className="text-[#22c55e]" />
            </div>
            <div className="text-center">
              <p className="text-[13px] text-[var(--text-primary)] font-medium">Validation complete</p>
              <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">Ready to download</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={downloadCurrent}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-[13px] font-medium hover:opacity-90 transition-colors"
              >
                <Download size={14} />
                Download CSV
              </button>
              <button
                onClick={copyForClay}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--border)] text-[13px] font-medium text-[var(--text-primary)] hover:border-[var(--border)] hover:bg-[var(--surface-raised)] transition-colors"
              >
                {copied ? <ClipboardCheck size={14} className="text-[#22c55e]" /> : <Clipboard size={14} />}
                {copied ? 'Copied!' : 'Copy for Clay'}
              </button>
            </div>
            <Button variant="ghost" size="sm" onClick={reset}
              className="text-[12px] text-[var(--text-placeholder)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] rounded-lg">
              <RotateCcw size={12} className="mr-1.5" /> Validate another file
            </Button>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-3">
            <div className="border border-red-500/20 bg-red-500/5 rounded-xl p-5">
              <p className="text-[13px] text-red-400">{error}</p>
            </div>
            <button onClick={reset} className="flex items-center gap-1.5 text-[12px] text-[var(--text-placeholder)] hover:text-[var(--text-secondary)] transition-colors">
              <RotateCcw size={12} /> Try again
            </button>
          </div>
        )}
      </div>

      {/* Results chart */}
      {step === 'done' && totalCount > 0 && (
        <div className="mt-6 max-w-lg border border-[var(--border)] rounded-xl bg-[var(--surface-raised)] p-6">
          <p className="text-[13px] font-medium text-[var(--text-primary)] mb-5">Results</p>
          <RingChart
            pct={Math.round((validCount / totalCount) * 100)}
            valid={validCount}
            invalid={totalCount - validCount}
          />
        </div>
      )}

      {/* Previous runs */}
      <div className="mt-8 max-w-lg">
        <p className="text-[13px] font-medium text-[var(--text-primary)] mb-3">Previous Runs</p>
        {runs.length === 0 ? (
          <div className="border border-[var(--border)] rounded-xl bg-[var(--surface-raised)] px-5 py-8 text-center">
            <p className="text-[13px] text-[var(--text-placeholder)]">No previous runs yet</p>
            <p className="text-[12px] text-[var(--text-tertiary)] mt-1">Completed validations will appear here</p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map(run => {
              const validPct = run.total_rows > 0 ? Math.round((run.valid_count / run.total_rows) * 100) : 0
              const date = new Date(run.created_at)
              const isCompleted = run.status === 'completed'
              return (
                <div key={run.id} className="flex items-center justify-between gap-4 border border-[var(--border)] rounded-xl bg-[var(--surface-raised)] px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] text-[var(--text-primary)] truncate">{run.filename}</p>
                      {run.status === 'processing' && (
                        <span className="flex items-center gap-1 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                          <span className="text-[11px] text-amber-400">Validating…</span>
                        </span>
                      )}
                      {run.status === 'pending' && (
                        <span className="flex items-center gap-1 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-placeholder)]" />
                          <span className="text-[11px] text-[var(--text-placeholder)]">Queued</span>
                        </span>
                      )}
                      {run.status === 'failed' && (
                        <span className="flex items-center gap-1 shrink-0" title={run.error_message ?? ''}>
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                          <span className="text-[11px] text-red-400">Failed</span>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[11px] text-[var(--text-placeholder)] flex items-center gap-1">
                        <Clock size={10} />
                        {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="text-[11px] text-[var(--text-placeholder)]">{run.total_rows.toLocaleString()} emails</span>
                      {isCompleted && <span className="text-[11px] text-[#22c55e]">{validPct}% valid</span>}
                    </div>
                    {run.status === 'failed' && run.error_message && (
                      <p className="text-[11px] text-red-400/70 mt-0.5 truncate">{run.error_message}</p>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      onClick={() => copyRunForClay(run)}
                      disabled={!isCompleted || copyingId === run.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-[12px] text-[var(--text-secondary)] hover:border-[var(--border)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {copiedId === run.id ? <ClipboardCheck size={12} className="text-[#22c55e]" /> : <Clipboard size={12} />}
                      {copyingId === run.id ? 'Copying…' : copiedId === run.id ? 'Copied!' : 'Copy for Clay'}
                    </button>
                    <button
                      onClick={() => handleDownload(run)}
                      disabled={!isCompleted || downloadingId === run.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-[12px] text-[var(--text-secondary)] hover:border-[var(--border)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Download size={12} />
                      {downloadingId === run.id ? 'Getting link…' : 'Download'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
