// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Markdown, parseBlocks } from '@/components/agent/Markdown'

afterEach(cleanup)

const REPLY = [
  'Next for **Kaspen — PM owners**:',
  '',
  '- [x] Validate the list',
  '- [ ] Set up the no-location campaign',
  '  → Progress → Review → Create "Kaspen — No Location"',
  '  - Turn the Location barrier off',
  '- [ ] Push to the lead bank',
  '  -> Tap **Push these**',
  '',
  'Validated → Enriched → Campaign',
].join('\n')

describe('Markdown checklists', () => {
  it('parses tasks with their indented action steps (markers and leading arrows stripped)', () => {
    const blocks = parseBlocks(REPLY)
    const check = blocks.find((b) => b.kind === 'check')
    expect(check).toEqual({
      kind: 'check',
      items: [
        { done: true, text: 'Validate the list', steps: [] },
        { done: false, text: 'Set up the no-location campaign', steps: ['Progress → Review → Create "Kaspen — No Location"', 'Turn the Location barrier off'] },
        { done: false, text: 'Push to the lead bank', steps: ['Tap **Push these**'] },
      ],
    })
    expect(blocks.at(-1)).toEqual({ kind: 'p', lines: ['Validated → Enriched → Campaign'] })
  })

  it('renders round checkboxes that tick off locally, and steps as → lines', () => {
    render(<Markdown text={REPLY} />)
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    fireEvent.click(boxes[1])
    expect(screen.getAllByRole('checkbox')[1].getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Turn the Location barrier off')).toBeTruthy()
    expect(screen.getByText('Push these').tagName).toBe('STRONG')
  })

  it('a plain list is unaffected', () => {
    expect(parseBlocks('- one\n- two')[0]).toEqual({ kind: 'ul', items: ['one', 'two'] })
  })
})
