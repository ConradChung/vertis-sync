const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY!
const INSTANTLY_BASE_URL = 'https://api.instantly.ai/api/v2'

const headers = {
  'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
}

export interface CampaignAnalytics {
  total_sent: number
  total_replies: number
  total_positive_replies: number
  reply_rate: number
  positive_reply_rate: number
}

export interface StepAnalytics {
  step: number
  variant: string | null
  sent: number
  opened: number
  replied: number
  reply_rate: number
  clicked: number
  opportunities: number
}

export interface DailyAnalytics {
  date: string
  sent: number
  contacted: number
  replies: number
  unique_replies: number
  opened: number
  unique_opened: number
  clicks: number
  unique_clicks: number
  opportunities: number
  unique_opportunities: number
}

export async function getDailyAnalytics(campaignId: string): Promise<DailyAnalytics[]> {
  const response = await fetch(
    `${INSTANTLY_BASE_URL}/campaigns/analytics/daily?campaign_id=${campaignId}`,
    { headers, cache: 'no-store' }
  )

  if (!response.ok) {
    throw new Error('Failed to fetch campaign analytics')
  }

  return response.json()
}

export async function getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
  const response = await fetch(
    `${INSTANTLY_BASE_URL}/campaigns/analytics/overview?id=${campaignId}`,
    { headers, cache: 'no-store' }
  )

  if (!response.ok) {
    throw new Error('Failed to fetch analytics overview')
  }

  const data = await response.json()
  console.log('[instantly/overview] raw:', JSON.stringify(data, null, 2))

  const totalSent = data.new_leads_contacted_count ?? data.contacted_count ?? 0
  const totalReplies = data.reply_count ?? data.reply_count_unique ?? 0
  const totalOpportunities = data.total_opportunities ?? 0

  return {
    total_sent: totalSent,
    total_replies: totalReplies,
    total_positive_replies: totalOpportunities,
    reply_rate: totalSent > 0 ? (totalReplies / totalSent) * 100 : 0,
    positive_reply_rate: totalReplies > 0 ? (totalOpportunities / totalReplies) * 100 : 0,
  }
}

export async function getStepAnalytics(campaignId: string): Promise<StepAnalytics[]> {
  const response = await fetch(
    `${INSTANTLY_BASE_URL}/campaigns/analytics/steps?campaign_id=${campaignId}`,
    { headers, cache: 'no-store' }
  )

  if (!response.ok) {
    return []
  }

  const data = await response.json()
  console.log('[instantly/steps] raw:', JSON.stringify(data, null, 2))
  if (!Array.isArray(data)) return []

  // Filter out null steps and parse raw rows
  const VARIANT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const rows = data
    .filter((s: Record<string, unknown>) => s.step !== 'null' && s.step !== null)
    .map((s: Record<string, unknown>) => {
      const stepNum = parseInt(String(s.step), 10)
      const variantIdx = s.variant != null ? parseInt(String(s.variant), 10) : -1
      const sent = (s.sent as number) ?? 0
      const replied = (s.replies as number) ?? (s.unique_replies as number) ?? 0
      return {
        step: stepNum + 1,  // 0-indexed → 1-indexed
        variant: variantIdx >= 0 ? VARIANT_LETTERS[variantIdx] ?? String(variantIdx) : null,
        sent,
        opened: (s.unique_opened as number) ?? (s.opened as number) ?? 0,
        replied,
        reply_rate: sent > 0 ? (replied / sent) * 100 : 0,
        clicked: (s.unique_clicks as number) ?? (s.clicks as number) ?? 0,
        opportunities: 0,
      }
    })

  // Group by step and create parent aggregate rows
  const grouped = new Map<number, StepAnalytics[]>()
  for (const row of rows) {
    if (!grouped.has(row.step)) grouped.set(row.step, [])
    grouped.get(row.step)!.push(row)
  }

  const result: StepAnalytics[] = []
  for (const [stepNum, variants] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    // Parent row: aggregate of all variants
    const agg = { step: stepNum, variant: null, sent: 0, opened: 0, replied: 0, reply_rate: 0, clicked: 0, opportunities: 0 }
    for (const v of variants) {
      agg.sent += v.sent
      agg.opened += v.opened
      agg.replied += v.replied
      agg.clicked += v.clicked
    }
    agg.reply_rate = agg.sent > 0 ? (agg.replied / agg.sent) * 100 : 0
    result.push(agg)
    // Only show variant sub-rows if there are multiple
    if (variants.length > 1) {
      result.push(...variants.sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? '')))
    }
  }

  return result
}
