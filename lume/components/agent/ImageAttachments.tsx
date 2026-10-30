'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Paperclip, X } from 'lucide-react'
import { ACCEPTED_IMAGE_TYPES, IMAGE_ERRORS, MAX_IMAGES, type ChatImageRef } from '@/lib/agent/images'
import { prepareImage, uploadChatImage, type ImageCodec } from '@/lib/agent/imageClient'
import { cn } from '@/lib/utils'

/**
 * Images attached in the Agent composer (paste, drop, or the paperclip).
 * Each one is shrunk and uploaded as soon as it is added, so Send only waits
 * for the run; a chip shows a spinner until its upload lands. A refused file
 * leaves no chip, only an inline error naming it.
 */

export interface Attachment {
  id: string
  name: string
  /** Local object URL for the chip. */
  preview: string
  status: 'working' | 'ready'
  ref?: ChatImageRef
}

export interface ImageAttachments {
  items: Attachment[]
  /** Uploaded references, in the order they were added. */
  refs: ChatImageRef[]
  /** An image is still being shrunk or uploaded. */
  pending: boolean
  error: string | null
  add: (files: File[]) => void
  remove: (id: string) => void
  clear: () => void
}

let seq = 0

export function useImageAttachments(codec?: ImageCodec): ImageAttachments {
  const [items, setItems] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const itemsRef = useRef<Attachment[]>([])
  const commit = useCallback((fn: (xs: Attachment[]) => Attachment[]) => {
    itemsRef.current = fn(itemsRef.current)
    setItems(itemsRef.current)
  }, [])

  // Object URLs are released when a chip goes away and on unmount.
  useEffect(() => () => itemsRef.current.forEach((a) => URL.revokeObjectURL(a.preview)), [])

  const drop = useCallback(
    (id: string) => {
      const gone = itemsRef.current.find((a) => a.id === id)
      if (gone) URL.revokeObjectURL(gone.preview)
      commit((xs) => xs.filter((a) => a.id !== id))
    },
    [commit]
  )

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return
      const room = MAX_IMAGES - itemsRef.current.length
      const errors: string[] = []
      if (files.length > room) errors.push(`${IMAGE_ERRORS.too_many}.`)
      const taken = files.slice(0, Math.max(0, room))
      const fresh = taken.map((f) => ({ id: `img${Date.now().toString(36)}${(seq++).toString(36)}`, name: f.name || 'image', preview: URL.createObjectURL(f), status: 'working' as const }))
      commit((xs) => [...xs, ...fresh])
      setError(errors.length ? errors.join(' ') : null)
      const fail = (a: Attachment, why: string) => {
        drop(a.id)
        setError((e) => [e, `${a.name} ${why}.`].filter(Boolean).join(' '))
      }
      taken.forEach(async (file, i) => {
        const a = fresh[i]
        const prepared = await prepareImage(file, codec)
        if (!prepared.ok) return fail(a, IMAGE_ERRORS[prepared.error])
        if (!itemsRef.current.some((x) => x.id === a.id)) return // removed meanwhile
        const up = await uploadChatImage(prepared.blob, prepared.name)
        if (!up.ok) return fail(a, IMAGE_ERRORS[up.error])
        commit((xs) => xs.map((x) => (x.id === a.id ? { ...x, status: 'ready', ref: up.ref, name: up.ref.name } : x)))
      })
    },
    [codec, commit, drop]
  )

  const remove = useCallback(
    (id: string) => {
      drop(id)
      setError(null)
    },
    [drop]
  )

  const clear = useCallback(() => {
    itemsRef.current.forEach((a) => URL.revokeObjectURL(a.preview))
    commit(() => [])
    setError(null)
  }, [commit])

  return {
    items,
    refs: items.flatMap((a) => (a.status === 'ready' && a.ref ? [a.ref] : [])),
    pending: items.some((a) => a.status === 'working'),
    error,
    add,
    remove,
    clear,
  }
}

/** The files in a paste or drop (non-images too, so they get a clear refusal). */
export function filesFrom(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files ?? []) : []
}

export function ImageChips({ items, onRemove, disabled }: { items: Attachment[]; onRemove: (id: string) => void; disabled?: boolean }) {
  if (!items.length) return null
  return (
    <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attached images">
      {items.map((a) => (
        <li key={a.id} className="relative">
          <div className="glass size-16 overflow-hidden rounded-xl border border-line">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL; next/image can't optimise it */}
            <img src={a.preview} alt={a.name} title={a.name} className={cn('size-full object-cover', a.status === 'working' && 'opacity-50')} />
            {a.status === 'working' && (
              <span className="absolute inset-0 grid place-items-center" role="status" aria-label={`Uploading ${a.name}`}>
                <Loader2 className="size-4 text-fg motion-safe:animate-spin" />
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            disabled={disabled}
            aria-label={`Remove ${a.name}`}
            className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-line bg-background text-fg-70 transition-colors outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}

export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        multiple
        hidden
        data-testid="agent-attach-input"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        aria-label="Attach images"
        title={`Attach images (PNG, JPEG, GIF, WebP; up to ${MAX_IMAGES}) — or paste / drop them`}
        className="grid size-9 shrink-0 place-items-center rounded-full border border-line text-fg-70 transition-colors hover:bg-white/8 hover:text-fg disabled:opacity-35"
      >
        <Paperclip className="size-4" />
      </button>
    </>
  )
}
