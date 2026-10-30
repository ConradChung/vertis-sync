// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiagramBoundary } from '@/components/agent/DiagramBoundary'

function Boom(): never {
  throw new Error('layout failed')
}

describe('DiagramBoundary', () => {
  it('shows a note instead of a blank panel when a diagram throws, and recovers for the next diagram', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <DiagramBoundary resetKey="a">
        <Boom />
      </DiagramBoundary>
    )
    expect(screen.getByRole('status').textContent).toMatch(/couldn.t be drawn/)
    rerender(
      <DiagramBoundary resetKey="b">
        <p>drawn</p>
      </DiagramBoundary>
    )
    expect(screen.getByText('drawn')).toBeTruthy()
    err.mockRestore()
  })
})
