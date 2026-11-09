'use client'

import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { jobKey } from '@/hooks/useJob'
import { sendJson } from '@/lib/validate/client'
import type { ValidationRowView } from '@/lib/validate/rows'
import { cn } from '@/lib/utils'

/**
 * The editor for one row still `pending` (before the validator reaches it),
 * shown in place of that row in the leads preview
 * (components/validate/ValidatedPreview.tsx), which replaced the old Leads table.
 */
export function RowEditor({ jobId, row, onDone, colSpan = 10 }: { jobId: string; row: ValidationRowView; onDone: () => void; colSpan?: number }) {
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
      <td colSpan={colSpan} className="px-[18px] py-3">
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
