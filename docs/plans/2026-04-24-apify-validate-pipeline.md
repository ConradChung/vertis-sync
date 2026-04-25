# Apify Validate Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Pull the last Apify actor run, filter FMCSA carriers to a target segment, assign cargo categories, validate emails through the existing edge function, and surface results on the Vertis Sync dashboard with a Claude Code skill as the trigger.

**Architecture:** New Next.js route `/api/validate/apify/start` handles Apify fetch + filtering + categorization (fast, ~1-2s) then fires the existing `email-validator` edge function with a `job_id` (slow, async). The edge function detects `source: 'apify'` jobs and builds a full-column CSV instead of email-only. A Claude Code skill file orchestrates the trigger, prints the filter report, and polls status.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (Postgres + Storage + Edge Functions via Deno), Apify REST API v2, existing MailTester Ninja validator.

---

## Task 1: New API Route — `/api/validate/apify/start`

**Files:**
- Create: `app/api/validate/apify/start/route.ts`

This route fetches the last successful Apify actor run, applies all filters, assigns cargo categories, bulk-inserts rows into Supabase, then fires the edge function.

**Step 1: Create the file**

```typescript
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
    // HARD FILTER 1: entity_type must be CARRIER
    if (item.entity_type !== 'CARRIER') { stats.dropped_not_carrier++; continue }

    // HARD FILTER 2: operation_classification must contain AUTHORIZED FOR HIRE
    const ops: string[] = Array.isArray(item.operation_classification) ? item.operation_classification : []
    if (!ops.includes('AUTHORIZED FOR HIRE')) { stats.dropped_not_authorized_for_hire++; continue }

    // HARD FILTER 3: power_units between 5 and 100 inclusive
    const pu = Number(item.power_units)
    if (!Number.isInteger(pu) || pu < 5 || pu > 100) { stats.dropped_fleet_size++; continue }

    // HARD FILTER 4: mcs150_date within last 24 months
    const mcsDate = item.mcs150_date ? new Date(item.mcs150_date) : null
    if (!mcsDate || isNaN(mcsDate.getTime()) || mcsDate < cutoff) { stats.dropped_stale_mcs150++; continue }

    // CARGO EXCLUSIONS — track each exclusion reason separately, drop on first hit
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
    // 1. Fetch last successful run from Apify
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

    // 2. Fetch all dataset items (paginate if needed, 99999 covers typical runs)
    const itemsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_TOKEN}&limit=99999`,
    )
    if (!itemsRes.ok) {
      return NextResponse.json({ error: `Apify dataset fetch failed: ${itemsRes.status}` }, { status: 502 })
    }
    const items = await itemsRes.json() as ApifyItem[]

    // 3. Apply filters + categorize
    const { filtered, stats } = applyFilters(items)

    if (filtered.length === 0) {
      return NextResponse.json({ error: 'No records remain after filtering', stats }, { status: 422 })
    }

    // 4. Category breakdown
    const categoryStats: CategoryStats = {}
    for (const row of filtered) {
      categoryStats[row.cargo_category] = (categoryStats[row.cargo_category] ?? 0) + 1
    }

    // 5. Create validation job
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

    // 6. Bulk insert validation_rows with full row_data
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

    // 7. Fire-and-forget edge function
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
```

**Step 2: Commit**

```bash
cd /Users/conradchung/vertis-sync
git add app/api/validate/apify/start/route.ts
git commit -m "feat: add /api/validate/apify/start route with FMCSA filtering and cargo categorization"
```

---

## Task 2: Update Edge Function for Apify CSV Output

**Files:**
- Modify: `supabase/functions/email-validator/index.ts`

The edge function needs to know the job's `source` field and, for Apify jobs, build the output CSV from the full `row_data` JSONB with all columns instead of email-only.

**Step 1: Add `source` and `row_data` to the interfaces**

In `supabase/functions/email-validator/index.ts`, update the two interfaces (lines 44–63):

```typescript
interface ValidationRow {
  id: string
  job_id: string
  email: string
  row_index: number
  status: string
  validation_result: unknown
  row_data: Record<string, unknown> | null  // add this line
}

interface ValidationJob {
  id: string
  filename: string
  total_rows: number
  processed_rows: number
  valid_count: number
  invalid_count: number
  status: string
  error_message: string | null
  storage_path: string | null
  source: string  // add this line
}
```

**Step 2: Add `source` to the job fetch query**

Find the GET request for job metadata (around line 111) and add `source` to the select:

```typescript
const jobs = (await supabaseRequest(
  'GET',
  `validation_jobs?id=eq.${jobId}&select=id,total_rows,processed_rows,valid_count,invalid_count,source`,
)) as ValidationJob[]
```

**Step 3: Replace the CSV build block (lines 184–193) with source-aware logic**

Find the block starting with `// 4. Build valid-only CSV` and replace everything from that comment through the `const csvContent = csvLines.join('\n')` line with:

```typescript
  // 4. Build CSV and upload to Storage
  const validRows = (await supabaseRequest(
    'GET',
    `validation_rows?job_id=eq.${jobId}&status=eq.valid&order=row_index.asc&select=email,row_data`,
  )) as ValidationRow[]

  let csvContent: string

  if (job.source === 'apify' && validRows.length > 0 && validRows[0].row_data) {
    // Full-column CSV: all row_data fields, nested objects JSON-stringified
    const allKeys = Object.keys(validRows[0].row_data)
    const headers = allKeys.join(',')
    const dataLines = validRows.map(row => {
      return allKeys.map(key => {
        const val = row.row_data![key]
        if (val === null || val === undefined) return ''
        if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`
        const str = String(val)
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str
      }).join(',')
    })
    csvContent = [headers, ...dataLines].join('\n')
  } else {
    // Email-only CSV for regular jobs
    const csvLines: string[] = ['email']
    for (const row of validRows) csvLines.push(row.email)
    csvContent = csvLines.join('\n')
  }
