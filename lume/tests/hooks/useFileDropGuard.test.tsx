// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useFileDropGuard } from '@/hooks/useFileDropGuard'

function Guarded({ target }: { target?: boolean }) {
  useFileDropGuard()
  return target ? <div data-testid="t" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()} /> : <div data-testid="t" />
}

function fire(el: EventTarget, type: string, types: string[]) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types, dropEffect: 'move' } })
  el.dispatchEvent(e)
  return e
}

afterEach(cleanup)

describe('useFileDropGuard', () => {
  it('cancels a file drop that lands outside any drop target', () => {
    const { getByTestId } = render(<Guarded />)
    expect(fire(getByTestId('t'), 'drop', ['Files']).defaultPrevented).toBe(true)
    const over = fire(getByTestId('t'), 'dragover', ['Files'])
    expect(over.defaultPrevented).toBe(true)
    expect((over as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe('none')
  })

  it('leaves real drop targets and non-file drags alone', () => {
    const { getByTestId } = render(<Guarded target />)
    const over = fire(getByTestId('t'), 'dragover', ['Files'])
    expect((over as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe('move')
    expect(fire(document.body, 'drop', ['application/x-lume-chat']).defaultPrevented).toBe(false)
  })

  it('is removed on unmount', () => {
    const { unmount } = render(<Guarded />)
    unmount()
    expect(fire(document.body, 'drop', ['Files']).defaultPrevented).toBe(false)
  })
})
