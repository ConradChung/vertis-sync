import { Fragment, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { DiagramCard, DiagramChip } from '@/components/agent/DiagramCard'
import { parseDiagram } from '@/lib/agent/diagram'

/**
 * A tiny, safe Markdown subset for streamed agent replies: paragraphs, `-`/`*`
 * and `1.` lists, ``` fences (an unclosed fence renders as code while it
 * streams), `#` headings, inline `code`, **bold**, *italic* and [links](url)
 * (http(s) and same-site paths only), GFM | tables |, and checklists: `- [ ] task` / `- [x] done`
 * with indented lines under each as its action steps (owner, 2026-11-09: "what's next" answers are
 * checklists, steps signalled with →). Every → renders in the accent. Builds React nodes — never raw HTML.
 */

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string; lang: string; closed: boolean }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { kind: 'check'; items: CheckItem[] }

export interface CheckItem {
  done: boolean
  text: string
  /** The indented lines under it (its action steps), list markers and leading → stripped. */
  steps: string[]
}

const CHECK = /^\s*[-*•]\s+\[( |x|X)\]\s+/
const STEP = /^\s{2,}\S|^\t\S/

type Align = 'left' | 'center' | 'right'

/** Any line with a cell divider; only treated as a table after a header + separator pair. */
const TABLE_ROW = /\|/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Split `| a | b |` into trimmed cells (escaped `\|` stays in the cell). */
export function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function alignOf(cell: string): Align {
  const c = cell.trim()
  if (c.startsWith(':') && c.endsWith(':')) return 'center'
  if (c.endsWith(':')) return 'right'
  return 'left'
}

export function parseBlocks(src: string): Block[] {
  const out: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      const lang = (/^\s*```\s*([\w-]*)/.exec(line)?.[1] ?? '').toLowerCase()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      const closed = i < lines.length
      i++ // closing fence (or past the end while streaming)
      out.push({ kind: 'code', text: body.join('\n'), lang, closed })
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ kind: 'h', level: h[1].length, text: h[2] })
      i++
      continue
    }
    // GFM table: a header row followed by a | --- | separator. Rows stream in as they arrive.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map(alignOf)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        const cells = splitRow(lines[i++])
        rows.push(head.map((_, k) => cells[k] ?? ''))
      }
      out.push({ kind: 'table', head, align, rows })
      continue
    }
    if (CHECK.test(line) && !/^\s{2,}/.test(line)) {
      const items: CheckItem[] = []
      while (i < lines.length && CHECK.test(lines[i]) && !/^\s{2,}/.test(lines[i])) {
        const m = CHECK.exec(lines[i])!
        const item: CheckItem = { done: m[1].toLowerCase() === 'x', text: lines[i].slice(m[0].length), steps: [] }
        i++
        while (i < lines.length && STEP.test(lines[i])) {
          const step = lines[i++].trim().replace(/^([-*•]|\d+[.)])\s+/, '').replace(/^(→|->)\s*/, '')
          if (step) item.steps.push(step)
        }
        items.push(item)
      }
      out.push({ kind: 'check', items })
      continue
    }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const kind = /^\s*\d+[.)]\s+/.test(line) ? 'ol' : 'ul'
      const re = kind === 'ol' ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/
      const items: string[] = []
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''))
      out.push({ kind, items })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !(TABLE_ROW.test(lines[i]) && TABLE_SEP.test(lines[i + 1] ?? '')) && !/^\s*```/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]))
      para.push(lines[i++])
    out.push({ kind: 'p', lines: para })
  }
  return out
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g

function safeHref(url: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url
  return /^https?:\/\//i.test(url) ? url : null
}

export function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1)
      return (
        <code key={i} className="rounded bg-white/8 px-1 py-px font-mono text-[0.9em] text-fg">
          {part.slice(1, -1)}
        </code>
      )
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return (
        <strong key={i} className="font-semibold text-fg">
          {part.slice(2, -2)}
        </strong>
      )
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link) {
      const href = safeHref(link[2])
      if (!href) return <Fragment key={i}>{link[1]}</Fragment>
      const external = !href.startsWith('/')
      return (
        <a
          key={i}
          href={href}
          className="text-violet-soft underline underline-offset-2 hover:text-fg"
          {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        >
          {link[1]}
        </a>
      )
    }
    return <Fragment key={i}>{arrows(part)}</Fragment>
  })
}

/** → (and a typed ->) in the accent, so a flow reads at a glance. */
function arrows(text: string): ReactNode {
  if (!text.includes('→') && !text.includes('->')) return text
  return text.split(/(→|->)/).map((t, k) =>
    t === '→' || t === '->' ? (
      <span key={k} className="text-positive">
        →
      </span>
    ) : (
      t
    )
  )
}

