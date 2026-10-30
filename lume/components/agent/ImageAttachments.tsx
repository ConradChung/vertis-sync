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
  /** Remove one chip (and only the errors about it). */
  remove: (id: string) => void
  clear: () => void
  /** Hand every chip to a send: they leave the composer but keep their previews until released. */
  take: () => Attachment[]
  /** The send failed: put taken chips back in front (within the per-message cap). */
  restore: (taken: Attachment[]) => void
  /** The send went through: free the taken chips' previews. */
  release: (taken: Attachment[]) => void
}

let seq = 0

/** An inline error, tied to the chip it is about (none: about the whole add, e.g. too many). */
interface AttachError {
  id?: string
  text: string
}

export function useImageAttachments(codec?: ImageCodec): ImageAttachments {
  const [items, setItems] = useState<Attachment[]>([])
  const [errors, setErrors] = useState<AttachError[]>([])
  const itemsRef = useRef<Attachment[]>([])
  // Chips handed to a send that has not settled yet: their previews stay alive for a restore.
  const inFlightRef = useRef<Attachment[]>([])
  const commit = useCallback((fn: (xs: Attachment[]) => Attachment[]) => {
    itemsRef.current = fn(itemsRef.current)
    setItems(itemsRef.current)
  }, [])

  // Object URLs are released when a chip goes away and on unmount.
  useEffect(
    () => () => {
      itemsRef.current.forEach((a) => URL.revokeObjectURL(a.preview))
      inFlightRef.current.forEach((a) => URL.revokeObjectURL(a.preview))
    },
    []
  )

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
      const taken = files.slice(0, Math.max(0, room))
      const fresh = taken.map((f) => ({ id: `img${Date.now().toString(36)}${(seq++).toString(36)}`, name: f.name || 'image', preview: URL.createObjectURL(f), status: 'working' as const }))
      commit((xs) => [...xs, ...fresh])
      // A new add starts a fresh set of errors.
      setErrors(files.length > room ? [{ text: `${IMAGE_ERRORS.too_many}.` }] : [])
      const fail = (a: Attachment, why: string) => {
        drop(a.id)
        setErrors((es) => [...es, { id: a.id, text: `${a.name} ${why}.` }])
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
      setErrors((es) => es.filter((e) => e.id !== id))
    },
    [drop]
  )

  const clear = useCallback(() => {
    itemsRef.current.forEach((a) => URL.revokeObjectURL(a.preview))
    commit(() => [])
    setErrors([])
  }, [commit])

  const take = useCallback(() => {
    const taken = itemsRef.current
    inFlightRef.current = [...inFlightRef.current, ...taken]
    commit(() => [])
    setErrors([])
    return taken
  }, [commit])

  const settle = (taken: Attachment[]) => {
    const ids = new Set(taken.map((a) => a.id))
    inFlightRef.current = inFlightRef.current.filter((a) => !ids.has(a.id))
  }

  const restore = useCallback(
    (taken: Attachment[]) => {
      settle(taken)
      const back = taken.slice(0, Math.max(0, MAX_IMAGES - itemsRef.current.length))
      taken.slice(back.length).forEach((a) => URL.revokeObjectURL(a.preview))
      commit((xs) => [...back, ...xs])
    },
    [commit]
  )

  const release = useCallback((taken: Attachment[]) => {
    settle(taken)
    taken.forEach((a) => URL.revokeObjectURL(a.preview))
  }, [])

  return {
    items,
    refs: items.flatMap((a) => (a.status === 'ready' && a.ref ? [a.ref] : [])),
    pending: items.some((a) => a.status === 'working'),
    error: errors.length ? errors.map((e) => e.text).join(' ') : null,
    add,
    remove,
    clear,
    take,
    restore,
    release,
  }
}

/**
 * The files in a paste or drop (non-images too, so they get a clear refusal).
 * Falls back to `items` (kind 'file') when `files` is empty, as Safari leaves
 * it for some pastes.
 */
export function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = Array.from(data.files ?? [])
  if (files.length) return files
  return Array.from(data.items ?? [])
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f)
}

/**
 * A paste's images, or none when it carries text: Excel, Numbers and Word put
 * a rendered picture of the copied cells next to the text, and the owner meant
 * the text. Only a paste with no text type (a screenshot, a copied image) attaches.
 */
export function pastedImages(data: DataTransfer | null): File[] {
  if (!data) return []
  const types = Array.from(data.types ?? [])
  if (types.includes('text/plain') || types.includes('text/html')) return []
  return filesFrom(data)
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
