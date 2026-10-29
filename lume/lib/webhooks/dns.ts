import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * SSRF guard for webhook pushes (inbox manager 3f). The URL check
 * (lib/webhooks/push.ts checkWebhookUrl) refuses IP literals and private
 * names; this resolves the host and refuses it when ANY address is private,
 * loopback, link-local, CGNAT, multicast or otherwise not publicly routable.
 * The caller then pins the connection to the checked address
 * (`pinnedLookup` as an undici Agent's `connect.lookup`), so a DNS answer
 * that changes between the check and the connect (rebinding) is never used.
 */

const v4 = (ip: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const o = m.slice(1).map(Number)
  return o.every((n) => n <= 255) ? o : null
}

function privateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF / TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  )
}

/** Expand an IPv6 address to 8 groups; null when it is not one. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (tail) {
    const o = v4(tail[1])
    if (!o) return null
    s = s.slice(0, -tail[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const parts = s.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':') : []
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const fill = parts.length === 2 ? 8 - head.length - rest.length : 0
  const all = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...rest]
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return all.map((g) => parseInt(g, 16))
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return privateV4(v4(ip)!)
  if (kind !== 6) return true
  const g = v6Groups(ip)
  if (!g) return true
  if (g.every((x) => x === 0)) return true // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): judge the embedded IPv4; NAT64 always refused.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255])
  if (g[0] === 0x64 && g[1] === 0xff9b) return true
  if ((g[0] & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true // documentation
  return false
}

export interface ResolvedAddress {
  address: string
  family: number
}

type Lookup = (host: string, opts: { all: true; verbatim: true }) => Promise<ResolvedAddress[]>

/** Every address of `host` must be public; returns the one to connect to. Throws `private_address` / `dns_failed`. */
export async function resolvePublicHost(host: string, lookup: Lookup = dnsLookup as unknown as Lookup): Promise<ResolvedAddress> {
  let addrs: ResolvedAddress[]
  try {
    addrs = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('dns_failed')
  }
  if (!addrs?.length) throw new Error('dns_failed')
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('private_address')
  return { address: addrs[0].address, family: addrs[0].family }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | ResolvedAddress[], family?: number) => void

/** A `net.connect`-style lookup that always answers the checked address. */
export function pinnedLookup(pinned: ResolvedAddress) {
  return (_host: string, opts: { all?: boolean } | number | undefined, cb: LookupCallback) => {
    if (typeof opts === 'object' && opts?.all) cb(null, [{ address: pinned.address, family: pinned.family }])
    else cb(null, pinned.address, pinned.family)
  }
}
