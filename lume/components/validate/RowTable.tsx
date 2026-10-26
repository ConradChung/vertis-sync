'use client'

import { useEffect, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { jobKey, useJobRows } from '@/hooks/useJob'
import { sendJson } from '@/lib/validate/client'
import type { ValidationRowView } from '@/lib/validate/rows'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

const STATUS_PILL: Record<string, string> = {
  valid: 'bg-lime/10 text-lime',
  invalid: 'bg-destructive/15 text-destructive',
  error: 'bg-destructive/15 text-destructive',
  no_email: 'bg-white/8 text-fg-46',
  pending: 'bg-white/10 text-white/70',
}

const name = (r: ValidationRowView) => [r.first_name, r.last_name].filter(Boolean).join(' ') || '—'

/**
 * Per-lead rows of a validation job, 100 at a time in `row_index` order.
 * Only rows still `pending` can be edited (before the validator reaches
 * them); `E` opens the editor on the first pending row of the page.
 */
export function RowTable({ jobId, editRequest = 0 }: { jobId: string; editRequest?: number }) {
  const [page, setPage] = useState(0)
  const { data, error, mutate } = useJobRows(jobId, page)
  const [editing, setEditing] = useState<string | null>(null)
  const lastRequest = useRef(editRequest)

  useEffect(() => {
    setPage(0)
    setEditing(null)
  }, [jobId])

  useEffect(() => {
    if (editRequest === lastRequest.current) return
    lastRequest.current = editRequest
    if (!data) return
    if (!data.editable) return void toast.info('Editing is off for this job', { description: data.edit_block_reason ?? undefined })
    const first = data.rows.find((r) => r.status === 'pending')
    if (first) setEditing(first.id)
    else toast.info('No pending rows on this page', { description: 'Only rows the validator has not reached can be edited.' })
  }, [editRequest, data])

  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / (data?.pageSize ?? 100)))
  const from = total === 0 ? 0 : page * (data?.pageSize ?? 100) + 1
  const to = Math.min(total, (page + 1) * (data?.pageSize ?? 100))

  return (
    <section className="surface overflow-hidden rounded-panel" aria-label="Leads in this job">
      <SectionTitle title="Leads">
        <span className="font-mono tabular-nums">
          {fmt.format(from)}–{fmt.format(to)} of {fmt.format(total)}
        </span>
        <Button size="xs" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          Prev
        </Button>
        <Button size="xs" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
          Next
        </Button>
      </SectionTitle>
      {data && !data.editable && data.edit_block_reason && (
        <p className="px-[18px] pb-2 text-[11px] text-fg-46">Editing off — {data.edit_block_reason}</p>
      )}
      {!data && error ? (
        <p className="flex items-center gap-3 px-[18px] pb-[18px] text-[12px] text-fg-70" role="alert">
          Couldn&apos;t load rows.
          <button type="button" className="text-violet-soft hover:text-fg" onClick={() => void mutate()}>
            Retry
          </button>
        </p>
      ) : !data ? (
        <div className="flex flex-col gap-2 px-[18px] pb-[18px]" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <ShimmerBar key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <p className="px-[18px] pb-[18px] text-[13px] text-fg-46">No rows in this job.</p>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-left text-[10px] tracking-[.7px] text-fg-24 uppercase">
                {['#', 'Name', 'Company', 'Email', 'Verdict', 'Reason', 'ICP', 'Enrich', 'Instantly', ''].map((h, i) => (
                  <th key={i} scope="col" className="border-b border-line px-3 py-2.5 font-medium first:pl-[18px]">
                    {h || <span className="sr-only">Edit</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) =>
                editing === r.id ? (
                  <RowEditor
                    key={r.id}
                    jobId={jobId}
                    row={r}
                    onDone={() => {
                      setEditing(null)
                      void mutate()
                    }}
                  />
                ) : (
                  <tr key={r.id} className="border-b border-white/6 text-fg-70 last:border-b-0">
                    <td className="px-3 py-2.5 pl-[18px] font-mono text-fg-24 tabular-nums">{r.row_index}</td>
                    <td className="max-w-[160px] truncate px-3 py-2.5 text-fg">{name(r)}</td>
                    <td className="max-w-[160px] truncate px-3 py-2.5">{r.company_name ?? '—'}</td>
                    <td className="max-w-[200px] truncate px-3 py-2.5 font-mono text-[11px]">{r.email ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <span className={cn('rounded-[5px] px-[7px] py-[3px] text-[10px]', STATUS_PILL[r.status] ?? 'bg-white/8 text-fg-46')}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2.5 text-fg-46" title={r.message ?? undefined}>
                      {r.message ?? ''}
                    </td>
                    <td className="px-3 py-2.5 text-fg-46">{r.icp_status ?? ''}</td>
                    <td className="px-3 py-2.5 text-fg-46">{r.enrichment_status ?? ''}</td>
                    <td className="px-3 py-2.5 text-fg-46">{r.instantly_status ?? ''}</td>
                    <td className="px-3 py-2.5 pr-[18px] text-right">
                      {r.status === 'pending' && data.editable && (
                        <Button size="icon-xs" variant="ghost" aria-label={`Edit row ${r.row_index}`} onClick={() => setEditing(r.id)}>
                          <Pencil />
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RowEditor({ jobId, row, onDone }: { jobId: string; row: ValidationRowView; onDone: () => void }) {
  const { mutate } = useSWRConfig()
  const [form, setForm] = useState({
    first_name: row.first_name ?? '',
    last_name: row.last_name ?? '',
    company_name: row.company_name ?? '',
    email: row.email ?? '',
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    const patch: Record<string, string | null> = {}
    for (const f of ['first_name', 'last_name', 'company_name'] as const) {
      if (form[f] !== (row[f] ?? '')) patch[row.name_keys[f]] = form[f].trim() || null
    }
    const email = form.email.trim()
    const body: Record<string, unknown> = { row_id: row.id }
    if (Object.keys(patch).length) body.row_data_patch = patch
    if (email && email !== row.email) body.email = email
    if (Object.keys(body).length === 1) return onDone()
    setSaving(true)
    const r = await sendJson(`/api/jobs/${jobId}/rows`, body, { method: 'PATCH' })
    setSaving(false)
    if (r.status === 200) toast.success(`Row ${row.row_index} saved`)
    else if (r.status === 409 && (r.body as { error?: string } | null)?.error === 'job_running')
      toast.info('The validator has started — rows are locked')
    else if (r.status === 409) toast.info('That row was already validated — refreshed')
    else if (r.status === 400) return void toast.error('Check the email address')
    else toast.error("Couldn't save the row")
    void mutate(jobKey(jobId))
    onDone()
  }

  const field = (key: keyof typeof form, label: string, cls: string) => (
    <label className={cn('flex flex-col gap-1', cls)}>
      <span className="text-[10px] text-fg-46">{label}</span>
      <Input
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        className="h-7 text-[12px]"
        autoFocus={key === 'first_name'}
      />
    </label>
  )

  return (
    <tr className="border-b border-white/6 bg-accent/40">
      <td colSpan={10} className="px-[18px] py-3">
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={`Edit row ${row.row_index}`}
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onDone()
          }}
        >
          <span className="mr-1 self-center font-mono text-[11px] text-fg-24">#{row.row_index}</span>
          {field('first_name', 'First name', 'w-32')}
          {field('last_name', 'Last name', 'w-32')}
          {field('company_name', 'Company', 'w-44')}
          {field('email', 'Email', 'w-56')}
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <span className="basis-full text-[10px] text-fg-46">Pending rows only — the validator has not checked this one yet. Logged to the feed.</span>
        </form>
      </td>
    </tr>
  )
}
