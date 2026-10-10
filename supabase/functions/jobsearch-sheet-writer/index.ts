// Supabase Edge Function: jobsearch-sheet-writer
// Gate 2's "Write" action. Appends a batch's kept contacts to the gtm tab in
// the tab's own header order (read at run time), skips emails gtm already has,
// writes the same rows to Storage for the record, and tells the owner.
//
// POST {batch_id}. The batch must be `ranked`; telegram-inbox / the dashboard
// have already claimed write_status before invoking this.
//
// Helpers copied from telegram-inbox/index.ts.

import { normalizeDomain, type Role, toCsv } from '../_shared/jobsearch/pure.ts'
import { appendRows, getAccessToken, readRange, sheetTabLink } from '../_shared/jobsearch/sheets.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''
const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? ''
const JOBSEARCH_SHEET_ID = Deno.env.get('JOBSEARCH_SHEET_ID') ?? '1wjvpjyX2g7UUkjgeOXRtPEb7-s4MQfmPOgikalpthcs'
const GTM_GID = 1642822363
const STORAGE_BUCKET = 'leadsfriday-results'

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

async function supabaseRequest(
  method: string,
  path: string,
  body?: unknown,
  opts?: { returning?: boolean },
): Promise<unknown> {
  const headers = { ...REST_HEADERS }
  if (opts?.returning) headers['Prefer'] = 'return=representation'
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return res.json()
  return null
}

async function sendTelegram(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    })
  } catch {
    // Non-critical
  }
}

interface JobBatch {
  id: string
  batch_date: string
  status: string
}

interface Company {
  id: string
  company_name: string
  domain: string | null
  job_title: string | null
  job_link: string | null
  salary_text: string | null
  posted_at: string | null
  employees: number | null
  industries: string | null
  other_titles: string | null
  n_postings: string | null
  funding_stage: string | null
  yc_batch: string | null
  fit_tier: number | null
}

interface Contact {
  id: string
  company_id: string | null
  company_name: string
  domain: string | null
  first_name: string | null
  last_name: string | null
  title: string | null
  email: string | null
  linkedin_url: string | null
  seniority: string | null
  corporate_phone: string | null
  role: Role
  rank: number
}

function formatBatchDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

// One gtm row for one kept contact, keyed by gtm header name. Anything the
// tab has that is not listed here is written as ''.
export function gtmRecord(c: Contact, company: Company | undefined): Record<string, string> {
  const founderSide = c.role === 'founder' || c.role === 'job_poster'
  const employees = company?.employees ?? null
  return {
    linkedinUrl: c.linkedin_url ?? '',
    firstName: c.first_name ?? '',
    lastName: c.last_name ?? '',
    email: c.email ?? '',
    company: c.company_name,
    status: 'Send Email Direct',
    'email sent': 'Needs Sending',
    'linkedin sent': 'Needs Sending',
    jobLink: company?.job_link ?? '',
    campaign: founderSide ? 'A_startup_founders' : 'B_recruiters_sales',
    contactOrder: String(c.rank),
    isJobPoster: c.role === 'job_poster' ? 'TRUE' : 'FALSE',
    openRole: company?.job_title ?? '',
    otherRoles: company?.other_titles ?? '',
    nPostings: company?.n_postings ?? '',
    roleFitTier: String(company?.fit_tier ?? 1),
    salary: company?.salary_text ?? '',
    postedAt: company?.posted_at ?? '',
    fundingStage: company?.funding_stage ?? '',
    employees: employees === null ? '' : String(employees),
    industry: company?.industries ?? '',
    corporatePhone: c.corporate_phone ?? '',
    listSource: 'leadsfriday',
    domain: c.domain ?? company?.domain ?? '',
    lowData: c.email ? 'FALSE' : 'TRUE',
    priority: employees !== null && employees <= 50 ? 'High' : 'Medium',
    seniorityLevel: c.seniority ?? '',
    ycBatch: company?.yc_batch ?? '',
    roleType: 'GTM',
  }
}

