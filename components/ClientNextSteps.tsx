'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface ChecklistItem {
  key: string
  label: string
  autoCheckField?: string // 'docusign' | 'onboarding_stage_2' | 'onboarding_stage_3' | 'campaign'
}

interface ChecklistSection {
  id: string
  label: string
  items: ChecklistItem[]
}

const SECTIONS: ChecklistSection[] = [
  {
    id: 'client_side',
    label: 'Client Side',
    items: [
      { key: 'welcome_message', label: 'Welcome Message Post Payment' },
      { key: 'docusign', label: 'DocuSign Agreement', autoCheckField: 'docusign' },
      { key: 'comm_channel', label: 'Comm Channel Setup' },
      { key: 'calcom_link', label: 'Cal.com Link Created' },
      { key: 'onboarding_form', label: 'Onboarding Form', autoCheckField: 'onboarding_stage_2' },
      { key: 'buy_mailboxes', label: 'Buy Mailboxes (Zapmail → Instantly Warmup)' },
      { key: 'domain_generation', label: 'Domain Generation' },
      { key: 'icp_targeting', label: 'ICP & Targeting Data', autoCheckField: 'onboarding_stage_3' },
      { key: 'apollo_url_structure', label: 'Apollo URL Structure Creation' },
      { key: 'extraction_questions', label: 'Extraction Questions + Call' },
      { key: 'voice_note', label: 'Voice Note Confirmation Sent' },
    ],
  },
  {
    id: 'admin_side',
    label: 'Admin Side',
    items: [
      { key: 'lead_list', label: 'Lead List: LeadsFriday / Apollo Scraper' },
      { key: 'validator', label: 'Validator: Northstar Dash' },
      { key: 'market_research_agent', label: 'Market Research Agent' },
      { key: 'onboarding_agent', label: 'Onboarding Agent' },
      { key: 'ops_layer', label: 'Ops Layer' },
      { key: 'copywriter', label: 'Copywriter: Northstar Dash' },
      { key: 'clay_prompt_generator', label: 'Clay Prompt Generator' },
      { key: 'sequence_creator', label: 'Sequence Creator: Northstar Dash' },
      { key: 'sequencer_instantly', label: 'Sequencer: Instantly' },
      { key: 'instantly_settings', label: 'Instantly Settings Configured' },
      { key: 'report_generation', label: 'Report Generation' },
    ],
  },
  {
    id: 'campaign',
    label: 'Campaign',
    items: [
      { key: 'campaign_created', label: 'Campaign Created', autoCheckField: 'campaign' },
      { key: 'campaign_launch_notification', label: 'Campaign Launch Notification Sent' },
      { key: 'outbound_connector', label: 'Outbound Campaign: Connector' },
      { key: 'outbound_non_connector', label: 'Outbound Campaign: Non-Connector' },
    ],
  },
  {
    id: 'positive_reply',
    label: 'Positive Reply Handling',
    items: [
      { key: 'blueprint_pdf_cta', label: 'Blueprint PDF CTA Reply Configured' },
      { key: 'automated_agent', label: 'Automated Agent Setup (<5 min response)' },
      { key: 'send_testimonials', label: 'Send Testimonials Flow' },
      { key: 'personal_reply', label: 'Personal Reply Flow' },
      { key: 'new_domain_reply', label: 'New Domain Configured' },
    ],
  },
  {
    id: 'reporting',
    label: 'Reporting Layer',
    items: [
      { key: 'daily_notif_channel', label: 'Daily Notification Channel' },
      { key: 'weekly_report', label: 'Weekly Report' },
      { key: 'calcom_webhook', label: 'Cal.com Webhook' },
      { key: 'booking_confirmation', label: 'Booking Confirmation & Notification' },
      { key: 'pre_sales_analysis', label: 'Pre-Sales Report Analysis' },
      { key: 'meeting_outcome_form', label: 'Meeting Outcome Input Form' },
    ],
  },
]

interface Props {
  clientId: string
  docusignUrl: string | null
  onboardingStage: number
  hasCampaign: boolean
}