/** A checklist: round ticks (tap to tick off locally), each item's action steps under it as → lines. */
function Checklist({ items }: { items: CheckItem[] }) {
  const [ticked, setTicked] = useState<Record<number, boolean>>({})
  return (
    <ul className="flex flex-col gap-2.5" aria-label="Checklist">
      {items.map((it, j) => {
        const done = ticked[j] ?? it.done
        return (
          <li key={j} className="flex gap-3">
            <button
              type="button"
              role="checkbox"
              aria-checked={done}
              aria-label={done ? 'Mark not done' : 'Mark done'}
              onClick={() => setTicked((t) => ({ ...t, [j]: !done }))}
              className={
                'mt-[3px] grid size-[18px] shrink-0 place-items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
                (done ? 'bg-primary text-primary-foreground' : 'ring-[1.5px] ring-fg-46 ring-inset hover:ring-primary')
              }
            >
              {done && <Check className="size-3" strokeWidth={3} />}
            </button>
            <div className="min-w-0 flex-1">
              <p className={done ? 'text-fg-46 line-through decoration-fg-24' : 'font-medium text-fg'}>{renderInline(it.text)}</p>
              {it.steps.length > 0 && (
                <ul className={'mt-1 flex flex-col gap-0.5 text-[14px] ' + (done ? 'text-fg-24' : 'text-fg-70')}>
                  {it.steps.map((st, k) => (
                    <li key={k} className="flex gap-2">
                      <span className="text-positive" aria-hidden>
                        →
                      </span>
                      <span className="min-w-0">{renderInline(st)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** In the Agent chat, diagrams live in the side panel: the reply shows a chip that focuses it. */
export interface FlowChips {
  onView: (index: number) => void
  /** Index (among this reply's flow blocks) currently shown in the panel. */
  active?: number | null
}

export function Markdown({ text, flow }: { text: string; flow?: FlowChips }) {
  let flowIdx = -1
  return (
    <div className="flex min-w-0 flex-col gap-3 text-[15px] leading-[1.65] text-fg-70">
      {parseBlocks(text).map((b, i) => {
        switch (b.kind) {
          case 'code':
            if (b.lang === 'flow') {
              const k = ++flowIdx
              if (flow) {
                const d = b.closed ? parseDiagram(b.text) : null
                if (!b.closed || d?.ok)
                  return <DiagramChip key={i} diagram={d?.ok ? d.diagram : null} active={flow.active === k} onView={() => flow.onView(k)} />
              }
              // A pipeline diagram: placeholder while it streams, code if the JSON is bad.
              if (!b.closed)
                return (
                  <p key={i} className="flex items-center gap-2 rounded-control border border-dashed border-line px-3 py-2 text-[12.5px] text-fg-46" role="status">
                    <span className="size-1.5 animate-pulse rounded-full bg-positive" /> Drawing diagram…
                  </p>
                )
              const d = parseDiagram(b.text)
              if (d.ok) return <DiagramCard key={i} diagram={d.diagram} />
            }
            return (
              <pre key={i} className="overflow-x-auto rounded-control border border-line bg-muted p-3 font-mono text-[12.5px] leading-5 text-fg">
                <code>{b.text}</code>
              </pre>
            )
          case 'table':
            return (
              <div key={i} className="thin-scroll max-w-full min-w-0 overflow-x-auto rounded-control border border-line">
                <table className="w-full border-collapse text-left text-[13.5px] leading-5">
                  <thead className="bg-muted/60">
                    <tr>
                      {b.head.map((c, k) => (
                        <th key={k} style={{ textAlign: b.align[k] }} className="border-b border-line px-3 py-2 text-[12px] font-medium tracking-wide whitespace-nowrap text-fg-70 uppercase">
                          {renderInline(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-b border-line last:border-0 hover:bg-muted/40">
                        {r.map((c, k) => (
                          <td key={k} style={{ textAlign: b.align[k] }} className="px-3 py-2 align-top text-fg tabular-nums">
                            {renderInline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'h':
            return (
              <p key={i} className={b.level <= 2 ? 'text-[16px] font-semibold text-fg' : 'font-semibold text-fg'}>
                {renderInline(b.text)}
              </p>
            )
          case 'check':
            return <Checklist key={i} items={b.items} />
          case 'ul':
          case 'ol': {
            const List = b.kind
            return (
              <List key={i} className={List === 'ul' ? 'ml-5 list-disc space-y-1 marker:text-fg-24' : 'ml-5 list-decimal space-y-1 marker:text-fg-46'}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </List>
            )
          }
          default:
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(l)}
                  </Fragment>
                ))}
              </p>
            )
        }
      })}
    </div>
  )
}