```

**Step 4: Commit**

```bash
cd /Users/conradchung/vertis-sync
git add supabase/functions/email-validator/index.ts
git commit -m "feat: build full-column CSV for apify-sourced validation jobs"
```

---

## Task 3: Add Apify Badge to Dashboard

**Files:**
- Modify: `components/EmailValidator.tsx`

**Step 1: Add `source` to the `ValidationRun` interface (line 8)**

```typescript
interface ValidationRun {
  id: string
  filename: string
  total_rows: number
  valid_count: number
  invalid_count: number
  processed_rows: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  error_message: string | null
  storage_path: string | null
  created_at: string
  source: 'csv' | 'apify'  // add this line
}
```

**Step 2: In the previous runs list (around line 490), add the Apify badge after the filename**

Find the block that renders `run.filename` — it looks like:
```tsx
<p className="text-[13px] text-[var(--text-primary)] truncate">{run.filename}</p>
```

Replace it with:
```tsx
<div className="flex items-center gap-1.5 min-w-0">
  <p className="text-[13px] text-[var(--text-primary)] truncate">{run.filename}</p>
  {run.source === 'apify' && (
    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20">
      Apify
    </span>
  )}
</div>
```

**Step 3: Commit**

```bash
cd /Users/conradchung/vertis-sync
git add components/EmailValidator.tsx
git commit -m "feat: show Apify source badge on dashboard runs"
```

---

## Task 4: Create Claude Code Skill

**Files:**
- Create: `/Users/conradchung/.claude/skills/apify-validate/SKILL.md`

**Step 1: Create the skill directory and file**

```bash
mkdir -p /Users/conradchung/.claude/skills/apify-validate
```

**Step 2: Write the skill file**

```markdown
---
name: apify-validate
description: Pull last Apify actor run, filter FMCSA carriers, validate emails through Vertis Sync
---

# Apify → Validate Pipeline

Trigger the Vertis Sync Apify validation pipeline: fetch last actor run, filter carriers, validate emails.

## Steps

### 1. Start the job

Run this exact curl command and capture the full JSON response:

```bash
curl -s -X POST https://northstarcrm.vercel.app/api/validate/apify/start \
  -H "Content-Type: application/json"
```

If the response contains `"error"`, print the error and stop.

### 2. Print filter report

From the response JSON, print the following in this exact format:

```
--- FMCSA Filter Report ---
Raw records:              {stats.raw}
  Dropped (not CARRIER):  {stats.dropped_not_carrier}
  Dropped (not auth hire):{stats.dropped_not_authorized_for_hire}
  Dropped (fleet size):   {stats.dropped_fleet_size}
  Dropped (stale MCS150): {stats.dropped_stale_mcs150}
  Dropped (hazmat):       {stats.dropped_hazmat}
  Dropped (livestock):    {stats.dropped_livestock}
  Dropped (mobile homes): {stats.dropped_mobile_homes}
  Dropped (motor veh.):   {stats.dropped_motor_vehicles}
  Dropped (passengers):   {stats.dropped_passengers}
  Dropped (US Mail):      {stats.dropped_us_mail}
Final records:            {stats.final}
```

### 3. Print category breakdown

Print category_stats sorted by count descending:

```
--- Cargo Category Breakdown ---
{category}: {count}
...
```

### 4. Poll for completion

Extract `job_id` from the response. Then poll every 5 seconds:

```bash
curl -s "https://northstarcrm.vercel.app/api/validate/status?job_id={job_id}"
```

Print progress each poll: `Validating... {processed_rows}/{total_rows} ({valid_count} valid so far)`

Stop polling when `status` is `"completed"` or `"failed"`.

### 5. Print final result

On completion:
```
--- Validation Complete ---
Valid leads: {valid_count} / {total_rows}
Download ready on dashboard: https://northstarcrm.vercel.app/dashboard
```

On failure:
```
--- Validation Failed ---
Error: {error_message}
```
```

**Step 3: Commit the skill**

```bash
git -C /Users/conradchung add .claude/skills/apify-validate/SKILL.md
git -C /Users/conradchung commit -m "feat: add apify-validate Claude Code skill"
```

---

## Task 5: Push All Changes

**Step 1: Push vertis-sync commits to GitHub**

```bash
cd /Users/conradchung/vertis-sync
git push origin main
```

Vercel will auto-deploy on push. Wait ~60 seconds for the deployment to go live before testing.

**Step 2: Verify deployment**

```bash
curl -s -X POST https://northstarcrm.vercel.app/api/validate/apify/start | python3 -m json.tool
```

Expected: JSON with `job_id`, `stats`, `category_stats` — or a meaningful error if Apify returns no runs.

**Step 3: Test the skill**

In a new Claude Code session, type `/apify-validate` and verify:
- Filter report prints correctly
- Category breakdown prints correctly  
- Polling updates every 5s
- Completion message appears
- Run shows on dashboard with Apify badge
```
