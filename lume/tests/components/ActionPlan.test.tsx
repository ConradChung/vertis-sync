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

describe('ActionPlan SOP violations', () => {
  it('lists the rule and step of each violation on an awaiting sequence edit', () => {
    render(
      <ActionPlan
        action={view({
          kind: 'update_sequence',
          status: 'awaiting',
          decidedVia: null,
          decidedAt: null,
          executedAt: null,
          sopViolations: ['Step 2, variant A — banned_phrase: body uses the banned phrase "reach out"'],
        })}
      />
    )
    expect(screen.getByText(/SOP has changed since this edit was filed/)).toBeTruthy()
    expect(screen.getByText(/Step 2, variant A — banned_phrase/)).toBeTruthy()
  })

  it('keeps a multi-line executor refusal readable', () => {
    render(<ActionPlan action={view({ kind: 'update_sequence', status: 'failed', error: 'Blocked by the cold-email SOP (the kaspen client SOP): 1 violation.\n- Step 4, variant A — signoff: must end with the sign-off "Frank Jing"' })} />)
    expect(screen.getByText(/Step 4, variant A — signoff/).className).toMatch(/whitespace-pre-wrap/)
  })
})
