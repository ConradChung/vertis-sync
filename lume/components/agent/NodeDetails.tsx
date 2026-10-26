'use client'

import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, CircleHelp, ExternalLink, ShieldCheck, X } from 'lucide-react'
import { StatusBadge } from '@/components/campaigns/GlassNode'
import { KIND_ICON, STATUS } from '@/components/agent/PipelineDiagram'
import type { DiagramNode } from '@/lib/agent/diagram'
import { cn } from '@/lib/utils'

const STATE_LABEL: Record<DiagramNode['state'], string> = { done: 'Done', current: 'Current', planned: 'Planned', skipped: 'Skipped' }

function safeHref(url: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url
  return /^https?:\/\//i.test(url) ? url : null
}

function LinkOut({ url, children, className }: { url: string; children: ReactNode; className?: string }) {
  const href = safeHref(url)
  if (!href) return <span className={className}>{children}</span>
  const external = !href.startsWith('/')
  return (
    <a
      href={href}
      className={cn('underline decoration-(--chart-line)/60 underline-offset-2 hover:text-fg', className)}
      {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
    >
      {children}
      {external && <ExternalLink className="ml-0.5 inline size-3 align-[-1px] opacity-60" />}
    </a>
  )
}

function Section({ title, index, children, className }: { title: string; index: number; children: ReactNode; className?: string }) {
  return (
    <section className={cn('details-section-in', className)} style={{ animationDelay: `${80 + index * 45}ms` } as CSSProperties}>
      <h3 className="mb-1.5 text-[10.5px] font-medium tracking-[0.08em] text-fg-46 uppercase">{title}</h3>
      {children}
    </section>
  )
}

const chip = 'inline-flex items-center gap-1 rounded-full border border-line bg-white/4 px-2 py-0.5 text-[11.5px] text-fg-70 light:bg-black/3'

/**
 * Elaboration for one pipeline step: why it exists, how it runs, the tools,
 * actors and data behind it, who acts, cost and ETA, risks, open decisions and
 * links. Empty sections are hidden. Slides in over the right of the canvas;
 * ← / → step through the flow, Esc closes.
 */
export function NodeDetails({
  node,
  position,
  onPrev,
  onNext,
  onClose,
  className,
}: {
  node: DiagramNode
  /** 1-based position and total, in flow order. */
  position: { index: number; total: number }
  onPrev: (() => void) | null
  onNext: (() => void) | null
  onClose: () => void
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && onNext) onNext()
      else if (e.key === 'ArrowLeft' && onPrev) onPrev()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNext, onPrev])

  const d = node.details ?? {}
  const Icon = KIND_ICON[node.kind]
  let i = 0
  const sections: ReactNode[] = []

  if (d.why)
    sections.push(
      <Section key="why" title="Why" index={i++}>
        <p className="text-[13px] leading-relaxed text-fg-70">{d.why}</p>
      </Section>
    )
  if (d.how?.length)
    sections.push(
      <Section key="how" title="How" index={i++}>
        <ol className="ml-4 list-decimal space-y-1 text-[13px] leading-snug text-fg-70 marker:text-fg-46">
          {d.how.map((h, k) => (
            <li key={k}>{h}</li>
          ))}
        </ol>
      </Section>
    )
  if (d.tools?.length || d.approval !== undefined)
    sections.push(
      <Section key="tools" title="Tools & approvals" index={i++}>
        <div className="flex flex-wrap gap-1.5">
          {d.approval && (
            <span className={cn(chip, 'border-(--chart-line)/60 text-positive')}>
              <ShieldCheck className="size-3" /> Needs your approval
            </span>
          )}
          {d.approval === false && <span className={chip}>Runs without approval</span>}
          {d.tools?.map((t) => (
            <span key={t} className={cn(chip, 'font-mono text-[11px]')}>
              {t}
            </span>
          ))}
        </div>
      </Section>
    )
  if (d.actors?.length)
    sections.push(
      <Section key="actors" title="Actors" index={i++}>
        <div className="space-y-2">
          {d.actors.map((a) => (
            <div key={a.id} className="rounded-control border border-line bg-white/3 p-2.5 light:bg-black/2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-fg">{a.name ?? a.id}</p>
                  {a.url ? (
                    <LinkOut url={a.url} className="font-mono text-[11px] text-fg-46">
                      {a.id}
                    </LinkOut>
                  ) : (
                    a.name && <p className="truncate font-mono text-[11px] text-fg-46">{a.id}</p>
                  )}
                </div>
                {a.price && <span className="shrink-0 rounded-full bg-lime/15 px-2 py-0.5 text-[11px] font-medium text-positive">{a.price}</span>}
              </div>
              {a.fields?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {a.fields.map((f) => (
                    <span key={f} className="rounded border border-line px-1.5 py-px text-[10.5px] text-fg-70">
                      {f}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Section>
    )
  if (d.inputs?.length && d.outputs?.length)
    sections.push(
      <Section key="io" title="Inputs → Outputs" index={i++}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 text-[12px]">
          <ul className="space-y-1 text-fg-70">{d.inputs.map((x) => <li key={x}>{x}</li>)}</ul>
          <ArrowRight className="mt-0.5 size-3.5 text-fg-46" />
          <ul className="space-y-1 text-fg">{d.outputs.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </Section>
    )
  else if (d.inputs?.length || d.outputs?.length) {
    const only = (d.inputs ?? d.outputs)!
    sections.push(
      <Section key="io" title={d.inputs?.length ? 'Inputs' : 'Outputs'} index={i++}>
        <div className="flex flex-wrap gap-1.5">
          {only.map((x) => (
            <span key={x} className={chip}>
              {x}
            </span>
          ))}
        </div>
      </Section>
    )
  }
  if (d.data?.length)
    sections.push(
      <Section key="data" title="Data" index={i++}>
        <dl className="divide-y divide-line overflow-hidden rounded-control border border-line text-[12.5px]">
          {d.data.map((row, k) => (
            <div key={k} className="grid grid-cols-[40%_1fr] gap-2 px-2.5 py-1.5">
              <dt className="text-fg-46">{row.label}</dt>
              <dd className="text-fg tabular-nums">
                {row.value}
                {row.source && (
                  <>
                    {' '}
                    <LinkOut url={row.source} className="text-[11px] text-fg-46">
                      source
                    </LinkOut>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </Section>
    )
  if (d.owner || d.cost || d.eta)
    sections.push(
      <Section key="meta" title="Who · cost · time" index={i++}>
        <dl className="grid grid-cols-3 gap-2 text-[12.5px]">
          {[
            ['Who acts', d.owner],
            ['Cost', d.cost],
            ['ETA', d.eta],
          ].map(([k, v]) => (
            <div key={k} className="rounded-control border border-line px-2.5 py-1.5">
              <dt className="text-[10.5px] text-fg-46">{k}</dt>
              <dd className="mt-0.5 text-fg">{v ?? '—'}</dd>
            </div>
          ))}
        </dl>
      </Section>
    )
  if (d.risks?.length)
    sections.push(
      <Section key="risks" title="Risks" index={i++}>
        <ul className="space-y-1 text-[12.5px] text-fg-70">
          {d.risks.map((r, k) => (
            <li key={k} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-fg-46" /> {r}
            </li>
          ))}
        </ul>
      </Section>
    )
  if (d.decision?.length)
    sections.push(
      <Section key="decision" title="Open decisions" index={i++}>
        <ul className="space-y-1.5 rounded-control border border-(--chart-line)/60 bg-lime/[.08] p-2.5 text-[12.5px] text-fg">
          {d.decision.map((q, k) => (
            <li key={k} className="flex gap-1.5">
              <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-positive" /> {q}
            </li>
          ))}
        </ul>
      </Section>
    )
  if (d.links?.length)
    sections.push(
      <Section key="links" title="Links" index={i++}>
        <ul className="space-y-1 text-[12.5px] text-fg-70">
          {d.links.map((l, k) => (
            <li key={k}>
              <LinkOut url={l.url}>{l.label}</LinkOut>
            </li>
          ))}
        </ul>
      </Section>
    )

  return (
    <aside
      role="dialog"
      aria-label={`Step details: ${node.label}`}
      className={cn('details-sheet-in glass-overlay flex flex-col overflow-hidden rounded-panel', className)}
    >
      <header className="flex items-start gap-2 border-b border-line px-4 pt-3.5 pb-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-fg-46" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-tight font-semibold text-fg">{node.label}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] tracking-wide text-fg-46 uppercase">
            <StatusBadge status={STATUS[node.state]} />
            {STATE_LABEL[node.state]} · {node.kind}
          </p>
          {node.detail && <p className="mt-1.5 text-[12.5px] leading-snug text-fg-70">{node.detail}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded-full p-1 text-fg-46 transition-colors hover:bg-white/10 hover:text-fg light:hover:bg-black/5"
        >
          <X className="size-4" />
        </button>
      </header>
      <div key={node.id} className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
        {sections.length ? (
          sections
        ) : (
          <p className="text-[13px] text-fg-46">No further detail was recorded for this step.</p>
        )}
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-[12px] text-fg-46">
        <button
          type="button"
          onClick={onPrev ?? undefined}
          disabled={!onPrev}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 transition-colors hover:text-fg disabled:opacity-35"
          aria-label="Previous step"
        >
          <ChevronLeft className="size-3.5" /> Prev
        </button>
        <span className="font-mono text-[11px] tabular-nums">
          {position.index} / {position.total}
        </span>
        <button
          type="button"
          onClick={onNext ?? undefined}
          disabled={!onNext}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 transition-colors hover:text-fg disabled:opacity-35"
          aria-label="Next step"
        >
          Next <ChevronRight className="size-3.5" />
        </button>
      </footer>
    </aside>
  )
}
