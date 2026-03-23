import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  try {
    const job_id = request.nextUrl.searchParams.get('job_id')

    if (!job_id) {
      return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
    }

    const supabase = await createClient()

    // Fetch job to check storage_path
    const { data: job, error: jobError } = await supabase
      .from('validation_jobs')
      .select('id, storage_path, filename')
      .eq('id', job_id)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // If storage_path is set (completed with uploaded CSV), return signed URL
    if (job.storage_path) {
      const { data, error: urlError } = await supabase.storage
        .from('validation-results')
        .createSignedUrl(job.storage_path, 3600)

      if (urlError || !data?.signedUrl) {
        return NextResponse.json({ error: 'Failed to generate signed URL' }, { status: 500 })
      }

      return NextResponse.json({ signedUrl: data.signedUrl })
    }

    // Otherwise build CSV from validation_rows
    const { data: validRows, error: rowsError } = await supabase
      .from('validation_rows')
      .select('email')
      .eq('job_id', job_id)
      .eq('status', 'valid')
      .order('row_index', { ascending: true })

    if (rowsError) {
      return NextResponse.json({ error: `Failed to fetch rows: ${rowsError.message}` }, { status: 500 })
    }

    const lines: string[] = ['email']
    for (const row of validRows ?? []) {
      lines.push(row.email)
    }
    const csv = lines.join('\n')

    const baseName = (job.filename ?? 'validated_emails').replace(/\.csv$/i, '')
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${baseName}_validated.csv"`,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
