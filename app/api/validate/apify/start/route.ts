// app/api/validate/apify/start/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN!
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID!

const CARGO_EXCLUSIONS = new Set([
  'Hazardous Materials', 'Livestock', 'Mobile Homes',
  'Motor Vehicles', 'Passengers', 'US Mail',
])

function assignCargoCategory(cargo: string[]): string {
  const s = new Set(cargo)
  if (s.size >= 6) return 'Mixed Generalist'
  if (['Refrigerated Food', 'Fresh Produce', 'Meat'].some(v => s.has(v))) return 'Refrigerated'
  if (['Liquids/Gases', 'Chemicals', 'Oilfield Equipment'].some(v => s.has(v))) return 'Tanker'
  if (['Metal: sheets, coils, rolls', 'Logs, Poles, Beams, Lumber', 'Machinery, Large Objects', 'Building Materials'].some(v => s.has(v))) return 'Specialty Flatbed'
  if (['Construction', 'Coal/Coke', 'Agricultural/Farm Supplies', 'Grain, Feed, Hay'].some(v => s.has(v))) return 'Construction/Agricultural'
  if (s.has('Household Goods')) return 'Household Goods'
  if (['Beverages', 'Paper Products', 'Commodities Dry Bulk'].some(v => s.has(v))) return 'Beverage/Paper/Dry Bulk'
  if (s.has('General Freight')) return 'General Freight'
  return 'Other'
}

function createServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } },
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApifyItem = Record<string, any>

interface FilterStats {
  raw: number
  dropped_not_carrier: number
  dropped_not_authorized_for_hire: number
  dropped_fleet_size: number
  dropped_stale_mcs150: number
  dropped_hazmat: number
  dropped_livestock: number
  dropped_mobile_homes: number
  dropped_motor_vehicles: number
  dropped_passengers: number
  dropped_us_mail: number
  final: number
}

interface CategoryStats {
  [category: string]: number
}

function applyFilters(items: ApifyItem[]): {
  filtered: (ApifyItem & { cargo_category: string; cargo_carried_raw: string })[]
  stats: FilterStats
} {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - 24)

  const stats: FilterStats = {
    raw: items.length,
    dropped_not_carrier: 0,
    dropped_not_authorized_for_hire: 0,
    dropped_fleet_size: 0,
    dropped_stale_mcs150: 0,
    dropped_hazmat: 0,
    dropped_livestock: 0,
    dropped_mobile_homes: 0,
    dropped_motor_vehicles: 0,
    dropped_passengers: 0,
    dropped_us_mail: 0,
    final: 0,
  }

  const filtered: (ApifyItem & { cargo_category: string; cargo_carried_raw: string })[] = []

  for (const item of items) {
    if (item.entity_type !== 'CARRIER') { stats.dropped_not_carrier++; continue }

    const ops: string[] = Array.isArray(item.operation_classification) ? item.operation_classification : []
    if (!ops.includes('AUTHORIZED FOR HIRE')) { stats.dropped_not_authorized_for_hire++; continue }

    const pu = Number(item.power_units)
    if (!Number.isInteger(pu) || pu < 5 || pu > 100) { stats.dropped_fleet_size++; continue }

    const mcsDate = item.mcs150_date ? new Date(item.mcs150_date) : null
    if (!mcsDate || isNaN(mcsDate.getTime()) || mcsDate < cutoff) { stats.dropped_stale_mcs150++; continue }

    const cargo: string[] = Array.isArray(item.cargo_carried) ? item.cargo_carried : []
    let excluded = false
    for (const reason of cargo) {
      if (reason === 'Hazardous Materials') { stats.dropped_hazmat++; excluded = true; break }
      if (reason === 'Livestock') { stats.dropped_livestock++; excluded = true; break }
      if (reason === 'Mobile Homes') { stats.dropped_mobile_homes++; excluded = true; break }
      if (reason === 'Motor Vehicles') { stats.dropped_motor_vehicles++; excluded = true; break }
      if (reason === 'Passengers') { stats.dropped_passengers++; excluded = true; break }
      if (reason === 'US Mail') { stats.dropped_us_mail++; excluded = true; break }
    }
    if (excluded) continue

    filtered.push({
      ...item,
      cargo_category: assignCargoCategory(cargo),
      cargo_carried_raw: cargo.join(';'),
    })
  }

  stats.final = filtered.length
  return { filtered, stats }
}

export async function POST(_request: NextRequest) {
  try {
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/last?token=${APIFY_API_TOKEN}&status=SUCCEEDED`,
    )
    if (!runRes.ok) {
      return NextResponse.json({ error: `Apify run fetch failed: ${runRes.status}` }, { status: 502 })
    }
    const runData = await runRes.json() as { data?: { defaultDatasetId?: string } }
    const datasetId = runData?.data?.defaultDatasetId
    if (!datasetId) {
      return NextResponse.json({ error: 'No successful Apify run found' }, { status: 404 })
    }

    const itemsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_TOKEN}&limit=99999`,
    )
    if (!itemsRes.ok) {
      return NextResponse.json({ error: `Apify dataset fetch failed: ${itemsRes.status}` }, { status: 502 })
    }
    const items = await itemsRes.json() as ApifyItem[]

    const { filtered, stats } = applyFilters(items)

    if (filtered.length === 0) {
      return NextResponse.json({ error: 'No records remain after filtering', stats }, { status: 422 })
    }

    const categoryStats: CategoryStats = {}
    for (const row of filtered) {
      categoryStats[row.cargo_category] = (categoryStats[row.cargo_category] ?? 0) + 1
    }

    const job_id = crypto.randomUUID()
    const supabase = createServiceClient()

    const { error: jobError } = await supabase
      .from('validation_jobs')
      .insert({
        id: job_id,
        filename: `apify_run_${new Date().toISOString().slice(0, 10)}.csv`,
        total_rows: filtered.length,
        processed_rows: 0,
        valid_count: 0,
        invalid_count: 0,
        status: 'pending',
        source: 'apify',
        filter_stats: { ...stats, category_stats: categoryStats },
      })

    if (jobError) {
      return NextResponse.json({ error: `Failed to create job: ${jobError.message}` }, { status: 500 })
    }

    const validationRows = filtered.map((row, i) => ({
      job_id,
      email: String(row.email ?? ''),
      row_index: i,
      status: 'pending',
      row_data: row,
    }))

    const { error: rowsError } = await supabase
      .from('validation_rows')
      .insert(validationRows)

    if (rowsError) {
      return NextResponse.json({ error: `Failed to insert rows: ${rowsError.message}` }, { status: 500 })
    }

    fetch(
      'https://rcfrumrbauwvyzfebxck.supabase.co/functions/v1/email-validator',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ job_id }),
      },
    ).catch(err => console.error('[validate/apify/start] Edge Function invoke error:', err))

    return NextResponse.json({ job_id, stats, category_stats: categoryStats })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
