'use client'

import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

/** Friendly labels for tool names shown while a run is live. */
const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searching the web',
  web_fetch: 'Reading a web page',
  list_orders: 'Checking orders',
  get_validation_queue: 'Checking the validation queue',
  list_campaigns: 'Checking campaigns',
  campaign_stats: 'Pulling campaign stats',
  rank_campaigns: 'Ranking campaigns',
  list_rules: 'Checking rotation rules',
  list_scheduled_jobs: 'Checking scheduled jobs',
  inbox_health: 'Checking inbox health',
  search_apify_store: 'Searching the Apify Store',
  get_actor_input_schema: 'Reading actor inputs',
  get_actor_run: 'Checking the actor run',
  import_actor_run: 'Importing actor results',
  get_campaign_sequence: 'Reading the sequence',
  list_skills: 'Looking up skills',
  get_skill: 'Opening the skill',
  save_skill: 'Saving the skill',
  draft_reply: 'Drafting a reply',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Running ${name.replace(/_/g, ' ')}`
}

export function statusLabel(s: { runningTool: string | null; liveStatus: string | null; streaming: boolean }): string {
  if (s.runningTool) return toolLabel(s.runningTool)
  if (s.liveStatus) return s.liveStatus
  return s.streaming ? 'Writing' : 'Thinking'
}

function useElapsed(active: boolean) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!active) return setSecs(0)
    const started = Date.now()
    const t = setInterval(() => setSecs(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(t)
  }, [active])
  return secs
}

/**
 * Floating glass pill shown while a run is live: spinner, what the agent is
 * doing right now, and elapsed time.
 */
export function AgentStatus({ active, label, className }: { active: boolean; label: string; className?: string }) {
  const secs = useElapsed(active)
  if (!active) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'glass mx-auto flex w-fit max-w-full items-center gap-2.5 rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-fg-70 shadow-sm',
        'animate-in fade-in slide-in-from-bottom-1 duration-200',
        className
      )}
    >
      <Spinner className="size-3.5 text-positive" />
      <span className="truncate font-medium text-fg">{label}…</span>
      <span className="font-mono text-[11px] text-fg-46 tabular-nums">{secs}s</span>
    </div>
  )
}
