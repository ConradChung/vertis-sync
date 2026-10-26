import { Fragment, type ReactNode } from 'react'

/**
 * A tiny, safe Markdown subset for streamed agent replies: paragraphs, `-`/`*`
 * and `1.` lists, ``` fences (an unclosed fence renders as code while it
 * streams), `#` headings, inline `code`, **bold**, *italic* and [links](url)
 * (http(s) and same-site paths only). Builds React nodes — never raw HTML.
 */

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'h'; level: number; text: string }

export function parseBlocks(src: string): Block[] {
  const out: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or past the end while streaming)
      out.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ kind: 'h', level: h[1].length, text: h[2] })
      i++
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
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]))
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
    return <Fragment key={i}>{part}</Fragment>
  })
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 text-[15px] leading-[1.65] text-fg-70">
      {parseBlocks(text).map((b, i) => {
        switch (b.kind) {
          case 'code':
            return (
              <pre key={i} className="overflow-x-auto rounded-control border border-line bg-muted p-3 font-mono text-[12.5px] leading-5 text-fg">
                <code>{b.text}</code>
              </pre>
            )
          case 'h':
            return (
              <p key={i} className={b.level <= 2 ? 'text-[16px] font-semibold text-fg' : 'font-semibold text-fg'}>
                {renderInline(b.text)}
              </p>
            )
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
