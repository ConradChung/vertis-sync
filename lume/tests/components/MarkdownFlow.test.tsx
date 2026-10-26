// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/agent/PipelineDiagram', () => ({
  PipelineDiagram: ({ diagram }: { diagram: { nodes: { label: string }[] } }) => (
    <div data-testid="diagram">{diagram.nodes.map((n) => n.label).join(',')}</div>
  ),
  DiagramLegend: () => null,
}))

import { Markdown } from '@/components/agent/Markdown'

const json = JSON.stringify({ nodes: [{ id: 'a', label: 'Source' }, { id: 'b', label: 'Validate' }], edges: [{ from: 'a', to: 'b' }] })

describe('Markdown → PipelineDiagram', () => {
  afterEach(cleanup)
  it('renders a closed, valid flow fence as a diagram', () => {
    render(<Markdown text={'Plan:\n\n```flow\n' + json + '\n```\n\nDone.'} />)
    expect(screen.getByTestId('diagram').textContent).toBe('Source,Validate')
    expect(screen.queryByText(json)).toBeNull()
  })

  it('shows a placeholder while the fence is still streaming', () => {
    render(<Markdown text={'```flow\n{"nodes": [{"id"'} />)
    expect(screen.getByText(/Drawing diagram/)).toBeTruthy()
    expect(screen.queryByTestId('diagram')).toBeNull()
  })

  it('falls back to a code block for invalid JSON', () => {
    render(<Markdown text={'```flow\n{not json}\n```'} />)
    expect(screen.queryByTestId('diagram')).toBeNull()
    expect(screen.getByText('{not json}')).toBeTruthy()
  })

  it('leaves other fences as code', () => {
    render(<Markdown text={'```json\n' + json + '\n```'} />)
    expect(screen.queryByTestId('diagram')).toBeNull()
  })
})
