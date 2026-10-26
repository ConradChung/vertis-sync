// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/agent',
  useSearchParams: () => nav.params,
}))

import { AgentChat, SAVE_SKILL_PROMPT } from '@/components/agent/AgentChat'
import { lastRunLabel } from '@/components/agent/AgentSkills'
import type { Skill } from '@/lib/agent/skillModel'

const SKILL: Skill = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'Roofers in a city',
  description: 'Google Maps roofers, validated, into a copy of the best campaign',
  variables: [{ name: 'city', description: 'City', default: 'Austin, TX' }],
  steps: [
    { type: 'apify_actor', actor_id: 'compass/crawler-google-places', actor_name: 'Google Maps Scraper', input_template: { locationQuery: '{{city}}' } },
    { type: 'validate' },
    { type: 'launch' },
  ],
  source_conversation_id: null,
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
  last_run_at: null,
  run_count: 0,
}

function sse() {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      for (const f of [{ type: 'run', id: 'r1', conversation_id: '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c' }, { type: 'text', delta: 'Which city?' }, { type: 'done' }])
        c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function fetchMock(skills: Skill[] = [SKILL]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/agent/skills') return Response.json({ skills })
    if (url === '/api/agent/conversations') return Response.json({ conversations: [] })
    if (url === '/api/agent/run') return sse()
    if (url.startsWith('/api/agent/skills/') && init?.method === 'DELETE') return Response.json({ ok: true })
    return Response.json({ error: 'not_found' }, { status: 404 })
  })
}

const runBodies = (f: ReturnType<typeof fetchMock>) =>
  f.mock.calls.filter((c) => c[0] === '/api/agent/run').map((c) => JSON.parse(String(c[1]?.body)))

beforeEach(() => {
  nav.params = new URLSearchParams()
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function pickSkill() {
  fireEvent.click(await screen.findByRole('button', { name: 'Skills' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Roofers in a city/ }))
  return screen.findByRole('region', { name: 'Skill: Roofers in a city' })
}

describe('Agent skills', () => {
  it('the dropdown lists saved skills with step count and last run', async () => {
    vi.stubGlobal('fetch', fetchMock())
    render(<AgentChat />)
    fireEvent.click(await screen.findByRole('button', { name: 'Skills' }))
    const item = await screen.findByRole('menuitem', { name: /Roofers in a city/ })
    expect(item.textContent).toContain('3 steps · never run')
    expect(item.textContent).toContain('Google Maps roofers')
    // Nothing in this chat yet, so there is nothing to save.
    expect(screen.getByRole('menuitem', { name: /Save this chat as a skill/ }).getAttribute('aria-disabled')).toBe('true')
  })

  it('picking shows the steps and variables; Run sends the skill to the run route', async () => {
    const f = fetchMock()
    vi.stubGlobal('fetch', f)
    render(<AgentChat />)
    const card = await pickSkill()
    expect(card.textContent).toContain('Run Apify actor: Google Maps Scraper')
    expect(card.textContent).toContain('{{city}}')
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }))
    await waitFor(() => expect(runBodies(f)).toHaveLength(1))
    expect(runBodies(f)[0]).toEqual({ prompt: 'Run the skill "Roofers in a city".', skill_id: SKILL.id, skill_mode: 'run' })
    await screen.findByText('Running skill: Roofers in a city')
    expect(screen.queryByRole('region', { name: 'Skill: Roofers in a city' })).toBeNull()
  })

  it('Reference attaches the skill to the next message only', async () => {
    const f = fetchMock()
    vi.stubGlobal('fetch', f)
    render(<AgentChat />)
    await pickSkill()
    fireEvent.click(screen.getByRole('button', { name: /Reference/ }))
    expect(screen.getByRole('button', { name: /Attached as reference/ }).getAttribute('aria-pressed')).toBe('true')
    const box = screen.getByLabelText('Message Lume')
    fireEvent.change(box, { target: { value: 'Same thing but for dentists' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(runBodies(f)).toHaveLength(1))
    expect(runBodies(f)[0]).toEqual({ prompt: 'Same thing but for dentists', skill_id: SKILL.id, skill_mode: 'reference' })
    await screen.findByText('Which city?')
    fireEvent.change(box, { target: { value: 'next' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(runBodies(f)).toHaveLength(2))
    expect(runBodies(f)[1]).toEqual({ prompt: 'next', conversation_id: '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c' })
  })

  it('the x removes the picked skill', async () => {
    vi.stubGlobal('fetch', fetchMock())
    render(<AgentChat />)
    await pickSkill()
    fireEvent.click(screen.getByRole('button', { name: 'Remove skill' }))
    expect(screen.queryByRole('region', { name: 'Skill: Roofers in a city' })).toBeNull()
  })

  it('Save this chat as a skill asks the agent to draft it and wait', async () => {
    const f = fetchMock()
    vi.stubGlobal('fetch', f)
    render(<AgentChat />)
    const box = screen.getByLabelText('Message Lume')
    fireEvent.change(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByText('Which city?')
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Save this chat as a skill/ }))
    await waitFor(() => expect(runBodies(f)).toHaveLength(2))
    expect(runBodies(f)[1].prompt).toBe(SAVE_SKILL_PROMPT)
    expect(SAVE_SKILL_PROMPT).toMatch(/wait for my OK before calling save_skill/)
  })

  it('Manage: delete asks first, then soft-deletes', async () => {
    const f = fetchMock()
    vi.stubGlobal('fetch', f)
    render(<AgentChat />)
    fireEvent.click(await screen.findByRole('button', { name: 'Skills' }))
    await screen.findByRole('menuitem', { name: /Roofers in a city/ })
    fireEvent.click(screen.getByRole('menuitem', { name: /Manage skills/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Roofers in a city' }))
    await screen.findByText('Delete this skill?')
    expect(f.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(f.mock.calls.some((c) => c[0] === `/api/agent/skills/${SKILL.id}` && c[1]?.method === 'DELETE')).toBe(true))
  })
})

describe('lastRunLabel', () => {
  it('reads like a timestamp', () => {
    const now = Date.parse('2026-10-26T12:00:00Z')
    expect(lastRunLabel(null, now)).toBe('never run')
    expect(lastRunLabel('2026-10-26T11:59:40Z', now)).toBe('ran just now')
    expect(lastRunLabel('2026-10-26T11:30:00Z', now)).toBe('ran 30m ago')
    expect(lastRunLabel('2026-10-26T07:00:00Z', now)).toBe('ran 5h ago')
    expect(lastRunLabel('2026-10-23T12:00:00Z', now)).toBe('ran 3d ago')
  })
})
