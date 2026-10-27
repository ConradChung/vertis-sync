import { cookies } from 'next/headers'
import { TopBar } from '@/components/shell/TopBar'
import { operatorChipLabel } from '@/lib/operators/context'
import { currentOperator } from '@/lib/operators/session'
import { getVertical } from '@/lib/operators/store'

/** The Grok Bot operator chip's label, or null for the owner. Never breaks the shell. */
async function operatorLabel(): Promise<string | null> {
  // Outside the try: `cookies()` throws Next's dynamic-rendering signal at
  // build time, which must propagate rather than be logged as a failure.
  const store = await cookies()
  try {
    const op = await currentOperator(store)
    if (!op) return null
    const vertical = op.vertical_id ? await getVertical(op.vertical_id) : null
    return operatorChipLabel(op, vertical)
  } catch (err) {
    console.error('[layout] operator chip failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <TopBar operator={await operatorLabel()} />
      <main className="shell">{children}</main>
    </>
  )
}
