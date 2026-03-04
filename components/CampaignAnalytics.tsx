'use client'

import { useState, useEffect } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'

interface DailyData {
  date: string
  sent: number
  replies: number
  opened: number
  unique_opened: number
  opportunities: number
}

interface Summary {
  total_sent: number
  total_replies: number
  total_positive_replies: number
  reply_rate: number
  positive_reply_rate: number
}

interface StepData {
  step: number
  variant: string | null
  sent: number
  opened: number
  replied: number
  reply_rate: number
  clicked: number
  opportunities: number
}

interface Props {
  campaignId: string
  campaignName: string
  onBack?: () => void
}

export default function CampaignAnalytics({ campaignId, campaignName, onBack }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [daily, setDaily] = useState<DailyData[]>([])
  const [steps, setSteps] = useState<StepData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/analytics?campaign_id=${campaignId}`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch analytics')
        return res.json()
      })
      .then(data => {
        setSummary(data.summary)
        setDaily(data.daily || [])
        setSteps(data.steps || [])
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [campaignId])

  const stats = summary
    ? [
        { label: 'Sent', value: summary.total_sent.toLocaleString() },
        { label: 'Replies', value: summary.total_replies.toLocaleString() },
        { label: 'Reply Rate', value: `${summary.reply_rate.toFixed(1)}%` },
        { label: 'Opportunities', value: summary.total_positive_replies.toLocaleString() },
      ]
    : []

  const chartData = daily
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      ...d,
      date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    }))

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="text-[#6B6B6B] hover:text-white transition-colors text-sm"
          >
            ← Back
          </button>
        )}
        <h2 className="text-base font-medium text-white">{campaignName}</h2>
      </div>

      {loading && (
        <div className="text-[#6B6B6B] text-sm py-12 text-center">Loading analytics…</div>
      )}

      {error && (
        <div className="bg-red-500/5 border border-red-500/20 rounded px-4 py-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {!loading && !error && summary && (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {stats.map(stat => (
              <div key={stat.label} className="bg-[#0F0F0F] border border-[#1E1E1E] rounded px-4 py-3">
                <p className="text-[#6B6B6B] text-[11px] font-medium uppercase tracking-wider">
                  {stat.label}
                </p>
                <p className="text-xl font-semibold text-white mt-0.5">{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Charts */}
          {chartData.length > 0 && (
            <div className="grid grid-cols-1 gap-4">
              {/* Emails Sent Chart */}
              <div className="bg-[#0F0F0F] border border-[#1E1E1E] rounded px-5 pt-5 pb-2">
                <p className="text-[#6B6B6B] text-[11px] font-medium uppercase tracking-wider mb-5">
                  Emails Sent
                </p>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gradSent" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#5E6AD2" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#5E6AD2" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#1A1A1A" strokeDasharray="none" vertical={false} />
                    <XAxis
                      dataKey="date"
                      stroke="#3A3A3A"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      dy={8}
                    />
                    <YAxis
                      stroke="#3A3A3A"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      dx={-4}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1A1A1A',
                        border: '1px solid #2A2A2A',
                        borderRadius: '4px',
                        fontSize: '12px',
                      }}
                      labelStyle={{ color: '#8A8A8A', marginBottom: '4px' }}
                      itemStyle={{ color: '#D0D0D0', padding: '1px 0' }}
                      cursor={{ stroke: '#2A2A2A' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="sent"
                      name="Sent"
                      stroke="#5E6AD2"
                      fill="url(#gradSent)"
                      strokeWidth={1.5}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Replies Chart */}
              <div className="bg-[#0F0F0F] border border-[#1E1E1E] rounded px-5 pt-5 pb-2">
                <p className="text-[#6B6B6B] text-[11px] font-medium uppercase tracking-wider mb-5">
                  Replies
                </p>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gradReplies" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#26B5CE" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#26B5CE" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#1A1A1A" strokeDasharray="none" vertical={false} />
                    <XAxis
                      dataKey="date"
                      stroke="#3A3A3A"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      dy={8}
                    />
                    <YAxis
                      stroke="#3A3A3A"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      dx={-4}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1A1A1A',
                        border: '1px solid #2A2A2A',
                        borderRadius: '4px',
                        fontSize: '12px',
                      }}
                      labelStyle={{ color: '#8A8A8A', marginBottom: '4px' }}
                      itemStyle={{ color: '#D0D0D0', padding: '1px 0' }}
                      cursor={{ stroke: '#2A2A2A' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="replies"
                      name="Replies"
                      stroke="#26B5CE"
                      fill="url(#gradReplies)"
                      strokeWidth={1.5}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {chartData.length === 0 && (
            <div className="text-[#4A4A4A] text-sm py-8 text-center">
              No daily analytics data available yet.
            </div>
          )}

          {/* Step Analytics */}
          {steps.length > 0 && (
            <div className="bg-[#0F0F0F] border border-[#1E1E1E] rounded">
              <div className="px-5 pt-5 pb-3">
                <p className="text-[#6B6B6B] text-[11px] font-medium uppercase tracking-wider">
                  Step Analytics
                </p>
              </div>
              <div className="overflow-x-auto">
                <div className="grid grid-cols-[1fr_80px_80px_100px_80px_80px] gap-0 px-5 pb-2 text-[11px] text-[#4A4A4A] uppercase tracking-wider font-medium">
                  <span>Step</span>
                  <span className="text-right">Sent</span>
                  <span className="text-right">Opened</span>
                  <span className="text-right">Replied</span>
                  <span className="text-right">Clicked</span>
                  <span className="text-right">Opps</span>
                </div>
                {steps.map((s, i) => {
                  const isVariant = s.variant !== null && s.variant !== undefined
                  const replyPct = s.sent > 0 ? ((s.replied / s.sent) * 100).toFixed(1) : '0'
                  return (
                    <div
                      key={i}
                      className={`grid grid-cols-[1fr_80px_80px_100px_80px_80px] gap-0 px-5 py-2.5 border-t border-[#1E1E1E] text-[13px] ${
                        isVariant ? 'text-[#6B6B6B]' : 'text-white'
                      }`}
                    >
                      <span className={isVariant ? 'pl-5' : 'font-medium'}>
                        {isVariant ? s.variant : `Step ${s.step}`}
                      </span>
                      <span className="text-right">{s.sent}</span>
                      <span className="text-right">{s.opened}</span>
                      <span className="text-right">
                        {s.replied}
                        <span className="text-[#4A4A4A] ml-1.5">{replyPct}%</span>
                      </span>
                      <span className="text-right">{s.clicked}</span>
                      <span className="text-right">{s.opportunities}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
