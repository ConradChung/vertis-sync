'use client'

import { useId, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { Database, FileUp, Link2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { Input } from '@/components/ui/input'
import type { OrderKind } from '@/lib/db/types'
import { errorMessage, promptLine, pullApify, sendApolloLink, uploadCsvFile } from '@/lib/import/client'
import { MAX_CSV_BYTES } from '@/lib/import/csv'
import { parseApolloUrl } from '@/lib/import/messages'
import { cn } from '@/lib/utils'

type Status =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; text: string; gate?: string }
  | { state: 'error'; text: string }

export interface SourceCardsProps {
  /** A new intake exists: refresh the table and select it. */
  onCreated?: (order: { kind: OrderKind; id: string }) => void
}

/**
 * The three intakes. Each one only creates the intake (an ingest awaiting
 * approval, or an Apollo order awaiting its count); the decision is a gate,
 * in Telegram and Validate.
 */
export function SourceCards({ onCreated }: SourceCardsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <ApifyCard onCreated={onCreated} />
      <ApolloCard onCreated={onCreated} />
      <CsvCard onCreated={onCreated} />
    </div>
  )
}

function CardShell({ icon, title, sub, children, label }: { icon: ReactNode; title: string; sub: string; children: ReactNode; label: string }) {
  return (
    <GlassCard className="gap-3 px-[18px]" role="region" aria-label={label}>
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-violet/15 text-violet-soft" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
          <p className="text-[12px] text-fg-46">{sub}</p>
        </div>
      </div>
      {children}
    </GlassCard>
  )
}

function StatusLine({ status }: { status: Status }) {
  return (
    <p role="status" aria-live="polite" className="min-h-[18px] text-[12px]">
      {status.state === 'done' && (
        <span className="text-green">
          {status.text}{' '}
          {status.gate && (
            <Link href={`/validate?gate=${encodeURIComponent(status.gate)}`} className="text-violet-soft underline-offset-2 hover:text-fg hover:underline">
              Open in Validate →
            </Link>
          )}
        </span>
      )}
      {status.state === 'error' && <span className="text-amber">{status.text}</span>}
    </p>
  )
}

function Spinner() {
  return <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
}

// ---------------------------------------------------------------------------

function ApifyCard({ onCreated }: SourceCardsProps) {
  const [mode, setMode] = useState<'dataset' | 'actor'>('dataset')
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<Status>({ state: 'idle' })
  const inputId = useId()
  const busy = status.state === 'busy'
  const id = value.trim()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!id || busy) return
    setStatus({ state: 'busy' })
    const a = await pullApify(mode === 'dataset' ? { dataset_id: id } : { actor_id: id })
    if (a.status === 200 && a.body?.ok) {
      const cap = a.body.truncated ? ' (capped at 20,000 items)' : ''
      const skipped = a.body.skipped ? ` ${a.body.skipped.toLocaleString('en-US')} non-object items skipped.` : ''
      setStatus({
        state: 'done',
        text: `${a.body.row_count.toLocaleString('en-US')} rows${cap}.${skipped} ${promptLine(a.body.telegram)}`,
        gate: a.body.gate,
      })
      setValue('')
      onCreated?.({ kind: 'ingest', id: a.body.ingest_id })
    } else {
      setStatus({ state: 'error', text: errorMessage(a) })
    }
  }

  return (
    <CardShell icon={<Database className="size-4" />} title="Apify" sub="Pull a dataset, or an actor's last succeeded run." label="Apify intake">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <div role="radiogroup" aria-label="Apify source" className="flex gap-1 self-start rounded-[10px] border border-line p-0.5 text-[12px]">
          {(['dataset', 'actor'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-[8px] px-2.5 py-1 transition-colors',
                mode === m ? 'bg-accent text-fg' : 'text-fg-46 hover:text-fg'
              )}
            >
              {m === 'dataset' ? 'Dataset ID' : 'Actor ID'}
            </button>
          ))}
        </div>
        <label htmlFor={inputId} className="sr-only">
          {mode === 'dataset' ? 'Apify dataset ID' : 'Apify actor ID'}
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={mode === 'dataset' ? 'e.g. hLx2Q8k1sTn5vCzE3' : 'e.g. username~actor-name'}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[12px]"
            disabled={busy}
          />
          <Button type="submit" disabled={!id || busy} aria-busy={busy || undefined}>
            {busy ? <Spinner /> : null}
            Pull
          </Button>
        </div>
      </form>
      <StatusLine status={status} />
    </CardShell>
  )
}

