'use client'

import { useMemo, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowUpDown } from 'lucide-react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CampaignBadge, LeadAvatar, RelTime, SourceBadge, StageBadge } from '@/components/crm/parts'
import type { CrmDealCard, CrmStage } from '@/lib/crm/types'
import { cn } from '@/lib/utils'

const ALL = '__all'

/** Table view: every deal, sortable, filtered by stage and owner. Row click opens the lead sheet. */
export function CrmTable({
  deals,
  stages,
  owners,
  campaignName,
  showCampaign,
  onOpen,
}: {
  deals: CrmDealCard[]
  stages: CrmStage[]
  owners: string[]
  campaignName: (id: string) => string
  showCampaign: boolean
  onOpen: (deal: CrmDealCard) => void
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'last_activity_at', desc: true }])
  const [stage, setStage] = useState(ALL)
  const [owner, setOwner] = useState(ALL)
  const filters: ColumnFiltersState = useMemo(
    () => [
      ...(stage !== ALL ? [{ id: 'stage', value: stage }] : []),
      ...(owner !== ALL ? [{ id: 'owner', value: owner }] : []),
    ],
    [stage, owner]
  )

  const columns = useMemo<ColumnDef<CrmDealCard>[]>(
    () => [
      {
        id: 'lead',
        header: 'Lead',
        accessorFn: (d) => d.name ?? d.email,
        cell: ({ row: { original: d } }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <LeadAvatar name={d.name} email={d.email} />
            <div className="min-w-0">
              <div className="truncate text-sm text-foreground">{d.name ?? d.email}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{d.email}</div>
            </div>
          </div>
        ),
      },
      { accessorKey: 'company', header: 'Company', cell: ({ getValue }) => <span className="truncate">{(getValue() as string | null) ?? '—'}</span> },
      { accessorKey: 'city', header: 'City', cell: ({ getValue }) => <span className="truncate text-muted-foreground">{(getValue() as string | null) ?? '—'}</span> },
      { accessorKey: 'stage', header: 'Stage', filterFn: 'equalsString', cell: ({ getValue }) => <StageBadge stage={getValue() as string} /> },
      {
        accessorKey: 'owner',
        header: 'Owner',
        filterFn: 'equalsString',
        cell: ({ getValue }) => <span className="text-muted-foreground">{(getValue() as string | null) ?? '—'}</span>,
      },
      {
        accessorKey: 'last_activity_at',
        header: 'Last touch',
        sortingFn: 'datetime',
        sortUndefined: 'last',
        cell: ({ getValue }) => <RelTime iso={getValue() as string | null} />,
      },
      {
        accessorKey: 'next_action_at',
        header: 'Next action',
        cell: ({ row: { original: d } }) =>
          d.next_action || d.next_action_at ? (
            <div className="min-w-0">
              <div className="truncate text-xs">{d.next_action ?? 'Follow up'}</div>
              <RelTime iso={d.next_action_at} />
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      { accessorKey: 'source', header: 'Source', cell: ({ getValue }) => <SourceBadge source={getValue() as string} /> },
      ...(showCampaign
        ? [{ id: 'campaign', header: 'Campaign', accessorFn: (d: CrmDealCard) => campaignName(d.campaign_id), cell: ({ getValue }: { getValue: () => unknown }) => <CampaignBadge name={String(getValue())} /> } as ColumnDef<CrmDealCard>]
        : []),
    ],
    [showCampaign, campaignName]
  )

  const table = useReactTable({
    data: deals,
    columns,
    state: { sorting, columnFilters: filters },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })
  const rows = table.getRowModel().rows

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect
          aria-label="Filter by stage"
          size="sm"
          className="w-44"
          value={stage}
          onValueChange={(v) => setStage(v || ALL)}
          options={[{ value: ALL, label: 'All stages' }, ...stages.map((s) => ({ value: s.name, label: s.name }))]}
        />
        <SimpleSelect
          aria-label="Filter by owner"
          size="sm"
          className="w-40"
          value={owner}
          onValueChange={(v) => setOwner(v || ALL)}
          options={[{ value: ALL, label: 'Any owner' }, ...owners.map((o) => ({ value: o, label: o }))]}
        />
        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
          {rows.length} of {deals.length}
        </span>
      </div>
      <div className="glass overflow-hidden rounded-xl">
        <Table>
          <TableHeader className="bg-(--glass-fill)">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((h) => (
                  <TableHead key={h.id} className="h-8 text-xs font-normal text-muted-foreground first:pl-4 last:pr-4">
                    {h.column.getCanSort() ? (
                      <button type="button" onClick={h.column.getToggleSortingHandler()} className="inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <ArrowUpDown size={12} strokeWidth={1.75} className={h.column.getIsSorted() ? 'opacity-100' : 'opacity-40'} aria-hidden />
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="py-8 text-center text-sm text-muted-foreground">
                  No deals match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  tabIndex={0}
                  onClick={() => onOpen(row.original)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpen(row.original)
                  }}
                  className={cn('cursor-pointer outline-none hover:bg-accent focus-visible:bg-accent')}
                  data-testid="crm-row"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="max-w-[240px] py-2 first:pl-4 last:pr-4">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
