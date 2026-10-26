// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => nav }))
vi.mock('@/components/agent/PipelineDiagram', () => ({
  PipelineDiagram: ({ direction }: { direction: string }) => <div data-testid="canvas" data-direction={direction} />,
  DiagramLegend: () => <div data-testid="legend" />,
}))

import { DiagramCard } from '@/components/agent/DiagramCard'

const diagram = {
  title: 'Kaspen pipeline',
  nodes: [
    { id: 'a', label: 'Source', kind: 'source' as const, state: 'done' as const },
    { id: 'b', label: 'Validate', kind: 'step' as const, state: 'planned' as const },
  ],
  edges: [{ from: 'a', to: 'b' }],
}

describe('DiagramCard', () => {
  beforeEach(() => {
    nav.push.mockReset()
    window.history.replaceState(null, '', '/agent?c=3de3cc03-5cec-48b4-bfae-cf8526c0dda6')
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('pops out as its own section, drawn top to bottom', () => {
    render(<DiagramCard diagram={diagram} />)
    const section = screen.getByRole('region', { name: /Kaspen pipeline/ })
    expect(section.className).toContain('diagram-pop')
    expect(screen.getByTestId('canvas').dataset.direction).toBe('TB')
    expect(screen.getByText('2 steps · 1 links')).toBeTruthy()
  })

  it('collapses and expands', () => {
    render(<DiagramCard diagram={diagram} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse diagram' }))
    expect(screen.queryByTestId('canvas')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }))
    expect(screen.getByTestId('canvas')).toBeTruthy()
  })

  it('saves the spec and opens it in the Playground', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ diagram: { id: 'd1' }, created: true }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DiagramCard diagram={diagram} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in Playground' }))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/playground?d=saved:d1'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/playground/diagrams')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ title: 'Kaspen pipeline', source_conversation_id: '3de3cc03-5cec-48b4-bfae-cf8526c0dda6' })
    expect(body.spec.nodes).toHaveLength(2)
  })

  it('shows an error when saving fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })))
    render(<DiagramCard diagram={diagram} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in Playground' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(nav.push).not.toHaveBeenCalled()
  })
})