// ---------------------------------------------------------------------------

function ApolloCard({ onCreated }: SourceCardsProps) {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<Status>({ state: 'idle' })
  const inputId = useId()
  const busy = status.state === 'busy'
  const valid = parseApolloUrl(url) !== null
  const showHint = url.trim() !== '' && !valid

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setStatus({ state: 'busy' })
    const a = await sendApolloLink(url.trim())
    if (a.status === 200 && a.body?.ok) {
      setStatus({ state: 'done', text: 'Sent to scraper, waiting on count — pick it in the order panel.' })
      setUrl('')
      onCreated?.({ kind: 'apollo_order', id: a.body.order_id })
    } else {
      setStatus({ state: 'error', text: errorMessage(a) })
    }
  }

  return (
    <CardShell icon={<Link2 className="size-4" />} title="Apollo link" sub="A people search → Leadsfriday export. Nothing is spent until you pick a count." label="Apollo link intake">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-[11px] text-fg-46">
          Apollo people search URL
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://app.apollo.io/#/people?…"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={showHint || undefined}
            className="font-mono text-[12px]"
            disabled={busy}
          />
          <Button type="submit" disabled={!valid || busy} aria-busy={busy || undefined}>
            {busy ? <Spinner /> : null}
            Pull
          </Button>
        </div>
        {showHint && <p className="text-[11px] text-fg-46">Needs to start with https://app.apollo.io/#/people?</p>}
      </form>
      <StatusLine status={status} />
    </CardShell>
  )
}

// ---------------------------------------------------------------------------

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`

function CsvCard({ onCreated }: SourceCardsProps) {
  const [status, setStatus] = useState<Status>({ state: 'idle' })
  const [over, setOver] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = status.state === 'busy'

  async function send(f: File) {
    if (busy) return
    setFile(f)
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setStatus({ state: 'error', text: 'Only .csv files.' })
      return
    }
    if (f.size > MAX_CSV_BYTES) {
      setStatus({ state: 'error', text: `${mb(f.size)} — over the 20 MB limit.` })
      return
    }
    setStatus({ state: 'busy' })
    const a = await uploadCsvFile(f)
    if (a.status === 200 && a.body?.ok) {
      setStatus({ state: 'done', text: `${a.body.row_count.toLocaleString('en-US')} rows. ${promptLine(a.body.telegram)}`, gate: a.body.gate })
      onCreated?.({ kind: 'ingest', id: a.body.ingest_id })
    } else {
      setStatus({ state: 'error', text: errorMessage(a) })
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) void send(f)
  }

  return (
    <CardShell icon={<FileUp className="size-4" />} title="CSV" sub="Up to 20 MB. Goes to the same Approve / Deny prompt as a file sent to the bot." label="CSV intake">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setOver(true)
        }}
        onDragLeave={(e) => {
          // Moving onto a child fires dragleave on the zone; ignore it.
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
          setOver(false)
        }}
        onDrop={onDrop}
        data-over={over || undefined}
        aria-busy={busy || undefined}
        className={cn(
          'flex flex-col items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-line px-3 py-5 text-center text-[12px] text-fg-46 transition-colors',
          over && 'border-violet bg-violet/10 text-fg',
          busy && 'cursor-not-allowed'
        )}
      >
        {busy ? (
          <span className="flex items-center gap-2 text-fg-70">
            <Spinner /> Uploading {file?.name}…
          </span>
        ) : (
          <>
            <span>Drop a .csv here</span>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              aria-label="Browse for a CSV file"
              className="text-violet-soft underline-offset-2 hover:text-fg hover:underline"
            >
              or browse
            </button>
            {file && status.state !== 'idle' && (
              <span className="max-w-full truncate font-mono text-[11px] text-fg-24">
                {file.name} · {mb(file.size)}
              </span>
            )}
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-testid="csv-input"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void send(f)
          }}
        />
      </div>
      <StatusLine status={status} />
    </CardShell>
  )
}
