import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTools } from '@/lib/mcp/tools/read'
import { McpUserError } from '@/lib/mcp/sanitize'

const stats = readTools.find((t) => t.name === 'lume_get_campaign_stats')!
afterEach(() => vi.unstubAllEnvs())

describe('lume_get_campaign_stats', () => {
  it('says Instantly is not configured instead of an internal error when the key is absent', async () => {
    vi.stubEnv('INSTANTLY_API_KEY', '')
    const err = await stats.run({} as never).catch((e) => e)
    expect(err).toBeInstanceOf(McpUserError)
    expect(String(err.message)).toMatch(/not configured in this environment/)
  })
})
