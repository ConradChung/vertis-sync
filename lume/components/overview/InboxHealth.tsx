'use client'

import { useState } from 'react'
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { GlassCard } from '@/components/ui/glass-card'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyLine, HealthDot, NotConnected, SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { accountHealth } from '@/lib/overview/compute'
import type { InstantlyAccount } from '@/lib/adapters/instantly.map'
import type { HealthLevel, OverviewInstantly } from '@/lib/overview/types'
import { cn } from '@/lib/utils'

const label = (s: string) => s.replace(/_/g, ' ')

const BAR: Record<HealthLevel, string> = {
  green: '[&_[data-slot=progress-indicator]]:bg-lime light:[&_[data-slot=progress-track]]:bg-olive/20',
  amber: '[&_[data-slot=progress-indicator]]:bg-violet',
  red: '[&_[data-slot=progress-indicator]]:bg-destructive',
  idle: '[&_[data-slot=progress-indicator]]:bg-white/35',
}

const columns: ColumnDef<InstantlyAccount>[] = [
  {
    accessorKey: 'email',
    header: 'Account',
    cell: ({ row }) => (
      <span className="block max-w-[240px] truncate font-mono text-xs text-foreground" title={row.original.email}>
        {row.original.email}
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    accessorFn: (a) => (a.warmup_status === 'active' ? a.status : a.warmup_status),
    cell: ({ row }) => {
      const a = row.original
      const h = accountHealth(a)
      return (
        <span className="inline-flex items-center gap-2 whitespace-nowrap text-muted-foreground">
          <HealthDot level={h.level} reason={h.reason} />
          {label(a.warmup_status === 'active' ? a.status : a.warmup_status)}
        </span>
      )
    },
  },
  {
    accessorKey: 'warmup_score',
    header: 'Warmup',
    sortUndefined: 'last',
    cell: ({ row }) => {
      const a = row.original
      if (a.warmup_score === null) return <span className="font-mono text-white/25">—</span>
      const h = accountHealth(a)
      return (
        <div className="flex min-w-[120px] items-center gap-3">
          <Progress value={a.warmup_score} aria-label={`Warmup ${a.warmup_score}%`} className={cn('flex-1', BAR[h.level])} />
          <span className="w-9 text-right font-mono text-xs tabular-nums">{a.warmup_score}%</span>
        </div>
      )
    },
  },
  {
    accessorKey: 'daily_limit',
    header: 'Daily cap',
    cell: ({ row }) => <span className="block text-right font-mono text-xs tabular-nums">{row.original.daily_limit ?? '—'}</span>,
  },
]

function AccountsTable({ accounts }: { accounts: InstantlyAccount[] }) {
  const [sorting, setSorting] = useState<SortingState>([])
  const table = useReactTable({ data: accounts, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() })

  return (
    <Table>
      <TableHeader className="bg-(--glass-fill)">
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id} className="hover:bg-transparent">
            {hg.headers.map((h) => {
              const sorted = h.column.getIsSorted()
              const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown
              const right = h.column.id === 'daily_limit'
              return (
                <TableHead key={h.id} className={cn('h-8 text-xs font-normal text-muted-foreground first:pl-5 last:pr-5', right && 'text-right')} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}>
                  <button type="button" onClick={h.column.getToggleSortingHandler()} className={cn('inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', right && 'flex-row-reverse')}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    <Icon size={12} strokeWidth={1.75} className={sorted ? 'opacity-100' : 'opacity-40'} aria-hidden />
                  </button>
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id} className="text-white/70 hover:bg-accent">
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id} className="py-2.5 first:pl-5 last:pr-5">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** `instantly` undefined = still loading (or the request failed: `failed`). Accounts show even when analytics failed. */
export function InboxHealth({ instantly, failed = false }: { instantly: OverviewInstantly | undefined; failed?: boolean }) {
  const accounts = instantly?.configured ? instantly.accounts : undefined

  return (
    <GlassCard className="gap-0 py-0" aria-label="Inbox health">
      <SectionTitle title="Inbox health">{accounts && <span className="font-mono tabular-nums">{accounts.length} accounts</span>}</SectionTitle>
      {!instantly && !failed ? (
        <div className="space-y-3 px-5 pt-1 pb-6" aria-hidden>
          <ShimmerBar className="h-3 w-full" />
          <ShimmerBar className="h-3 w-5/6" />
          <ShimmerBar className="h-3 w-2/3" />
        </div>
      ) : instantly && !instantly.configured ? (
        <div className="px-5 pt-1 pb-6">
          <NotConnected />
        </div>
      ) : !accounts ? (
        <div className="px-5 pt-1 pb-6">
          <NotConnected>Instantly accounts unavailable — retrying</NotConnected>
        </div>
      ) : accounts.length === 0 ? (
        <EmptyLine text="No sending accounts in Instantly." action={{ label: 'Instantly accounts', href: 'https://app.instantly.ai/app/accounts', external: true }} />
      ) : (
        <AccountsTable accounts={accounts} />
      )}
    </GlassCard>
  )
}
