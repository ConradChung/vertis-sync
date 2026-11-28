import type { HiringExtra } from '@/lib/signals/events'
import { SOURCE_LABEL, type SignalRow } from '@/lib/signals/merge'
import { ownerDate } from '@/lib/time/owner'

/**
 * The Signals CSV export (pure, client-safe): one line per account on the
 * tab, in the tab's column order. Cells are scraped third-party text, so
 * every cell that could be read as a formula is neutralised, and a value we
 * do not know is an empty cell: never "Unknown" or a placeholder.
 */

export type ExportTab = 'all' | 'comments' | 'hiring'

/** UTF-8 byte order mark, so Excel reads the file as UTF-8. */
export const BOM = '﻿'

const FORMULA_START = /^[=+\-@\t\r]/

/**
 * One cell, RFC 4180: quoted when it holds a comma, quote or line break (a
 * quote is doubled). A cell starting with = + - @ tab or carriage return gets
 * a leading apostrophe so a spreadsheet shows it as text instead of running it.
 */
export function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v
  if (typeof v === 'string' && FORMULA_START.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The whole file: BOM, header, rows, CRLF line ends (RFC 4180). */
export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return BOM + [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/** `signals-<tab>[-500plus]-YYYY-MM-DD.csv` (the date is the owner's day). */
export function exportFileName(tab: ExportTab, min500: boolean, now: Date = new Date()): string {
  return `signals-${tab}${min500 ? '-500plus' : ''}-${ownerDate(now)}.csv`
}

const day = (iso: string | null | undefined) => (iso ? ownerDate(iso) : '')
const clean = (v: string | null | undefined) => v?.trim() || ''

const TOUCH_HEAD = ['Email touched', 'LinkedIn touched', 'Call touched']
const touches = (r: SignalRow) => [day(r.touches.email), day(r.touches.linkedin), day(r.touches.call)]
const doors = (r: SignalRow) => [r.doors?.count ?? '', clean(r.doors?.source), clean(r.doors?.confidence)]
const DOOR_HEAD = ['Doors', 'Doors source', 'Doors confidence']

const HIRING_HEAD = [
  'Company', 'Website / domain', ...DOOR_HEAD, 'Role title', 'Role tier', 'Location', 'Country', 'Posted date', 'Job post URL',
  'Contact name', 'Contact title', 'Contact LinkedIn', 'Contact email', 'Company phone', 'Company LinkedIn', 'Fit verdict', 'Status', ...TOUCH_HEAD, 'Added date',
]

const COMMENT_HEAD = [
  'Person', 'Title', 'LinkedIn', 'Company', 'Website / domain', ...DOOR_HEAD, 'Signal', 'Comment', 'Comment URL', 'Post URL', 'Signal date', 'Status', ...TOUCH_HEAD,
]

const ALL_HEAD = [
  'Company', 'Website / domain', ...DOOR_HEAD, 'Contact name', 'Contact title', 'Contact LinkedIn', 'Contact email', 'Phone', 'Latest signal', 'Sources', 'Signal date', 'Signal URL', 'Signals', 'Status', ...TOUCH_HEAD,
]

/** The tab's header and one record per account. `hiring` holds the newest hiring row's own fields, by `hiring:<id>`. */
export function exportTable(tab: ExportTab, rows: readonly SignalRow[], hiring: ReadonlyMap<string, HiringExtra>): { header: string[]; records: (string | number)[][] } {
  if (tab === 'hiring') {
    return {
      header: HIRING_HEAD,
      records: rows.map((r) => {
        const l = r.latest.hiring
        const h = l?.ref ? hiring.get(l.ref) : undefined
        return [
          r.name, r.domain ?? '', ...doors(r), clean(h?.role_title) || (l?.detail?.source === 'hiring' ? (l.detail.role ?? '') : ''), clean(h?.role_tier), clean(h?.location), clean(h?.country), day(h?.posted_at ?? l?.at), clean(h?.source_url) || clean(l?.url),
          clean(h?.contact_name) || clean(h?.person_name), clean(h?.contact_title) || clean(h?.person_title), clean(h?.contact_linkedin) || clean(h?.person_linkedin), clean(h?.contact_email),
          clean(h?.company_phone) || clean(r.phone), clean(h?.company_linkedin), clean(h?.pm_fit), r.status, ...touches(r), day(h?.created_at),
        ]
      }),
    }
  }
  if (tab === 'comments') {
    return {
      header: COMMENT_HEAD,
      records: rows.map((r) => {
        const l = r.latest.comment
        const d = l?.detail?.source === 'comment' ? l.detail : null
        return [
          clean(l?.person) || clean(r.contacts[0]?.name), clean(l?.person_title), clean(l?.linkedin), r.name, r.domain ?? '', ...doors(r),
          d ? (d.reaction ? 'Reaction' : 'Comment') : '', clean(d?.comment), clean(l?.url), clean(d?.post_url), day(l?.at ?? r.newest.at), r.status, ...touches(r),
        ]
      }),
    }
  }
  return {
    header: ALL_HEAD,
    records: rows.map((r) => {
      const c = r.contacts[0]
      const h = r.latest.hiring?.ref ? hiring.get(r.latest.hiring.ref) : undefined
      return [
        r.name, r.domain ?? '', ...doors(r), clean(c?.name), clean(c?.title), clean(c?.linkedin), clean(h?.contact_email), clean(r.phone), r.newest.label, r.sources.map((s) => SOURCE_LABEL[s]).join('; '),
        day(r.newest.at), clean(r.newest.url), r.count, r.status, ...touches(r),
      ]
    }),
  }
}

export function exportCsv(tab: ExportTab, rows: readonly SignalRow[], hiring: ReadonlyMap<string, HiringExtra>): string {
  const t = exportTable(tab, rows, hiring)
  return toCsv(t.header, t.records)
}
