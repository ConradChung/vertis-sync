import type { PortalLead, PortalReplyStatus } from '@/lib/portal/types'
import { isUS, stateAbbr } from './zones'

/**
 * `tel:` href for a displayed phone number: keeps a leading `+` and the digits,
 * drops spaces / dashes / dots / brackets. An extension ("x12", "ext. 12")
 * becomes a `,` pause so the dialer keys it after connecting. Null when there
 * aren't enough digits to dial.
 */
export function phoneHref(phone: string | null | undefined): string | null {
  if (!phone) return null
  const raw = phone.trim()
  const m = raw.match(/^(.*?)(?:\s*(?:ext\.?|extension|x|#)\s*(\d+))?\s*$/i)
  const main = m?.[1] ?? raw
  const ext = m?.[2]
  const digits = main.replace(/\D/g, '')
  if (digits.length < 3) return null
  const plus = main.trim().startsWith('+') ? '+' : ''
  return `tel:${plus}${digits}${ext ? `,${ext}` : ''}`
}

/**
 * Display form of a phone number: North American (+1) numbers become
 * "+1 (817) 281-1300" (an extension is kept as " ext. 12"); anything else is
 * shown exactly as given. Dialing always uses `phoneHref`.
 */
export function displayPhone(phone: string | null | undefined): string {
  const raw = (phone ?? '').trim()
  if (!raw.startsWith('+')) return raw
  const m = raw.match(/^(.*?)(?:\s*(?:ext\.?|extension|x|#)\s*(\d+))?\s*$/i)
  const digits = (m?.[1] ?? raw).replace(/\D/g, '')
  if (digits.length !== 11 || digits[0] !== '1') return raw
  const ext = m?.[2]
  return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}${ext ? ` ext. ${ext}` : ''}`
}

export function mailHref(email: string | null | undefined): string | null {
  const e = email?.trim()
  return e ? `mailto:${e}` : null
}

/** External link with a scheme; bare domains ("acme.com") get https://. */
export function externalHref(url: string | null | undefined): string | null {
  const u = url?.trim()
  if (!u) return null
  if (/^https?:\/\//i.test(u)) return u
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null // other schemes (javascript:, data:) are never linked
  return `https://${u.replace(/^\/+/, '')}`
}

/** "acme.com" from "https://www.acme.com/about". */
export function displayHost(url: string | null | undefined): string | null {
  const href = externalHref(url)
  if (!href) return null
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return url ?? null
  }
}

/** "Dallas, TX" / "Dallas, United States" / "Texas" — whatever is known. */
export function locationLabel(lead: Pick<PortalLead, 'city' | 'state' | 'country'>): string | null {
  const parts = [lead.city, lead.state || lead.country].map((p) => p?.trim()).filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames('en', { type: 'region' })
  } catch {
    return null
  }
})()

/** "GB" → "United Kingdom"; full names pass through. */
function countryName(country: string | null | undefined): string | null {
  const c = country?.trim()
  if (!c) return null
  if (/^[A-Za-z]{2}$/.test(c) && regionNames) {
    try {
      return regionNames.of(c.toUpperCase()) ?? c
    } catch {
      return c
    }
  }
  return c
}

/**
 * Where the lead is, for the location column: "Dallas, TX" (US / Canada /
 * Australia use the state abbreviation), "Leeds, United Kingdom", "Texas"
 * without a city; `region` only when nothing geographic is known.
 */
export function locationLine(lead: Pick<PortalLead, 'city' | 'state' | 'country' | 'region'>): string | null {
  const city = lead.city?.trim() || null
  const state = lead.state?.trim() || null
  const country = countryName(lead.country)
  const abbr = stateAbbr(lead.country, state)
  let line: string | null
  if (abbr) line = city ? `${city}, ${abbr}` : isUS(lead.country) ? state : `${state}, ${country}`
  else if (isUS(lead.country)) line = city ? `${city}, US` : 'United States'
  else if (city) line = `${city}, ${country ?? state ?? ''}`.replace(/, $/, '')
  else line = [state, country].filter(Boolean).join(', ') || null
  return line || lead.region?.trim() || null
}

export interface LocalTime {
  /** e.g. "9:41 AM" */
  time: string
  /** Mon–Fri, 8:00–17:59 in that zone. */
  business: boolean
}

const fmtCache = new Map<string, { time: Intl.DateTimeFormat; parts: Intl.DateTimeFormat } | null>()

function formatters(timeZone: string) {
  if (fmtCache.has(timeZone)) return fmtCache.get(timeZone) ?? null
  let f: { time: Intl.DateTimeFormat; parts: Intl.DateTimeFormat } | null = null
  try {
    f = {
      time: new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
      }),
      parts: new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        hour: '2-digit',
        hourCycle: 'h23',
      }),
    }
  } catch {
    f = null // unknown IANA zone
  }
  fmtCache.set(timeZone, f)
  return f
}

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

/** The lead's wall-clock time and whether it is business hours there; null for a missing/unknown zone. */
export function localTime(timeZone: string | null | undefined, now: Date): LocalTime | null {
  if (!timeZone) return null
  const f = formatters(timeZone)
  if (!f) return null
  // Newer ICU puts a narrow no-break space before AM/PM; normalise for display and tests.
  const time = f.time.format(now).replace(/[  ]/g, ' ')
  const parts = f.parts.formatToParts(now)
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? ''
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN) % 24
  return { time, business: WEEKDAYS.has(weekday) && hour >= 8 && hour < 18 }
}

/** Badge tone per reply status: later stages read stronger. */
export const REPLY_TONE: Record<PortalReplyStatus, 'soft' | 'strong'> = {
  Interested: 'soft',
  'Meeting booked': 'strong',
  'Meeting completed': 'strong',
  Won: 'strong',
}
