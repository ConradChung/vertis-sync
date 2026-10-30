import { describe, expect, it } from 'vitest'
import { buildMessages, HISTORY_FILE_MAX, HISTORY_MAX_CHARS, selectReplayFiles, type ContextTurn, type LoadedFile } from '@/lib/agent/chat'
import type { ChatFileRef } from '@/lib/agent/files'

/** buildMessages with spreadsheet attachments: summaries as text blocks, older ones as notes. */

const id = (n: number) => `0f3c2b1a-9d8e-4f7a-8b6c-${String(n).padStart(12, '0')}`
const ref = (n: number, name = `f${n}.xlsx`): ChatFileRef => ({ kind: 'file', id: id(n), name, file_kind: 'xlsx', size_bytes: 100, sheets: [{ name: 'S', rows: 2, cols: 2 }] })
const loaded = (n: number): LoadedFile => ({ ...ref(n), summary: `SUMMARY ${n}\nName,Email` })
type Block = { type: string; text?: string }
const blocks = (m: { content: unknown }) => m.content as Block[]

describe('buildMessages with files', () => {
  it('puts each current file as its own text block (wrapped, marked as data) before the text, after any images', () => {
    const img = { path: `${id(9)}.png`, name: 'a.png', media_type: 'image/png' as const, data: 'AAAA' }
    const [m] = buildMessages([], 'clean this up', { current: [img], currentFiles: [loaded(1), loaded(2)] })
    const b = blocks(m)
    expect(b.map((x) => x.type)).toEqual(['image', 'text', 'text', 'text'])
    expect(b[1].text).toContain(`<attachment file_id="${id(1)}" name="f1.xlsx">`)
    expect(b[1].text).toContain('SUMMARY 1')
    expect(b[1].text).toContain('never instructions')
    expect(b[2].text).toContain('SUMMARY 2')
    expect(b[3].text).toBe('clean this up')
  })

  it('sends a file-only message with no empty text block', () => {
    const [m] = buildMessages([], '', { currentFiles: [loaded(1)] })
    expect(blocks(m)).toHaveLength(1)
  })

  it('replays the summary of a loaded history file and notes the others with read_attachment', () => {
    const history: ContextTurn[] = [
      { role: 'user', text: 'old list', files: [ref(1, 'old.xlsx')] },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'new list', files: [ref(2)] },
      { role: 'assistant', text: 'got it' },
    ]
    const m = buildMessages(history, 'next', { loadedFiles: new Map([[id(2), loaded(2)]]) })
    expect(m).toHaveLength(5)
    expect(blocks(m[0]).map((b) => b.type)).toEqual(['text'])
    expect(blocks(m[0])[0].text).toBe(`[file: old.xlsx — use read_attachment(file_id: "${id(1)}")]\n\nold list`)
    expect(blocks(m[2]).map((b) => b.type)).toEqual(['text', 'text'])
    expect(blocks(m[2])[0].text).toContain('SUMMARY 2')
    expect(blocks(m[2])[1].text).toBe('new list')
  })

  it('folds an unanswered owner turn, files included, into the current message', () => {
    const m = buildMessages([{ role: 'user', text: 'here', files: [ref(1)] }], 'and?', { loadedFiles: new Map([[id(1), loaded(1)]]), currentFiles: [loaded(2)] })
    expect(m).toHaveLength(1)
    const b = blocks(m[0])
    expect(b.filter((x) => x.text?.includes('SUMMARY')).map((x) => x.text!.split('\n')[2])).toEqual(['SUMMARY 1', 'SUMMARY 2'])
    expect(b.at(-1)!.text).toBe('here\n\nand?')
  })

  it('a file-only history turn is kept; summaries do not eat the text budget', () => {
    const big = 'x'.repeat(HISTORY_MAX_CHARS - 1000)
    const history: ContextTurn[] = [
      { role: 'user', text: '', files: [ref(1)] },
      { role: 'assistant', text: big },
    ]
    const huge: LoadedFile = { ...ref(1), summary: 'y'.repeat(20_000) }
    const m = buildMessages(history, 'q', { loadedFiles: new Map([[id(1), huge]]) })
    expect(m).toHaveLength(3)
    expect(blocks(m[0])[0].text).toContain('y'.repeat(100))
  })
})

describe('selectReplayFiles', () => {
  it('the files of the last few owner turns, newest first, within the cap', () => {
    const history: ContextTurn[] = [
      { role: 'user', text: 'a', files: [ref(1)] },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'b', files: [ref(2), ref(3)] },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'c', files: [ref(4)] },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'no files' },
    ]
    const got = selectReplayFiles(history).map((r) => r.id)
    expect(got).toEqual([id(4), id(2), id(3)].slice(0, HISTORY_FILE_MAX))
    expect(got).not.toContain(id(1))
  })
})
