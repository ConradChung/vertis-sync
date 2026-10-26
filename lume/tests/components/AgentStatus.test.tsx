// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AgentStatus, statusLabel, toolLabel } from '@/components/agent/AgentStatus'

describe('AgentStatus', () => {
  it('labels what the agent is doing', () => {
    expect(statusLabel({ runningTool: 'list_campaigns', liveStatus: null, streaming: false })).toBe('Checking campaigns')
    expect(statusLabel({ runningTool: null, liveStatus: 'Searching the web', streaming: false })).toBe('Searching the web')
    expect(statusLabel({ runningTool: null, liveStatus: null, streaming: true })).toBe('Writing')
    expect(statusLabel({ runningTool: null, liveStatus: null, streaming: false })).toBe('Thinking')
    expect(toolLabel('some_new_tool')).toBe('Running some new tool')
  })

  it('shows a spinner pill only while active', () => {
    const { rerender } = render(<AgentStatus active={false} label="Thinking" />)
    expect(screen.queryByText(/Thinking/)).toBeNull()
    rerender(<AgentStatus active label="Thinking" />)
    expect(screen.getByText('Thinking…')).toBeTruthy()
    expect(screen.getByLabelText('Loading')).toBeTruthy()
  })
})
