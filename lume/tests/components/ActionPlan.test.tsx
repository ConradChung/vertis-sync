// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import { ActionPlan, type ActionView } from '@/components/actions/ActionPlan'

afterEach(cleanup)

const view = (o: Partial<ActionView> = {}): ActionView => ({
  id: 'a1',
  kind: 'pause_campaign',
  summary: 'Pause Roofers',
  details: [],
  requestedBy: 'agent',
  status: 'executed',
  decidedVia: 'lume',
  decidedAt: '2026-10-26T10:00:00Z',
  executedAt: '2026-10-26T10:00:05Z',
  createdAt: '2026-10-26T09:59:00Z',
  error: null,
  ...o,
})

describe('ActionPlan decided line', () => {
  it('names skip mode when the agent approved it', () => {
    render(<ActionPlan action={view({ decidedVia: 'agent' })} />)
    expect(screen.getByText(/auto-approved \(skip mode\)/)).toBeTruthy()
    expect(screen.queryByText(/decided in agent/)).toBeNull()
  })
  it('keeps "decided in" for an owner decision', () => {
    render(<ActionPlan action={view({ decidedVia: 'telegram' })} />)
    expect(screen.getByText(/decided in telegram/)).toBeTruthy()
  })
})
