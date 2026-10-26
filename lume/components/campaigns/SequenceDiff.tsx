import { delayLabel, type EditStep, type EditVariant, type StepDiff } from '@/lib/campaigns/sequence'
import { cn } from '@/lib/utils'

/**
 * Before/after of an `update_sequence` edit, per step and variant (approval
 * page). Removed text is struck and muted; added text is lime-washed. Only
 * steps that changed are listed.
 */
export function SequenceDiff({ diff }: { diff: StepDiff[] }) {
  if (!diff.length) return <p className="text-[13px] text-fg-46">No changes.</p>
  return (
    <ol className="flex flex-col gap-3" aria-label="Sequence changes">
      {diff.map((d) => (
        <li key={d.step} className="rounded-xl border border-border bg-(--glass-fill) p-3">
          <div className="mb-2 flex items-center gap-2 text-[12px]">
            <span className="font-medium text-fg">Step {d.step}</span>
            <Tag change={d.change} />
            {d.change === 'changed' && d.delay && (
              <span className="text-fg-46">
                <s>{d.delay.before}</s> → <span className="text-positive">{d.delay.after}</span>
              </span>
            )}
          </div>
          {d.change === 'added' && <StepBlock step={d.after} index={d.step - 1} tone="added" />}
          {d.change === 'removed' && <StepBlock step={d.before} index={d.step - 1} tone="removed" />}
          {d.change === 'changed' && (
            <div className="flex flex-col gap-2">
              {d.variants.map((v) => (
                <div key={v.variant} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-[11px] text-fg-46">
                    Variant {v.variant} <Tag change={v.change} />
                  </div>
                  {v.change === 'added' && <VariantBlock v={v.after} tone="added" />}
                  {v.change === 'removed' && <VariantBlock v={v.before} tone="removed" />}
                  {v.change === 'changed' &&
                    v.fields.map((f) => (
                      <div key={f.field} className="grid gap-1.5 md:grid-cols-2">
                        <Pane label={`${f.field} · before`} text={f.before} tone="removed" />
                        <Pane label={`${f.field} · after`} text={f.after} tone="added" />
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

function Tag({ change }: { change: 'added' | 'removed' | 'changed' }) {
  return (
    <span
      className={cn(
        'rounded-full border px-1.5 py-px text-[10px] font-medium',
        change === 'added' && 'border-transparent bg-lime/15 text-positive',
        change === 'removed' && 'border-red/25 bg-red/10 text-red',
        change === 'changed' && 'border-border text-fg-70'
      )}
    >
      {change}
    </span>
  )
}

function Pane({ label, text, tone }: { label: string; text: string; tone: 'added' | 'removed' }) {
  return (
    <div className={cn('rounded-lg border p-2', tone === 'added' ? 'border-lime/30 bg-lime/[.07]' : 'border-border bg-fg/[.02]')}>
      <div className="mb-1 text-[10px] tracking-wide text-fg-46 uppercase">{label}</div>
      <p className={cn('text-[12px] break-words whitespace-pre-wrap', tone === 'removed' ? 'text-fg-46 line-through decoration-fg-24' : 'text-fg')}>
        {text || <span className="text-fg-46 no-underline">(empty)</span>}
      </p>
    </div>
  )
}

function VariantBlock({ v, tone }: { v: EditVariant; tone: 'added' | 'removed' }) {
  return <Pane label={v.subject ? `subject: ${v.subject}` : 'same thread'} text={v.body} tone={tone} />
}

function StepBlock({ step, index, tone }: { step: EditStep; index: number; tone: 'added' | 'removed' }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-fg-46">{delayLabel(step, index)}</span>
      {step.variants.map((v, j) => (
        <VariantBlock key={j} v={v} tone={tone} />
      ))}
    </div>
  )
}