async function write(batchId: string): Promise<{ written: number; skipped: number }> {
  const batches = (await supabaseRequest(
    'GET', `job_batches?id=eq.${batchId}&select=id,batch_date,status&limit=1`,
  )) as JobBatch[]
  const batch = batches?.[0]
  if (!batch) throw new Error(`job batch ${batchId} not found`)
  if (batch.status !== 'ranked') throw new Error(`batch is ${batch.status}, not ranked`)

  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON secret is not set')
  const token = await getAccessToken(GOOGLE_SERVICE_ACCOUNT_JSON)

  const grid = await readRange(token, JOBSEARCH_SHEET_ID, 'gtm!A1:ZZ')
  if (grid.length === 0 || grid[0].length === 0) throw new Error('gtm tab has no header row')
  const headers = grid[0]
  const emailCol = headers.findIndex(h => h.trim().toLowerCase() === 'email')
  const existingEmails = new Set<string>()
  if (emailCol >= 0) {
    for (const r of grid.slice(1)) {
      const e = (r[emailCol] ?? '').trim().toLowerCase()
      if (e) existingEmails.add(e)
    }
  }

  const contacts = (await supabaseRequest(
    'GET',
    `job_contacts?batch_id=eq.${batchId}&kept=is.true` +
    `&select=id,company_id,company_name,domain,first_name,last_name,title,email,linkedin_url,seniority,corporate_phone,role,rank` +
    `&order=company_name.asc,rank.asc&limit=2000`,
  )) as Contact[]
  const companies = (await supabaseRequest(
    'GET',
    `job_batch_companies?batch_id=eq.${batchId}` +
    `&select=id,company_name,domain,job_title,job_link,salary_text,posted_at,employees,industries,other_titles,n_postings,funding_stage,yc_batch,fit_tier&limit=500`,
  )) as Company[]
  const companyById = new Map(companies.map(c => [c.id, c]))
  const companyByDomain = new Map(companies.filter(c => c.domain).map(c => [c.domain!, c]))

  const rows: string[][] = []
  let skipped = 0
  for (const c of contacts) {
    const email = (c.email ?? '').toLowerCase()
    if (email && existingEmails.has(email)) { skipped++; continue }
    const company = (c.company_id && companyById.get(c.company_id)) ||
      (c.domain && companyByDomain.get(normalizeDomain(c.domain))) || undefined
    const rec = gtmRecord(c, company)
    rows.push(headers.map(h => rec[h] ?? rec[h.trim()] ?? ''))
    if (email) existingEmails.add(email) // the same email twice in one batch is written once
  }

  if (rows.length > 0) {
    await appendRows(token, JOBSEARCH_SHEET_ID, 'gtm!A1', rows)
    const csv = toCsv(headers, rows)
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${batchId}-gtm.csv`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'text/csv',
        'x-upsert': 'true',
      },
      body: csv,
    })
    if (!res.ok) console.warn(`[jobsearch-sheet-writer] Storage copy failed (${res.status}): ${await res.text()}`)
  }

  const claimed = (await supabaseRequest(
    'PATCH',
    `job_batches?id=eq.${batchId}&status=eq.ranked`,
    { status: 'written' },
    { returning: true },
  )) as JobBatch[]
  if (!claimed?.length) throw new Error('batch left ranked while writing; not marking written')

  const link = sheetTabLink(JOBSEARCH_SHEET_ID, GTM_GID)
  await sendTelegram(
    `✍️ ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} written to gtm — batch ${formatBatchDate(batch.batch_date)}` +
    (skipped ? `\n${skipped} already present, skipped` : '') +
    `\n${link}`,
  )
  return { written: rows.length, skipped }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let batchId: string | undefined
  try {
    batchId = ((await req.json()) as { batch_id?: string }).batch_id
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  if (!batchId) {
    return new Response(JSON.stringify({ error: 'batch_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const work = write(batchId).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[jobsearch-sheet-writer]', message)
    const rows = (await supabaseRequest(
      'PATCH',
      `job_batches?id=eq.${batchId}&status=eq.ranked`,
      { status: 'failed', error: message },
      { returning: true },
    ).catch(() => null)) as JobBatch[] | null
    if (rows?.length) await sendTelegram(`❌ Writing batch ${formatBatchDate(rows[0].batch_date)} to gtm failed\n${message}`)
  })
  EdgeRuntime.waitUntil(work)

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
