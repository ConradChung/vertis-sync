'use client'

import { useState } from 'react'
import { uploadCsvFile } from '@/lib/import/client'

/**
 * The one scripted control on /operator: a CSV goes browser → Storage through
 * the Import screen's own three-step path (`uploadCsvFile`: sign, upload,
 * ingest), so the file never passes through a Vercel function. The result is
 * an ingest waiting at the usual Approve / Deny gate (Needs confirmation).
 */
export function CsvUploadForm() {
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = e.currentTarget.elements.namedItem('csv') as HTMLInputElement | null
    const file = input?.files?.[0]
    if (!file) {
      setStatus('Choose a .csv file first.')
      return
    }
    setBusy(true)
    setStatus(`Uploading ${file.name}…`)
    const r = await uploadCsvFile(file)
    setBusy(false)
    if (r.status === 200 && r.body) {
      setStatus(`Uploaded ${file.name}: ${r.body.row_count} rows, email column ${r.body.email_column ?? 'not detected'}. Reload this page; it is now under Needs confirmation.`)
    } else {
      const err = (r.body as unknown as { error?: string } | null)?.error
      setStatus(`Upload failed: ${err ?? `HTTP ${r.status}`}`)
    }
  }

  return (
    <form id="csv-upload" onSubmit={onSubmit}>
      <label htmlFor="csv-file">CSV file</label> <input id="csv-file" name="csv" type="file" accept=".csv,text/csv" />{' '}
      <button type="submit" disabled={busy}>
        Upload CSV
      </button>
      <p role="status" id="csv-upload-status">
        {status}
      </p>
    </form>
  )
}
