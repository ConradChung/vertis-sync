// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown, parseBlocks, splitRow } from '@/components/agent/Markdown'

describe('Markdown tables', () => {
  it('parses a GFM table with alignment', () => {
    const blocks = parseBlocks('Intro\n\n| Campaign | Sent | Reply rate |\n|---|---:|:---:|\n| Scaleport | 1,266 | 0.3% |\n| Kaspen | 40 | — |\n\nAfter')
    const t = blocks.find((b) => b.kind === 'table')
    expect(t).toMatchObject({ kind: 'table', head: ['Campaign', 'Sent', 'Reply rate'], align: ['left', 'right', 'center'] })
    expect(t && 'rows' in t && t.rows).toEqual([['Scaleport', '1,266', '0.3%'], ['Kaspen', '40', '—']])
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'table', 'p'])
  })

  it('accepts tables without outer pipes and pads short rows', () => {
    const t = parseBlocks('a | b\n--- | ---\n1 |')[0]
    expect(t).toMatchObject({ kind: 'table', head: ['a', 'b'], rows: [['1', '']] })
  })

  it('keeps a header row while it streams in before the separator', () => {
    expect(parseBlocks('| a | b |')[0].kind).toBe('p')
  })

  it('splits escaped pipes correctly', () => {
    expect(splitRow('| x \\| y | z |')).toEqual(['x | y', 'z'])
  })

  it('renders a real table with inline formatting', () => {
    render(<Markdown text={'| Name | Value |\n|---|---|\n| **Bold** | `code` |'} />)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Value'])
    expect(screen.getByText('Bold').tagName).toBe('STRONG')
  })
})

describe('Markdown flow fences', () => {
  it('keeps the fence language and whether it closed', () => {
    expect(parseBlocks('```flow\n{}\n```')[0]).toMatchObject({ kind: 'code', lang: 'flow', closed: true })
    expect(parseBlocks('```flow\n{"nodes":')[0]).toMatchObject({ kind: 'code', lang: 'flow', closed: false })
  })
})
