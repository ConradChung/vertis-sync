import { describe, expect, it } from 'vitest'
import { isPublicPath } from '@/lib/auth/publicPaths'

const uuid = '0b4c1f2e-7d3a-4b9e-8f6a-2c1d3e4f5a6b'

describe('isPublicPath', () => {
  it.each([
    '/login',
    '/forbidden',
    '/auth/callback',
    '/auth/confirm',
    '/api/webhooks/instantly',
    '/api/hooks/gate-opened',
    '/api/cron/rotation-tick',
    `/api/actions/${uuid}/execute`,
    '/api/auth/magic-link',
    '/api/slack/events',
    '/api/slack/interactions',
    '/api/slack/install',
    '/api/slack/oauth/callback',
    '/_next/static/chunks/main.js',
    '/_next/image?url=x',
    '/favicon.ico',
    '/logo.svg',
    '/fonts/inter.woff2',
  ])('treats %s as public', (path) => {
    expect(isPublicPath(path)).toBe(true)
  })

  it.each([
    '/',
    '/overview',
    '/import',
    '/validate',
    '/rotate',
    '/campaigns',
    '/api/gates',
    '/api/orders',
    `/api/actions/${uuid}/decide`,
    `/api/actions/${uuid}`,
    '/api/actions',
    '/api/agent/run',
    '/api/gates.json',
    '/api/export.txt',
    '/api/auth',
    '/overview.js',
    '/forbiddenx',
    '/forbidden/nested',
    '/loginx',
    '/login/../overview',
    '/authx/callback',
    '/api/slack/install-link',
    '/api/slack/installs',
    '/api/slack/installs/T0AAA/revoke',
    '/api/slack/installs/T0AAA/channels',
    '/api/slack/channels',
    '/api/slack/events/extra',
    '/api/slack/oauth',
  ])('treats %s as protected', (path) => {
    expect(isPublicPath(path)).toBe(false)
  })

  it('only matches /execute as the final segment of an action id', () => {
    expect(isPublicPath(`/api/actions/${uuid}/execute/extra`)).toBe(false)
    expect(isPublicPath('/api/actions//execute')).toBe(false)
  })
})
