const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY!
const INSTANTLY_BASE_URL = 'https://api.instantly.ai/api/v1'

export interface CampaignAnalytics {
  total_sent: number
  total_replies: number
  total_positive_replies: number
  reply_rate: number
  positive_reply_rate: number
}

export interface Reply {
  id: string
  sender_name: string
  subject: string
  snippet: string
  timestamp: string
}

export async function getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
  const response = await fetch(
    `${INSTANTLY_BASE_URL}/analytics/campaign/summary?campaign_id=${campaignId}&api_key=${INSTANTLY_API_KEY}`,
    {
      cache: 'no-store',
    }
  )

  if (!response.ok) {
    throw new Error('Failed to fetch campaign analytics')
  }

  const data = await response.json()
  
  // Calculate rates
  const totalSent = data.total_sent || 0
  const totalReplies = data.total_replies || 0
  const totalPositiveReplies = data.total_positive_replies || 0
  
  return {
    total_sent: totalSent,
    total_replies: totalReplies,
    total_positive_replies: totalPositiveReplies,
    reply_rate: totalSent > 0 ? (totalReplies / totalSent) * 100 : 0,
    positive_reply_rate: totalReplies > 0 ? (totalPositiveReplies / totalReplies) * 100 : 0,
  }
}

export async function getRecentReplies(campaignId: string, limit: number = 10): Promise<Reply[]> {
  const response = await fetch(
    `${INSTANTLY_BASE_URL}/analytics/campaign/replies?campaign_id=${campaignId}&api_key=${INSTANTLY_API_KEY}&limit=${limit}`,
    {
      cache: 'no-store',
    }
  )

  if (!response.ok) {
    throw new Error('Failed to fetch recent replies')
  }

  const data = await response.json()
  return data.replies || []
}
