'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

interface Profile {
  id: string
  email: string
  company_name: string
  role: string
}

interface Campaign {
  id: string
  instantly_campaign_id: string
  campaign_name: string
  status: string
}

interface OnboardingStep {
  id: string
  step_title: string
  step_description: string
  completed: boolean
  order: number
}

interface CampaignAnalytics {
  total_sent: number
  total_replies: number
  total_positive_replies: number
  reply_rate: number
  positive_reply_rate: number
}

interface Reply {
  id: string
  sender_name: string
  subject: string
  snippet: string
  timestamp: string
}

export default function ClientDashboard({
  profile,
  campaigns,
  onboardingSteps,
}: {
  profile: Profile
  campaigns: Campaign[]
  onboardingSteps: OnboardingStep[]
}) {
  console.log('ClientDashboard rendering', { profile, campaigns: campaigns.length })
  
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null)
  const [replies, setReplies] = useState<Reply[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    console.log('useEffect running', { campaignsLength: campaigns.length })
    
    if (campaigns.length > 0) {
      // Temporarily disabled API calls until Instantly API is configured
      // loadAnalytics(campaigns[0].instantly_campaign_id)
      // loadReplies(campaigns[0].instantly_campaign_id)
      
      // Set mock data for testing
      console.log('Setting mock analytics data')
      setAnalytics({
        total_sent: 0,
        total_replies: 0,
        total_positive_replies: 0,
        reply_rate: 0,
        positive_reply_rate: 0
      })
      setLoading(false)
    } else {
      console.log('No campaigns, setting loading to false')
      setLoading(false)
    }
  }, [])

  const loadAnalytics = async (campaignId: string) => {
    try {
      const response = await fetch(`/api/analytics?campaign_id=${campaignId}`)
      if (!response.ok) throw new Error('Failed to fetch analytics')
      const data = await response.json()
      setAnalytics(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const loadReplies = async (campaignId: string) => {
    try {
      const response = await fetch(`/api/replies?campaign_id=${campaignId}`)
      if (!response.ok) throw new Error('Failed to fetch replies')
      const data = await response.json()
      setReplies(data)
    } catch (err: any) {
      console.error('Failed to load replies:', err.message)
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <header className="border-b border-[#222222] bg-[#111111]">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-white">{profile.company_name || 'Dashboard'}</h1>
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-8 space-y-8">
        {campaigns.length === 0 ? (
          <div className="bg-[#111111] border border-[#222222] rounded-lg p-8 text-center">
            <p className="text-gray-400">No campaigns assigned yet. Please contact your administrator.</p>
          </div>
        ) : (
          <>
            {/* Analytics Section */}
            <section className="bg-[#111111] border border-[#222222] rounded-lg p-6">
              <h2 className="text-lg font-semibold text-white mb-6">Campaign Analytics</h2>
              
              {loading ? (
                <div className="text-gray-400">Loading analytics...</div>
              ) : error ? (
                <div className="text-red-400">Error: {error}</div>
              ) : analytics ? (
                <div className="space-y-6">
                  {/* Total Emails Sent */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-300">Total Emails Sent</span>
                      <span className="text-2xl font-bold text-white">{analytics.total_sent.toLocaleString()}</span>
                    </div>
                    <div className="h-2 bg-[#222222] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500"
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>

                  {/* Reply Rate */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-300">Reply Rate</span>
                      <span className="text-2xl font-bold text-white">{analytics.reply_rate.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-[#222222] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500"
                        style={{ width: `${Math.min(analytics.reply_rate, 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {analytics.total_replies} replies out of {analytics.total_sent} sent
                    </p>
                  </div>

                  {/* Positive Reply Rate */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-300">Positive Reply Rate</span>
                      <span className="text-2xl font-bold text-white">{analytics.positive_reply_rate.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-[#222222] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500"
                        style={{ width: `${Math.min(analytics.positive_reply_rate, 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {analytics.total_positive_replies} positive replies out of {analytics.total_replies} total replies
                    </p>
                  </div>
                </div>
              ) : null}
            </section>

            {/* Recent Replies Section */}
            <section className="bg-[#111111] border border-[#222222] rounded-lg p-6">
              <h2 className="text-lg font-semibold text-white mb-6">Recent Replies</h2>
              <p className="text-gray-400">No replies yet.</p>
            </section>
          </>
        )}

        {/* Onboarding Checklist */}
        {onboardingSteps.length > 0 && (
          <section className="bg-[#111111] border border-[#222222] rounded-lg p-6">
            <h2 className="text-lg font-semibold text-white mb-6">Onboarding Checklist</h2>
            
            <div className="space-y-3">
              {onboardingSteps.map(step => (
                <div key={step.id} className="p-4 bg-[#0a0a0a] border border-[#222222] rounded-md">
                  <div className="flex items-start gap-4">
                    <div
                      className={`mt-1 w-5 h-5 rounded border-2 flex items-center justify-center ${
                        step.completed
                          ? 'bg-blue-600 border-blue-600'
                          : 'border-[#444444]'
                      }`}
                    >
                      {step.completed && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1">
                      <p className={`font-medium ${step.completed ? 'text-gray-400 line-through' : 'text-white'}`}>
                        {step.step_title}
                      </p>
                      {step.step_description && (
                        <p className="text-sm text-gray-400 mt-1">{step.step_description}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
