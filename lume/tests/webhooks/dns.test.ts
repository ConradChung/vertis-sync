import { describe, expect, it, vi } from 'vitest'
import { isPrivateAddress, pinnedLookup, resolvePublicHost } from '@/lib/webhooks/dns'

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'nonsense',
  ])('%s is private / not routable', (ip) => expect(isPrivateAddress(ip)).toBe(true))
  it.each(['8.8.8.8', '104.18.2.3', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])('%s is public', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false)
  )
})

describe('resolvePublicHost', () => {
  it('returns the first address when every resolved address is public', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '104.18.2.3', family: 4 }, { address: '2606:4700::1111', family: 6 }])
    expect(await resolvePublicHost('grok.test', lookup)).toEqual({ address: '104.18.2.3', family: 4 })
    expect(lookup).toHaveBeenCalledWith('grok.test', { all: true, verbatim: true })
  })

  it('refuses when ANY resolved address is private (DNS rebinding to an internal host)', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '104.18.2.3', family: 4 }, { address: '10.0.0.5', family: 4 }])
    await expect(resolvePublicHost('grok.test', lookup)).rejects.toThrow('private_address')
  })

  it('a failed or empty lookup is dns_failed', async () => {
    await expect(resolvePublicHost('grok.test', vi.fn().mockRejectedValue(new Error('ENOTFOUND')))).rejects.toThrow('dns_failed')
    await expect(resolvePublicHost('grok.test', vi.fn().mockResolvedValue([]))).rejects.toThrow('dns_failed')
  })
})

describe('pinnedLookup', () => {
  it('always answers the checked address, in both callback shapes', () => {
    const lk = pinnedLookup({ address: '104.18.2.3', family: 4 })
    const one = vi.fn()
    lk('grok.test', {}, one)
    expect(one).toHaveBeenCalledWith(null, '104.18.2.3', 4)
    const all = vi.fn()
    lk('grok.test', { all: true }, all)
    expect(all).toHaveBeenCalledWith(null, [{ address: '104.18.2.3', family: 4 }])
  })
})
