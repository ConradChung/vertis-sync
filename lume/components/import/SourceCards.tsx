'use client'

import { useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { Database, FileUp, Link2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { Input } from '@/components/ui/input'
import type { OrderKind } from '@/lib/db/types'
import { errorMessage, importXlsxSheet, promptLine, pullApify, sendApolloLink, uploadCsvFile, type IngestAnswer } from '@/lib/import/client'
import type { ApiAnswer } from '@/lib/validate/client'
import { uploadChatFile } from '@/lib/agent/fileClient'
import type { ChatFileRef } from '@/lib/agent/files'
import { MAX_SHEET_FILE_BYTES, SHEET_ERRORS, sheetExt, type SheetMeta } from '@/lib/sheets/model'
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
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-(--glass-border) bg-(--glass-fill) text-foreground" aria-hidden>
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
  const inputId = 'import-apify-id'
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
        <div role="radiogroup" aria-label="Apify source" className="flex gap-1 self-start rounded-lg border border-line p-0.5 text-[12px]">
          {(['dataset', 'actor'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md px-2.5 py-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
  const inputId = 'import-apollo-url'
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

/** A workbook with several sheets that have rows: the owner picks one. */
interface SheetChoice {
  ref: ChatFileRef
  sheets: SheetMeta[]
  picked: string
}

const sheetLabel = (s: SheetMeta) => `${s.name} · ${s.rows.toLocaleString('en-US')} row${s.rows === 1 ? '' : 's'}${s.hidden ? ' (hidden)' : ''}`

function CsvCard({ onCreated }: SourceCardsProps) {
  const [status, setStatus] = useState<Status>({ state: 'idle' })
  const [over, setOver] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [choice, setChoice] = useState<SheetChoice | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = status.state === 'busy'

  const done = (a: ApiAnswer<IngestAnswer>) => {
    if (a.status === 200 && a.body?.ok) {
      setStatus({ state: 'done', text: `${a.body.row_count.toLocaleString('en-US')} rows. ${promptLine(a.body.telegram)}`, gate: a.body.gate })
      onCreated?.({ kind: 'ingest', id: a.body.ingest_id })
    } else {
      setStatus({ state: 'error', text: errorMessage(a) })
    }
  }

  async function importSheet(ref: ChatFileRef, sheet: string) {
    setChoice(null)
    setStatus({ state: 'busy' })
    done(await importXlsxSheet(ref.id, sheet))
  }

  async function send(f: File) {
    if (busy) return
    setFile(f)
    setChoice(null)
    const ext = sheetExt(f.name)
    if (ext === 'xls') {
      setStatus({ state: 'error', text: 'Old .xls workbook — open it in Excel or Numbers and save as .xlsx.' })
      return
    }
    if (ext !== 'csv' && ext !== 'xlsx') {
      setStatus({ state: 'error', text: 'Only .csv or .xlsx files.' })
      return
    }
    const cap = ext === 'xlsx' ? MAX_SHEET_FILE_BYTES : MAX_CSV_BYTES
    if (f.size > cap) {
      setStatus({ state: 'error', text: `${mb(f.size)} — over the ${ext === 'xlsx' ? '10' : '20'} MB limit.` })
      return
    }
    setStatus({ state: 'busy' })
    if (ext === 'csv') {
      done(await uploadCsvFile(f))
    } else {
      // Parsed server side (magic bytes, zip-bomb caps); then the chosen sheet goes in as CSV.
      const up = await uploadChatFile(f)
      if (!up.ok) {
        setStatus({ state: 'error', text: `${f.name} ${SHEET_ERRORS[up.error] ?? SHEET_ERRORS.upload}.` })
      } else {
        const usable = up.ref.sheets.filter((s) => s.rows > 0)
        if (!usable.length) setStatus({ state: 'error', text: 'No sheet in that workbook has data rows.' })
        else if (usable.length === 1) await importSheet(up.ref, usable[0].name)
        else {
          setChoice({ ref: up.ref, sheets: usable, picked: (usable.find((s) => !s.hidden) ?? usable[0]).name })
          setStatus({ state: 'idle' })
        }
      }
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
    <CardShell
      icon={<FileUp className="size-4" />}
      title="CSV / Excel"
      sub="A .csv (up to 20 MB) or .xlsx (up to 10 MB, pick a sheet). Goes to the same Approve / Deny prompt as a file sent to the bot."
      label="CSV intake"
    >
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
          'flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line px-3 py-5 text-center text-[12px] text-fg-46 transition-colors',
          over && 'border-primary bg-accent text-fg',
          busy && 'cursor-not-allowed'
        )}
      >
        {busy ? (
          <span className="flex items-center gap-2 text-fg-70">
            <Spinner /> Uploading {file?.name}…
          </span>
        ) : choice ? (
          <form
            className="flex w-full flex-col items-stretch gap-2 text-left"
            aria-label="Pick a sheet"
            onSubmit={(e) => {
              e.preventDefault()
              void importSheet(choice.ref, choice.picked)
            }}
          >
            <label htmlFor="xlsx-sheet" className="text-[12px] text-fg-70">
              {choice.ref.name} has {choice.sheets.length} sheets with rows. Which one?
            </label>
            <select
              id="xlsx-sheet"
              value={choice.picked}
              onChange={(e) => setChoice({ ...choice, picked: e.target.value })}
              className="h-8 rounded-control border border-line bg-background px-2 text-[12.5px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {choice.sheets.map((s) => (
                <option key={s.name} value={s.name}>
                  {sheetLabel(s)}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm">
                Import sheet
              </Button>
              <button type="button" onClick={() => setChoice(null)} className="text-[12px] text-fg-46 hover:text-fg">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <span>Drop a .csv or .xlsx here</span>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              aria-label="Browse for a CSV or Excel file"
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
          accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
