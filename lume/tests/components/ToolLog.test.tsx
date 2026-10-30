// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ToolLog } from '@/components/orb/ToolLog'

afterEach(cleanup)

describe('ToolLog', () => {
  it('shows each "- " line of a tool error (SOP violations) under the failed call', () => {
    render(
      <ToolLog
        entries={[
          {
            id: 't1',
            name: 'update_campaign_sequence',
            tier: 'high',
            status: 'error',
            error: 'update_sequence refused: sop_violations (HTTP 422)\n- Step 1, variant B — banned_phrase: body uses "reach out"\n- Step 4, variant A — signoff: must end with "Frank Jing"\nRewrite the copy.',
          },
        ]}
      />
    )
    expect(screen.getByText('update_sequence refused: sop_violations (HTTP 422)')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(
      expect.arrayContaining(['Step 1, variant B — banned_phrase: body uses "reach out"', 'Step 4, variant A — signoff: must end with "Frank Jing"'])
    )
  })
})

describe('ToolLog warnings', () => {
  it('lists non-blocking warnings (SOP lint) under a call that went through', () => {
    render(
      <ToolLog
        entries={[{ id: 't2', name: 'update_campaign_sequence', tier: 'high', status: 'awaiting', warnings: ['Step 2, variant A — banned_phrase (warning): body uses the banned phrase "leverage"'] }]}
      />
    )
    expect(screen.getByText(/needs approval/)).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Warnings' }).textContent).toMatch(/banned_phrase \(warning\)/)
  })
})
