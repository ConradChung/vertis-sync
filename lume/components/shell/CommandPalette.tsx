'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { Kanban, Megaphone, Package, Repeat, User, Workflow } from 'lucide-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { fetchJson } from '@/hooks/fetcher'
import type { InstantlyCampaign } from '@/lib/adapters/instantly.map'
import type { LumeCampaignRow, OrderRow } from '@/lib/db/types'

/** Same name as `OPEN_PALETTE_EVENT` in components/crm/CrmWorkspace (kept here so the shell has no CRM import cycle). */
const OPEN_EVENT = 'lume:open-palette'

type DealHit = {
  id: string
  campaign_id: string
  email: string
  name: string | null
  company: string | null
  stage: string
}
type RuleHit = {
  id: string
  name: string
  campaign_id: string
  cron: string
  active: boolean
}

/**
 * ⌘K / Ctrl+K: jump to a campaign (its CRM pipeline), a lead (opens its CRM
 * sheet), an order (Import) or a rotation rule (Rotate). Lists load when the
 * palette first opens; lead search hits /api/crm/search as you type.
 */
export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 200)
    return () => clearTimeout(t)
  }, [q])

  const opts = { revalidateOnFocus: false, shouldRetryOnError: false }
  const instantly = useSWR<{
    configured: boolean
    campaigns?: InstantlyCampaign[]
  }>(open ? '/api/instantly/campaigns' : null, fetchJson, opts)
  const registry = useSWR<LumeCampaignRow[]>(open ? '/api/campaigns' : null, fetchJson, opts)
  const orders = useSWR<OrderRow[]>(open ? '/api/orders?limit=50' : null, fetchJson, opts)
  const rules = useSWR<RuleHit[]>(open ? '/api/rules' : null, fetchJson, opts)
  const deals = useSWR<{ deals: DealHit[] }>(open && term.length >= 2 ? `/api/crm/search?q=${encodeURIComponent(term)}` : null, fetchJson, {
    ...opts,
    keepPreviousData: true,
  })

  const campaigns = new Map<string, string>()
  for (const c of instantly.data?.campaigns ?? []) campaigns.set(c.id, c.name)
  for (const c of registry.data ?? []) if (c.external_id && !campaigns.has(c.external_id)) campaigns.set(c.external_id, c.name)

  const go = (href: string) => {
    setOpen(false)
    setQ('')
    router.push(href)
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Jump to" description="Campaigns, leads, orders and rules">
      <Command>
        <CommandInput placeholder="Jump to a campaign, lead, order or rule…" value={q} onValueChange={setQ} />
        <CommandList>
          <CommandEmpty>{term.length >= 2 && deals.isLoading ? 'Searching…' : 'Nothing found.'}</CommandEmpty>
          {(deals.data?.deals.length ?? 0) > 0 && term.length >= 2 && (
            <CommandGroup heading="Leads">
              {deals.data!.deals.map((d) => (
                <CommandItem
                  key={d.id}
                  value={`lead ${d.name ?? ''} ${d.email} ${d.company ?? ''}`}
                  onSelect={() => go(`/crm?campaign=${encodeURIComponent(d.campaign_id)}&deal=${d.id}`)}
                >
                  <User strokeWidth={1.75} />
                  <span className="truncate">{d.name ?? d.email}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{d.email}</span>
                  <CommandShortcut>{d.stage}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Go to">
            <CommandItem value="crm all campaigns pipeline" onSelect={() => go('/crm')}>
              <Kanban strokeWidth={1.75} /> CRM — all campaigns
            </CommandItem>
            <CommandItem value="campaigns list" onSelect={() => go('/campaigns')}>
              <Megaphone strokeWidth={1.75} /> Campaigns
            </CommandItem>
            <CommandItem value="playground pipelines diagrams showcase" onSelect={() => go('/playground')}>
              <Workflow strokeWidth={1.75} /> Playground — pipelines
            </CommandItem>
          </CommandGroup>
          {campaigns.size > 0 && (
            <CommandGroup heading="Campaigns">
              {[...campaigns].map(([id, name]) => (
                <CommandItem key={id} value={`campaign ${name} ${id}`} onSelect={() => go(`/crm?campaign=${encodeURIComponent(id)}`)}>
                  <Megaphone strokeWidth={1.75} />
                  <span className="truncate">{name}</span>
                  <CommandShortcut>CRM</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {(orders.data?.length ?? 0) > 0 && (
            <CommandGroup heading="Orders">
              {orders.data!.slice(0, 30).map((o) => (
                <CommandItem
                  key={`${o.kind}:${o.id}`}
                  value={`order ${o.summary ?? ''} ${o.source ?? ''} ${o.kind} ${o.id}`}
                  onSelect={() => go('/import')}
                >
                  <Package strokeWidth={1.75} />
                  <span className="truncate">{o.summary ?? o.kind}</span>
                  <CommandShortcut className="font-mono">{o.row_count ?? ''}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {(rules.data?.length ?? 0) > 0 && (
            <CommandGroup heading="Rotation rules">
              {rules.data!.map((r) => (
                <CommandItem key={r.id} value={`rule ${r.name} ${r.cron}`} onSelect={() => go('/rotate')}>
                  <Repeat strokeWidth={1.75} />
                  <span className="truncate">{r.name}</span>
                  <CommandShortcut className="font-mono">{r.cron}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
