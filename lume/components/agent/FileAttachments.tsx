'use client'

import { useCallback, useRef, useState } from 'react'
import { FileSpreadsheet, Loader2, X } from 'lucide-react'
import { fileChipLabel, type ChatFileRef } from '@/lib/agent/files'
import { uploadChatFile, type FileUploadDeps } from '@/lib/agent/fileClient'
import { formatFileSize, isSheetFile, MAX_SHEET_FILES, SHEET_ERRORS } from '@/lib/sheets/model'
import { cn } from '@/lib/utils'

/**
 * Spreadsheets attached in the Agent composer (.xlsx / .csv: paste, drop, or
 * the paperclip; up to 3 per message, separate from the 5 images). Each one
 * uploads and is parsed as soon as it is added; its chip shows a spinner,
 * then the sheet / row count. A refused file leaves no chip, only an inline
 * error naming it (.xls: "save as .xlsx").
 */

export interface FileItem {
  id: string
  name: string
  size: number
  status: 'working' | 'ready'
  ref?: ChatFileRef
}

export interface FileAttachments {
  items: FileItem[]
  refs: ChatFileRef[]
  pending: boolean
  error: string | null
  add: (files: File[]) => void
  remove: (id: string) => void
  clear: () => void
  take: () => FileItem[]
  restore: (taken: FileItem[]) => void
}

let seq = 0

export function useFileAttachments(deps?: FileUploadDeps): FileAttachments {
  const [items, setItems] = useState<FileItem[]>([])
  const [errors, setErrors] = useState<{ id?: string; text: string }[]>([])
  const itemsRef = useRef<FileItem[]>([])
  const commit = useCallback((fn: (xs: FileItem[]) => FileItem[]) => {
    itemsRef.current = fn(itemsRef.current)
    setItems(itemsRef.current)
  }, [])

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return
      const room = MAX_SHEET_FILES - itemsRef.current.length
      const taken = files.slice(0, Math.max(0, room))
      const fresh = taken.map((f) => ({ id: `file${Date.now().toString(36)}${(seq++).toString(36)}`, name: f.name || 'spreadsheet', size: f.size, status: 'working' as const }))
      commit((xs) => [...xs, ...fresh])
      setErrors(files.length > room ? [{ text: `${SHEET_ERRORS.too_many}.` }] : [])
      taken.forEach(async (file, i) => {
        const item = fresh[i]
        const up = await uploadChatFile(file, deps)
        if (!itemsRef.current.some((x) => x.id === item.id)) return // removed meanwhile
        if (!up.ok) {
          commit((xs) => xs.filter((x) => x.id !== item.id))
          setErrors((es) => [...es, { id: item.id, text: `${item.name} ${SHEET_ERRORS[up.error] ?? SHEET_ERRORS.upload}.` }])
          return
        }
        commit((xs) => xs.map((x) => (x.id === item.id ? { ...x, status: 'ready', ref: up.ref, name: up.ref.name } : x)))
      })
    },
    [commit, deps]
  )

  const remove = useCallback(
    (id: string) => {
      commit((xs) => xs.filter((x) => x.id !== id))
      setErrors((es) => es.filter((e) => e.id !== id))
    },
    [commit]
  )

  const clear = useCallback(() => {
    commit(() => [])
    setErrors([])
  }, [commit])

  const take = useCallback(() => {
    const taken = itemsRef.current
    commit(() => [])
    setErrors([])
    return taken
  }, [commit])

  const restore = useCallback(
    (taken: FileItem[]) => commit((xs) => [...taken.slice(0, Math.max(0, MAX_SHEET_FILES - xs.length)), ...xs]),
    [commit]
  )

  return {
    items,
    refs: items.flatMap((x) => (x.status === 'ready' && x.ref ? [x.ref] : [])),
    pending: items.some((x) => x.status === 'working'),
    error: errors.length ? errors.map((e) => e.text).join(' ') : null,
    add,
    remove,
    clear,
    take,
    restore,
  }
}

/** A drop / paste / pick split into spreadsheets and everything else (images, or a refusal from the image path). */
export function splitAttachments(files: File[]): { sheets: File[]; others: File[] } {
  const sheets: File[] = []
  const others: File[] = []
  for (const f of files) (isSheetFile(f) ? sheets : others).push(f)
  return { sheets, others }
}

function Chip({ name, detail, working, onRemove, disabled }: { name: string; detail: string; working: boolean; onRemove?: () => void; disabled?: boolean }) {
  return (
    <div className="glass relative flex h-16 max-w-[15rem] min-w-[10rem] items-center gap-2.5 rounded-xl border border-line py-2 pr-7 pl-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-positive/15 text-positive" aria-hidden>
        {working ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <FileSpreadsheet className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-medium text-fg" title={name}>
          {name}
        </span>
        <span className="block truncate text-[11px] text-fg-46">{detail}</span>
      </span>
      {working && (
        <span className="sr-only" role="status">
          Uploading {name}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${name}`}
          className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-line bg-background text-fg-70 transition-colors outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

/** Composer chips: name, size and, once parsed, the sheet / row count. */
export function FileChips({ items, onRemove, disabled }: { items: FileItem[]; onRemove: (id: string) => void; disabled?: boolean }) {
  if (!items.length) return null
  return (
    <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attached spreadsheets">
      {items.map((x) => (
        <li key={x.id}>
          <Chip
            name={x.name}
            working={x.status === 'working'}
            detail={x.ref ? `${formatFileSize(x.size)} · ${fileChipLabel(x.ref)}` : `${formatFileSize(x.size)} · reading…`}
            onRemove={() => onRemove(x.id)}
            disabled={disabled}
          />
        </li>
      ))}
    </ul>
  )
}

/** Chips on a sent (or reloaded) message bubble. */
export function MessageFileChips({ files, className }: { files: ChatFileRef[]; className?: string }) {
  if (!files.length) return null
  return (
    <ul className={cn('flex flex-wrap justify-end gap-2', className)} aria-label="Spreadsheets on this message">
      {files.map((f) => (
        <li key={f.id}>
          <Chip name={f.name} working={false} detail={`${formatFileSize(f.size_bytes)} · ${fileChipLabel(f)}`} />
        </li>
      ))}
    </ul>
  )
}
