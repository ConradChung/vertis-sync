import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Job search pipeline — read side for the dashboard panel.
//
// GET            -> the latest batches, newest first
// GET ?id=<uuid> -> one batch with its companies and kept contacts
//
// Reads use the cookie-based server client like /api/validate/status. The
// buttons live in ./[id]/action/route.ts.

const BATCH_COLUMNS =
  'id, batch_date, status, review_status, write_status, watchdog_status, companies_added, companies_pulled, ' +
  'companies_unresolved, contacts_total, contacts_kept, apollo_url, leadsfriday_order_id, leadsfriday_status, ' +
  'result_storage_path, error, created_at, updated_at'

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const id = request.nextUrl.searchParams.get('id')

    if (!id) {
      const { data, error } = await supabase
        .from('job_batches')
        .select(BATCH_COLUMNS)
        .order('batch_date', { ascending: false })
        .limit(30)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ batches: data ?? [] })
    }

    const [{ data: batch, error: batchError }, { data: companies, error: companiesError }, { data: contacts, error: contactsError }] =
      await Promise.all([
        supabase.from('job_batches').select(BATCH_COLUMNS).eq('id', id).single(),
        supabase
          .from('job_batch_companies')
          .select('id, company_name, domain, job_title, job_link, job_poster_name, employees, apollo_org_id, resolve_status, exclude_reason')
          .eq('batch_id', id)
          .order('resolve_status', { ascending: true })
          .order('company_name', { ascending: true })
          .limit(500),
        supabase
          .from('job_contacts')
          .select('id, company_id, company_name, first_name, last_name, title, email, linkedin_url, role, rank, seniority')
          .eq('batch_id', id)
          .eq('kept', true)
          .order('company_name', { ascending: true })
          .order('rank', { ascending: true })
          .limit(2000),
      ])

    if (batchError || !batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    if (companiesError) return NextResponse.json({ error: companiesError.message }, { status: 500 })
    if (contactsError) return NextResponse.json({ error: contactsError.message }, { status: 500 })

    return NextResponse.json({ batch, companies: companies ?? [], contacts: contacts ?? [] })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