export default function ClientNextSteps({ clientId, docusignUrl, onboardingStage, hasCampaign }: Props) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const isAutoChecked = useCallback((item: ChecklistItem): boolean => {
    if (!item.autoCheckField) return false
    if (item.autoCheckField === 'docusign') return !!docusignUrl
    if (item.autoCheckField === 'onboarding_stage_2') return onboardingStage >= 2
    if (item.autoCheckField === 'onboarding_stage_3') return onboardingStage >= 3
    if (item.autoCheckField === 'campaign') return hasCampaign
    return false
  }, [docusignUrl, onboardingStage, hasCampaign])

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const { data } = await supabase
        .from('client_onboarding_checklist')
        .select('section, item_key, completed')
        .eq('client_id', clientId)

      const map: Record<string, boolean> = {}
      if (data) {
        for (const row of data) {
          map[`${row.section}::${row.item_key}`] = row.completed
        }
      }

      // Apply auto-checks on top
      for (const section of SECTIONS) {
        for (const item of section.items) {
          const dbKey = `${section.id}::${item.key}`
          if (!(dbKey in map)) {
            map[dbKey] = isAutoChecked(item)
          }
        }
      }

      setChecked(map)
      setLoading(false)
    }
    load()
  }, [clientId, isAutoChecked])

  const toggle = async (sectionId: string, item: ChecklistItem) => {
    const dbKey = `${sectionId}::${item.key}`
    const newVal = !checked[dbKey]
    setChecked(prev => ({ ...prev, [dbKey]: newVal }))

    await supabase.from('client_onboarding_checklist').upsert({
      client_id: clientId,
      section: sectionId,
      item_key: item.key,
      completed: newVal,
      completed_at: newVal ? new Date().toISOString() : null,
    }, { onConflict: 'client_id,section,item_key' })
  }

  const toggleSection = (sectionId: string) => {
    setCollapsed(prev => ({ ...prev, [sectionId]: !prev[sectionId] }))
  }

  if (loading) {
    return <p className="text-[13px] text-[#4A4A4A]">Loading checklist...</p>
  }

  return (
    <div className="space-y-2">
      {SECTIONS.map(section => {
        const sectionItems = section.items
        const completedCount = sectionItems.filter(item => checked[`${section.id}::${item.key}`]).length
        const isCollapsed = collapsed[section.id]
        const allDone = completedCount === sectionItems.length

        return (
          <div key={section.id} className="border border-[#1E1E1E] rounded-xl overflow-hidden">
            <button
              onClick={() => toggleSection(section.id)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-[#111111] transition-colors"
            >
              <div className="flex items-center gap-2.5">
                {isCollapsed
                  ? <ChevronRight size={14} className="text-[#4A4A4A]" />
                  : <ChevronDown size={14} className="text-[#4A4A4A]" />
                }
                <span className="text-[13px] font-medium text-white">{section.label}</span>
              </div>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
                allDone
                  ? 'border-[#2ECC71]/30 text-[#2ECC71] bg-[#2ECC71]/5'
                  : completedCount > 0
                  ? 'border-[#5E6AD2]/30 text-[#5E6AD2] bg-[#5E6AD2]/5'
                  : 'border-[#2A2A2A] text-[#4A4A4A]'
              }`}>
                {completedCount}/{sectionItems.length}
              </span>
            </button>

            {!isCollapsed && (
              <div className="px-4 pb-3 space-y-0.5">
                {sectionItems.map(item => {
                  const dbKey = `${section.id}::${item.key}`
                  const isChecked = !!checked[dbKey]
                  const isAuto = isAutoChecked(item)

                  return (
                    <button
                      key={item.key}
                      onClick={() => toggle(section.id, item)}
                      className="w-full flex items-center gap-3 py-1.5 text-left hover:opacity-80 transition-opacity group"
                    >
                      <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                        isChecked
                          ? 'bg-[#5E6AD2] border-[#5E6AD2]'
                          : 'border-[#3A3A3A] group-hover:border-[#5E6AD2]'
                      }`}>
                        {isChecked && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <span className={`text-[13px] flex-1 ${isChecked ? 'text-[#4A4A4A] line-through' : 'text-[#C0C0C0]'}`}>
                        {item.label}
                      </span>
                      {isAuto && isChecked && (
                        <span className="text-[10px] text-[#5E6AD2] shrink-0">auto</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
