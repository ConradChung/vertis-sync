// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => '/playground',
  useSearchParams: () => nav.params,
}))
vi.mock('@/components/playground/PlaygroundCanvas', () => ({
  PlaygroundCanvas: ({ diagram }: { diagram: { title?: string; nodes: { label: string }[] } }) => (
    <div data-testid="canvas">
      {diagram.title}|{diagram.nodes.map((n) => n.label).join(',')}
    </div>
  ),
}))

import { PlaygroundScreen } from '@/components/playground/PlaygroundScreen'

const stage = (id: string, label: string, status: string, count: number) => ({ id, label, status, count, hint: null, source: '', action: { type: 'disabled', label: 'x', reason: '' } })
const responses: Record<string, unknown> = {
  '/api/playground/diagrams': { diagrams: [] },
  '/api/agent/skills': { skills: [{ id: 's1', name: 'Kaspen', steps: [{ type: 'import' }, { type: 'launch' }], variables: [] }] },
  '/api/campaigns?with=analytics': { instantly: 'ok', campaigns: [{ key: 'c1', instantly_id: 'c1', name: 'Scaleport - Fall Mega', status: 'paused' }] },
  '/api/campaigns/c1/flow': {
    campaign_name: 'Scaleport - Fall Mega',
    stages: [stage('send', 'Emails sent', 'done', 1266), stage('reply', 'Replies', 'done', 4)],
    bank: stage('bank', 'Lead bank', 'done', 0),
    feeders: [],
  },
}

function renderScreen() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlaygroundScreen />
    </SWRConfig>
  )
}

describe('PlaygroundScreen', () => {
  beforeEach(() => {
    nav.replace.mockReset()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url in responses ? new Response(JSON.stringify(responses[url]), { status: 200 }) : new Response('{}', { status: 404 })))
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens the skill named in ?d= as a planned pipeline', async () => {
    nav.params = new URLSearchParams('d=skill:s1')
    renderScreen()
    expect((await screen.findByTestId('canvas')).textContent).toBe('Kaspen|Import results,Launch')
  })

  it('converts the campaign flow named in ?d=', async () => {
    nav.params = new URLSearchParams('d=campaign:c1')
    renderScreen()
    expect((await screen.findByTestId('canvas')).textContent).toBe('Scaleport - Fall Mega|Emails sent,Replies')
  })

  it('falls back to the first catalog item without ?d=', async () => {
    nav.params = new URLSearchParams()
    renderScreen()
    // No saved diagrams → first group is Campaign flows.
    expect((await screen.findByTestId('canvas')).textContent).toContain('Scaleport - Fall Mega')
  })

  it('shows an error state for a skill that no longer exists', async () => {
    nav.params = new URLSearchParams('d=skill:gone')
    renderScreen()
    expect(await screen.findByText('This skill no longer exists.')).toBeTruthy()
  })
})
