// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({
    nodes,
    onNodeClick,
    onPaneClick,
    children,
  }: {
    nodes: { id: string; data: { node: { label: string }; selected?: boolean } }[]
    onNodeClick: (e: unknown, n: unknown) => void
    onPaneClick: () => void
    children: ReactNode
  }) => (
    <div>
      {nodes.map((n) => (
        <button key={n.id} data-selected={n.data.selected ? 'yes' : 'no'} onClick={(e) => onNodeClick(e, n)}>
          node:{n.data.node.label}
        </button>
      ))}
      <button onClick={onPaneClick}>pane</button>
      {children}
    </div>
  ),
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useReactFlow: () => ({ getNode: () => undefined, getZoom: () => 1, setCenter: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn(), setViewport: vi.fn() }),
  useNodesInitialized: () => true,
  useStore: (sel: (s: { width: number; height: number }) => unknown) => sel({ width: 800, height: 600 }),
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}))

import { PlaygroundCanvas } from '@/components/playground/PlaygroundCanvas'
import type { Diagram } from '@/lib/agent/diagram'

afterEach(cleanup)

const diagram: Diagram = {
  title: 'D3',
  nodes: [
    {
      id: 'maps',
      label: 'Google Maps',
      kind: 'source',
      state: 'planned',
      details: {
        why: 'Map listings carry website and phone.',
        how: ['Search roofers in Austin', 'Cap at $12'],
        tools: ['run_apify_actor'],
        actors: [{ id: 'compass/crawler-google-places', name: 'Google Maps Scraper', price: '$4 / 1k', fields: ['website', 'phone'] }],
        data: [{ label: 'Est. results', value: '800' }],
        owner: 'Conrad tap',
        approval: true,
        decision: ['How many leads?'],
        links: [{ label: 'Rotate', url: '/rotate' }],
      },
    },
    { id: 'review', label: 'Review', kind: 'step', state: 'planned', details: { why: 'Drop junk before Apollo.' } },
    { id: 'launch', label: 'Launch', kind: 'gate', state: 'planned' },
  ],
  edges: [
    { from: 'maps', to: 'review' },
    { from: 'review', to: 'launch' },
  ],
}

describe('pipeline step details sidebar', () => {
  it('opens on node click with the filled sections and highlights the node', () => {
    render(<PlaygroundCanvas diagram={diagram} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('node:Google Maps'))
    const sheet = screen.getByRole('dialog', { name: 'Step details: Google Maps' })
    for (const t of ['Why', 'How', 'Tools & approvals', 'Actors', 'Data', 'Who · cost · time', 'Open decisions', 'Links']) expect(sheet.textContent).toContain(t)
    expect(sheet.textContent).not.toContain('Risks')
    expect(sheet.textContent).toContain('Needs your approval')
    expect(sheet.textContent).toContain('compass/crawler-google-places')
    expect(screen.getByText('node:Google Maps').dataset.selected).toBe('yes')
  })

  it('steps through the flow with next / previous and arrow keys, and closes with Esc', () => {
    render(<PlaygroundCanvas diagram={diagram} />)
    fireEvent.click(screen.getByText('node:Google Maps'))
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect((screen.getByLabelText('Previous step') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Next step'))
    expect(screen.getByRole('dialog', { name: 'Step details: Review' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    const last = screen.getByRole('dialog', { name: 'Step details: Launch' })
    expect(last.textContent).toContain('No further detail')
    expect((screen.getByLabelText('Next step') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog', { name: 'Step details: Review' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on a pane click or the close button', () => {
    render(<PlaygroundCanvas diagram={diagram} />)
    fireEvent.click(screen.getByText('node:Review'))
    fireEvent.click(screen.getByText('pane'))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByText('node:Review'))
    fireEvent.click(screen.getByLabelText('Close details'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
