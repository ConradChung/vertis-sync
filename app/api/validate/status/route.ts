import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  try {
    const job_id = request.nextUrl.searchParams.get('job_id')

    if (!job_id) {
      return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
    }

    const supabase = await createClient()

    const { data: job, error } = await supabase
      .from('validation_jobs')
      .select('id, filename, total_rows, processed_rows, valid_count, invalid_count, status, error_message, storage_path, created_at')
      .eq('id', job_id)
      .single()

    if (error || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    return NextResponse.json({
      job_id: job.id,
      status: job.status,
      processed_rows: job.processed_rows ?? 0,
      total_rows: job.total_rows,
      valid_count: job.valid_count ?? 0,
      invalid_count: job.invalid_count ?? 0,
      error_message: job.error_message ?? null,
      storage_path: job.storage_path ?? null,
      filename: job.filename,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
