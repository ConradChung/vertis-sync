import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

async function triggerWebhooks(payload: Record<string, unknown>) {
  const notionKey = process.env.NOTION_API_KEY
  const dbId = process.env.NOTION_DATABASE_ID
  const n8nUrl = process.env.N8N_WEBHOOK_URL

  const formatList = (arr?: string[]) => arr?.join(', ') || 'None'

  const notionBlocks = [
    { label: 'Industries', value: formatList(payload.industries as string[]) },
    { label: 'Company Size', value: formatList(payload.company_size as string[]) },
    { label: 'Revenue Ranges', value: formatList(payload.revenue_ranges as string[]) },
    { label: 'Locations', value: formatList(payload.locations as string[]) },
    { label: 'Buying Signals', value: formatList(payload.buying_signals as string[]) },
    { label: 'Job Titles (Include)', value: formatList(payload.job_titles_include as string[]) },
    { label: 'Job Titles (Exclude)', value: formatList(payload.job_titles_exclude as string[]) },
    { label: 'Keywords (Include)', value: formatList(payload.keywords_include as string[]) },
    { label: 'Keywords (Exclude)', value: formatList(payload.keywords_exclude as string[]) },
    { label: 'CTA Type', value: String(payload.cta_type || '') },
    { label: 'Deal Size', value: String(payload.deal_size_range || '') },
    { label: 'Offer Description', value: String(payload.offer_description || '') },
    { label: 'Best Customer', value: String(payload.best_customer_description || '') },
    { label: 'Calendly Link', value: String(payload.calendly_link || '') },
  ]

  await Promise.allSettled([
    notionKey && dbId
      ? fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${notionKey}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            parent: { database_id: dbId },
            properties: {
              Name: {
                title: [{ text: { content: `${payload.company_name || 'Client'} — ICP Form` } }],
              },
            },
            children: notionBlocks.map(({ label, value }) => ({
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  { type: 'text', text: { content: `${label}: ` }, annotations: { bold: true } },
                  { type: 'text', text: { content: value } },
                ],
              },
            })),
          }),
        })
      : Promise.resolve(),
    n8nUrl
      ? fetch(n8nUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      : Promise.resolve(),
  ])
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { stage, data } = await request.json()

  if (stage === 1) {
    await supabase.from('stage1_onboarding').upsert(
      { ...data, client_id: user.id, completed: true },
      { onConflict: 'client_id' }
    )
    await supabase.from('profiles').update({ onboarding_stage: 2 }).eq('id', user.id)
  } else if (stage === 2) {
    await supabase.from('stage2_onboarding').upsert(
      { ...data, client_id: user.id, completed: true },
      { onConflict: 'client_id' }
    )
    await supabase.from('profiles').update({ onboarding_stage: 3 }).eq('id', user.id)
  } else if (stage === 3) {
    await supabase.from('onboarding_forms').upsert(
      { ...data, client_id: user.id, completed: true, completed_at: new Date().toISOString() },
      { onConflict: 'client_id' }
    )
    await supabase.from('profiles').update({ onboarding_stage: 4 }).eq('id', user.id)

    // Fetch profile for company name
    const { data: profile } = await supabase.from('profiles').select('company_name').eq('id', user.id).single()

    // Trigger Notion + n8n (non-blocking)
    triggerWebhooks({ ...data, client_id: user.id, company_name: profile?.company_name }).catch(() => {})
  } else {
    return NextResponse.json({ error: 'Invalid stage' }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
