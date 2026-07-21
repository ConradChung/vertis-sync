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
      .select('id, storage_path, filename, column_order, icp_filter')
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

    // Otherwise build CSV from validation_rows. ICP filter applies only at
    // this export exit — it never re-triggers enrichment.
    let rowsQuery = supabase
      .from('validation_rows')
      .select('email, row_data')
      .eq('job_id', job_id)
      .eq('status', 'valid')
    if (job.icp_filter) {
      rowsQuery = rowsQuery.eq('row_data->>icp_status', 'confirmed')
    }
    const { data: validRows, error: rowsError } = await rowsQuery.order('row_index', { ascending: true })

    if (rowsError) {
      return NextResponse.json({ error: `Failed to fetch rows: ${rowsError.message}` }, { status: 500 })
    }

    let csv: string

    if (validRows && validRows.length > 0 && validRows[0].row_data) {
      // Full-column CSV: mirrors supabase/functions/email-validator's CSV build.
      const allKeys: string[] = job.column_order && job.column_order.length > 0
        ? job.column_order
        : Object.keys(validRows[0].row_data as Record<string, unknown>)
      const headerLine = allKeys.join(',')
      const dataLines = validRows.map(row => {
        const rowData = row.row_data as Record<string, unknown>
        return allKeys.map(key => {
          const val = rowData[key]
          if (val === null || val === undefined) return ''
          if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`
          const str = String(val)
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"`
            : str
        }).join(',')
      })
      csv = [headerLine, ...dataLines].join('\n')
    } else {
      const lines: string[] = ['email']
      for (const row of validRows ?? []) {
        lines.push(row.email)
      }
      csv = lines.join('\n')
    }

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
