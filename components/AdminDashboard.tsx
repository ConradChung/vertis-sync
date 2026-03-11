'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import Image from 'next/image'
import {
  Users,
  Megaphone,
  ClipboardList,
  Database,
  Mail,
  LogOut,
  Wand2,
  Layers,
  Search,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Sidebar, SidebarBody, useSidebar } from '@/components/ui/sidebar'
import CampaignAnalytics from '@/components/CampaignAnalytics'
import EmailValidator from '@/components/EmailValidator'
import ClientNextSteps from '@/components/ClientNextSteps'
import CopywriterAgent from '@/components/CopywriterAgent'
import ClayPromptGenerator from '@/components/ClayPromptGenerator'
import MarketResearchAgent from '@/components/MarketResearchAgent'
import AccountSettings from '@/components/AccountSettings'

interface Client {
  id: string
  email: string
  company_name: string
  created_at: string
  docusign_url: string | null
  onboarding_stage: number
  company_logo_url: string | null
}

interface Campaign {
  id: string
  client_id: string
  instantly_campaign_id: string
  campaign_name: string
  status: string
}

type Section = 'clients' | 'campaigns' | 'onboarding' | 'onboarding-data' | 'email-validator' | 'copywriter' | 'clay-prompts' | 'market-research' | 'settings'

// ── Sidebar sub-components ──

function SidebarLogo() {
  const { open, animate } = useSidebar()
  return (
    <div className="flex items-center gap-3 px-3 py-2 mb-2">
      <Image
        src="/northstar-logo-white.png"
        alt="NorthStar"
        width={28}
        height={28}
        className="shrink-0 rounded-lg"
      />
      <motion.span
        animate={{
          display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
          opacity: animate ? (open ? 1 : 0) : 1,
        }}
        className="text-[13px] font-semibold whitespace-nowrap"
        style={{ color: 'var(--text-primary)' }}
      >
        NorthStar
      </motion.span>
    </div>
  )
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  const { open, animate } = useSidebar()
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-left transition-colors'
      )}
      style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
    >
      {active && (
        <motion.div
          layoutId="admin-sidebar-active"
          className="absolute inset-0 rounded-lg"
          style={{ background: 'var(--accent)15', border: '1px solid var(--accent)25' }}
          transition={{ type: 'spring', stiffness: 400, damping: 35 }}
        />
      )}
      <span className="relative shrink-0">{icon}</span>
      <motion.span
        animate={{
          display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
          opacity: animate ? (open ? 1 : 0) : 1,
        }}
        className="relative text-[13px] font-medium whitespace-nowrap"
      >
        {label}
      </motion.span>
    </button>
  )
}

function SidebarAdminFooter({ onLogout, onSettings, settingsActive }: { onLogout: () => void; onSettings: () => void; settingsActive: boolean }) {
  const { open, animate } = useSidebar()
  return (
    <div className="space-y-0.5" style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
      <button
        onClick={onSettings}
        className="relative flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-left transition-colors"
        style={{ color: settingsActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
      >
        {settingsActive && (
          <motion.div
            layoutId="admin-sidebar-active"
            className="absolute inset-0 rounded-lg"
            style={{ background: 'var(--accent)15', border: '1px solid var(--accent)25' }}
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
          />
        )}
        <Settings size={18} className="relative shrink-0" />
        <motion.span
          animate={{
            display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
            opacity: animate ? (open ? 1 : 0) : 1,
          }}
          className="relative text-[13px] font-medium whitespace-nowrap"
        >
          Settings
        </motion.span>
      </button>
      <button
        onClick={onLogout}
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-left transition-colors"
        style={{ color: 'var(--text-secondary)' }}
      >
        <LogOut size={18} className="shrink-0" />
        <motion.span
          animate={{
            display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
            opacity: animate ? (open ? 1 : 0) : 1,
          }}
          className="text-[13px] font-medium whitespace-nowrap"
        >
          Log out
        </motion.span>
      </button>
    </div>
  )
}

// ── Shared input / button styles ──
const inputCls = 'w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none'
const inputStyle = {
  background: 'var(--surface-raised)',
  border: '1px solid var(--border)',
  color: 'var(--text-primary)',
}

const STAGE_LABELS: Record<number, string> = {
  0: 'Pre-start', 1: 'Inbox Setup', 2: 'Questionnaire', 3: 'ICP Form', 4: 'Complete',
}
const STAGE_STEPS: string[] = ['Inbox Setup', 'Questionnaire', 'ICP Form']


export default function AdminDashboard() {
  const [clients, setClients] = useState<Client[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [selectedClient, setSelectedClient] = useState<string | null>(null)
  const [showCreateClient, setShowCreateClient] = useState(false)
  const [showAddCampaign, setShowAddCampaign] = useState(false)
  const [activeSection, setActiveSection] = useState<Section>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('ns_active_section') as Section | null
      if (saved) return saved
    }
    return 'clients'
  })
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null)
  const [docuSignInputs, setDocuSignInputs] = useState<Record<string, string>>({})
  const [onboardingDataClientId, setOnboardingDataClientId] = useState<string>('')
  const [checklistClientId, setChecklistClientId] = useState<string>('')
  const [stageData, setStageData] = useState<{ stage1: Record<string, unknown> | null; stage2: Record<string, unknown> | null; stage3: Record<string, unknown> | null }>({ stage1: null, stage2: null, stage3: null })
  const [validatorStatus, setValidatorStatus] = useState<{ step: string; processed: number; total: number } | null>(null)
  const [logoUploading, setLogoUploading] = useState<string | null>(null) // client id currently uploading

  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    loadClients()
    loadCampaigns()
  }, [])

  const loadClients = async () => {
    const { data } = await supabase.from('profiles').select('*').eq('role', 'client').order('created_at', { ascending: false })
    if (data) setClients(data)
  }

  const loadCampaigns = async () => {
    const { data } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false })
    if (data) setCampaigns(data)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleCreateClient = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const email = fd.get('email') as string
    const password = fd.get('password') as string
    const companyName = fd.get('company_name') as string

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email, password, options: { data: { company_name: companyName } },
    })
    if (authError) { alert(`Error: ${authError.message}`); return }
    if (authData.user) {
      const { error } = await supabase.from('profiles').insert({ id: authData.user.id, email, role: 'client', company_name: companyName })
      if (error) { alert(`Error: ${error.message}`); return }
      setShowCreateClient(false)
      loadClients()
      ;(e.target as HTMLFormElement).reset()
    }
  }

  const handleAddCampaign = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const { error } = await supabase.from('campaigns').insert({
      client_id: fd.get('client_id'),
      instantly_campaign_id: fd.get('instantly_campaign_id'),
      campaign_name: fd.get('campaign_name'),
      status: 'active',
    })
    if (error) { alert(`Error: ${error.message}`); return }
    setShowAddCampaign(false)
    loadCampaigns()
    ;(e.target as HTMLFormElement).reset()
  }

  const saveDocuSignUrl = async (clientId: string, url: string) => {
    await supabase.from('profiles').update({ docusign_url: url || null }).eq('id', clientId)
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, docusign_url: url || null } : c))
  }

  const uploadLogo = async (clientId: string, file: File) => {
    if (file.size > 512 * 1024) {
      alert('Logo must be under 512 KB')
      return
    }
    setLogoUploading(clientId)
    const ext = file.name.split('.').pop()
    const path = `${clientId}/logo.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('logos')
      .upload(path, file, { upsert: true })
    if (uploadError) {
      alert(`Upload failed: ${uploadError.message}`)
      setLogoUploading(null)
      return
    }
    const { data } = supabase.storage.from('logos').getPublicUrl(path)
    const url = data.publicUrl
    await supabase.from('profiles').update({ company_logo_url: url }).eq('id', clientId)
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, company_logo_url: url } : c))
    setLogoUploading(null)
  }

  const loadStageData = async (clientId: string) => {
    const [s1, s2, s3] = await Promise.all([
      supabase.from('stage1_onboarding').select('*').eq('client_id', clientId).maybeSingle(),
      supabase.from('stage2_onboarding').select('*').eq('client_id', clientId).maybeSingle(),
      supabase.from('onboarding_forms').select('*').eq('client_id', clientId).maybeSingle(),
    ])
    setStageData({ stage1: s1.data, stage2: s2.data, stage3: s3.data })
  }

  const filteredCampaigns = selectedClient ? campaigns.filter(c => c.client_id === selectedClient) : campaigns

  const navigate = (section: Section) => {
    setActiveSection(section)
    setSelectedCampaign(null)
    localStorage.setItem('ns_active_section', section)
  }

  const isCanvasSection = activeSection === 'onboarding'

  return (
    <div className="flex h-screen overflow-hidden p-3 gap-3" style={{ background: 'var(--bg)' }}>
      <Sidebar animate={false}>
        <SidebarBody
          className="!w-[220px] !rounded-2xl !h-full justify-between gap-8"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
          } as React.CSSProperties}
        >
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden gap-0.5">
            <SidebarLogo />
            <div className="mt-3 flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Management</p>
              {([
                { id: 'clients', label: 'Clients', icon: <Users size={18} /> },
                { id: 'campaigns', label: 'Campaigns', icon: <Megaphone size={18} /> },
                { id: 'onboarding', label: 'Client Next Steps', icon: <ClipboardList size={18} /> },
                { id: 'onboarding-data', label: 'Onboarding Data', icon: <Database size={18} /> },
                { id: 'email-validator', label: 'Email Validator', icon: <Mail size={18} /> },
              ] as { id: Section; label: string; icon: React.ReactNode }[]).map(item => (
                <NavItem key={item.id} icon={item.icon} label={item.label}
                  active={activeSection === item.id} onClick={() => navigate(item.id)} />
              ))}
              <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>AI Tools</p>
              {([
                { id: 'copywriter', label: 'Copywriter', icon: <Wand2 size={18} /> },
                { id: 'clay-prompts', label: 'Clay Prompts', icon: <Layers size={18} /> },
                { id: 'market-research', label: 'Market Research', icon: <Search size={18} /> },
              ] as { id: Section; label: string; icon: React.ReactNode }[]).map(item => (
                <NavItem key={item.id} icon={item.icon} label={item.label}
                  active={activeSection === item.id} onClick={() => navigate(item.id)} />
              ))}
            </div>
          </div>
          <SidebarAdminFooter
            onLogout={handleLogout}
            onSettings={() => navigate('settings')}
            settingsActive={activeSection === 'settings'}
          />
        </SidebarBody>
      </Sidebar>

      {/* Main content */}
      <main
        className={`flex-1 rounded-2xl ${isCanvasSection ? 'overflow-hidden' : 'overflow-y-auto'}`}
        style={{ background: 'var(--bg)' }}
      >
        <AnimatePresence mode="wait">

          {/* ── Clients ── */}
          {activeSection === 'clients' && (
            <motion.div key="clients" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-base font-medium" style={{ color: 'var(--text-primary)' }}>Clients</h2>
                <button
                  onClick={() => setShowCreateClient(v => !v)}
                  className="px-4 py-2 text-[13px] font-medium rounded-lg transition-colors"
                  style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                >
                  Create Client
                </button>
              </div>

              {showCreateClient && (
                <form onSubmit={handleCreateClient} className="mb-5 p-5 rounded-xl space-y-3" style={{ border: '1px solid var(--border)' }}>
                  <input name="email" type="email" placeholder="Email" required className={inputCls} style={inputStyle} />
                  <input name="password" type="password" placeholder="Password" required className={inputCls} style={inputStyle} />
                  <input name="company_name" type="text" placeholder="Company Name" required className={inputCls} style={inputStyle} />
                  <button type="submit" className="w-full px-4 py-2 text-[13px] font-medium rounded-lg transition-colors"
                    style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}>Create</button>
                </form>
              )}

              <div className="space-y-2">
                {clients.map(client => (
                  <div key={client.id} className="rounded-xl p-4" style={{ border: '1px solid var(--border)' }}>
                    <div className="flex items-center justify-between cursor-pointer"
                      onClick={() => setSelectedClient(client.id === selectedClient ? null : client.id)}>
                      <div>
                        <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{client.company_name || 'Unnamed'}</p>
                        <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{client.email}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
                          client.onboarding_stage >= 4
                            ? 'border-[#2ECC71]/30 text-[#2ECC71] bg-[#2ECC71]/5'
                            : client.onboarding_stage > 0
                            ? 'border-[#5E6AD2]/30 text-[#5E6AD2] bg-[#5E6AD2]/5'
                            : ''
                        }`}
                          style={client.onboarding_stage === 0 ? { border: '1px solid var(--border)', color: 'var(--text-placeholder)' } : {}}
                        >
                          {STAGE_LABELS[client.onboarding_stage] || 'Pre-start'}
                        </span>
                        <span className="text-[11px]" style={{ color: 'var(--text-placeholder)' }}>
                          {new Date(client.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 space-y-3" onClick={e => e.stopPropagation()}>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={docuSignInputs[client.id] ?? client.docusign_url ?? ''}
                          onChange={e => setDocuSignInputs(prev => ({ ...prev, [client.id]: e.target.value }))}
                          onBlur={e => saveDocuSignUrl(client.id, e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && saveDocuSignUrl(client.id, docuSignInputs[client.id] ?? '')}
                          placeholder="DocuSign URL (paste link to save)"
                          className="flex-1 px-2.5 py-1.5 rounded-lg text-[12px] focus:outline-none"
                          style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                        />
                        {(docuSignInputs[client.id] ?? client.docusign_url) && (
                          <span className="text-[11px] text-[#2ECC71] flex items-center">✓</span>
                        )}
                      </div>
                      {/* Logo upload */}
                      <div className="flex items-center gap-3">
                        {client.company_logo_url ? (
                          <img
                            src={client.company_logo_url}
                            alt="Logo"
                            className="w-8 h-8 rounded-full object-cover border"
                            style={{ borderColor: 'var(--border)' }}
                          />
                        ) : (
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium shrink-0"
                            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                          >
                            {(client.company_name?.[0] || '?').toUpperCase()}
                          </div>
                        )}
                        <label
                          className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] cursor-pointer transition-colors"
                          style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                        >
                          {logoUploading === client.id ? (
                            <span className="flex items-center gap-2">
                              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                              Uploading...
                            </span>
                          ) : (
                            client.company_logo_url ? 'Replace logo' : 'Upload logo'
                          )}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={e => {
                              const file = e.target.files?.[0]
                              if (file) uploadLogo(client.id, file)
                              e.target.value = ''
                            }}
                          />
                        </label>
                      </div>
                      {/* Stage progress bar */}
                      <div className="flex gap-1">
                        {STAGE_STEPS.map((label, i) => {
                          const stageNum = i + 1
                          const done = client.onboarding_stage > stageNum
                          const active = client.onboarding_stage === stageNum
                          return (
                            <div key={label} className="flex-1 space-y-1">
                              <div className="h-1 rounded-full" style={{
                                background: done || client.onboarding_stage >= 4
                                  ? '#2ECC71'
                                  : active
                                  ? '#5E6AD2'
                                  : 'var(--border)',
                              }} />
                              <p className="text-[10px] truncate" style={{ color: 'var(--text-tertiary)' }}>{label}</p>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Campaigns ── */}
          {activeSection === 'campaigns' && !selectedCampaign && (
            <motion.div key="campaigns" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-base font-medium" style={{ color: 'var(--text-primary)' }}>Campaigns</h2>
                <button onClick={() => setShowAddCampaign(v => !v)}
                  className="px-4 py-2 text-[13px] font-medium rounded-lg transition-colors"
                  style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}>
                  Add Campaign
                </button>
              </div>

              {showAddCampaign && (
                <form onSubmit={handleAddCampaign} className="mb-5 p-5 rounded-xl space-y-3" style={{ border: '1px solid var(--border)' }}>
                  <select name="client_id" required className={inputCls} style={inputStyle}>
                    <option value="">Select Client</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.company_name || c.email}</option>)}
                  </select>
                  <input name="campaign_name" type="text" placeholder="Campaign Name" required className={inputCls} style={inputStyle} />
                  <input name="instantly_campaign_id" type="text" placeholder="Instantly Campaign ID" required className={inputCls} style={inputStyle} />
                  <button type="submit" className="w-full px-4 py-2 text-[13px] font-medium rounded-lg transition-colors"
                    style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}>Add Campaign</button>
                </form>
              )}

              <div className="space-y-1">
                {filteredCampaigns.map(campaign => {
                  const client = clients.find(c => c.id === campaign.client_id)
                  return (
                    <div key={campaign.id} onClick={() => setSelectedCampaign(campaign)}
                      className="px-4 py-3 rounded-lg cursor-pointer transition-colors group"
                      style={{ ['--hover-bg' as string]: 'var(--surface)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{campaign.campaign_name}</p>
                          <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                            {client?.company_name || 'Unknown'} · {campaign.instantly_campaign_id}
                          </p>
                        </div>
                        <span className="text-[11px]" style={{ color: 'var(--text-placeholder)' }}>{campaign.status}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}

          {activeSection === 'campaigns' && selectedCampaign && (
            <motion.div key="campaign-detail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <CampaignAnalytics
                campaignId={selectedCampaign.instantly_campaign_id}
                campaignName={selectedCampaign.campaign_name}
                onBack={() => setSelectedCampaign(null)}
              />
            </motion.div>
          )}

          {/* ── Client Next Steps ── */}
          {activeSection === 'onboarding' && (
            <motion.div key="onboarding" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="w-full h-full flex flex-col">
              <div className="px-6 py-4 flex items-center gap-4 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <h2 className="text-base font-medium" style={{ color: 'var(--text-primary)' }}>Client Next Steps</h2>
                <select
                  value={checklistClientId}
                  onChange={e => setChecklistClientId(e.target.value)}
                  className={inputCls}
                  style={{ ...inputStyle, maxWidth: 280 }}
                >
                  <option value="">Select a client</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name || c.email}</option>)}
                </select>
              </div>
              <div className="flex-1 overflow-hidden">
                {checklistClientId && (() => {
                  const client = clients.find(c => c.id === checklistClientId)
                  const hasCampaign = campaigns.some(c => c.client_id === checklistClientId)
                  return (
                    <ClientNextSteps
                      clientId={checklistClientId}
                      docusignUrl={client?.docusign_url ?? null}
                      onboardingStage={client?.onboarding_stage ?? 0}
                      hasCampaign={hasCampaign}
                    />
                  )
                })()}
                {!checklistClientId && (
                  <div className="flex items-center justify-center h-full text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                    Select a client to view their canvas
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* ── Onboarding Data ── */}
          {activeSection === 'onboarding-data' && (
            <motion.div key="onboarding-data" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="max-w-3xl mx-auto px-6 py-8">
              <div className="mb-6">
                <h2 className="text-base font-medium mb-4" style={{ color: 'var(--text-primary)' }}>Onboarding Data</h2>
                <select
                  value={onboardingDataClientId}
                  onChange={e => { setOnboardingDataClientId(e.target.value); if (e.target.value) loadStageData(e.target.value) }}
                  className={inputCls}
                  style={{ ...inputStyle, maxWidth: 280 }}
                >
                  <option value="">Select a client</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name || c.email}</option>)}
                </select>
              </div>

              {onboardingDataClientId && (
                <div className="space-y-4">
                  {[
                    { label: 'Stage 1 — Inbox Setup', data: stageData.stage1, fields: null as null },
                    { label: 'Stage 2 — Dream Client Questionnaire', data: stageData.stage2, fields: null },
                    { label: 'Stage 3 — ICP & Targeting', data: stageData.stage3, fields: null },
                  ].map(({ label, data }, idx) => (
                    <div key={idx} className="rounded-xl p-5" style={{ border: '1px solid var(--border)' }}>
                      <p className="text-[11px] font-semibold uppercase tracking-wider mb-4" style={{ color: 'var(--text-secondary)' }}>{label}</p>
                      {data ? (
                        <div className="space-y-3">
                          {idx === 0 && (
                            <>
                              {!!stageData.stage1?.profile_picture_url && (
                                <div className="flex items-center gap-3">
                                  <img src={String(stageData.stage1.profile_picture_url)} alt="Profile" className="w-10 h-10 rounded-full object-cover" />
                                  <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Profile photo</p>
                                </div>
                              )}
                              {!!stageData.stage1?.selected_domain && (
                                <div>
                                  <p className="text-[11px] mb-0.5" style={{ color: 'var(--text-placeholder)' }}>Selected domain</p>
                                  <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{String(stageData.stage1.selected_domain)}</p>
                                </div>
                              )}
                            </>
                          )}
                          {idx === 1 && (
                            <>
                              {(['best_client_description','biggest_problem','why_said_yes','result_delivered','red_flags','clone_client'] as const).map(key => {
                                const labels: Record<string, string> = { best_client_description: 'Best client', biggest_problem: 'Biggest problem', why_said_yes: 'Why said yes', result_delivered: 'Result delivered', red_flags: 'Red flags', clone_client: 'Clone client' }
                                return !!stageData.stage2?.[key] && (
                                  <div key={key}>
                                    <p className="text-[11px] mb-0.5" style={{ color: 'var(--text-placeholder)' }}>{labels[key]}</p>
                                    <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{String(stageData.stage2[key])}</p>
                                  </div>
                                )
                              })}
                            </>
                          )}
                          {idx === 2 && (
                            <>
                              {(['industries','company_size','revenue_ranges','locations','job_titles_include','job_titles_exclude','keywords_include','keywords_exclude'] as const).map(key => {
                                const labels: Record<string, string> = { industries: 'Industries', company_size: 'Company size', revenue_ranges: 'Revenue ranges', locations: 'Locations', job_titles_include: 'Job titles (include)', job_titles_exclude: 'Job titles (exclude)', keywords_include: 'Keywords (include)', keywords_exclude: 'Keywords (exclude)' }
                                const val = stageData.stage3?.[key]
                                if (!val || (Array.isArray(val) && val.length === 0)) return null
                                return (
                                  <div key={key}>
                                    <p className="text-[11px] mb-1" style={{ color: 'var(--text-placeholder)' }}>{labels[key]}</p>
                                    <div className="flex flex-wrap gap-1">
                                      {(Array.isArray(val) ? val as string[] : [String(val)]).map(v => (
                                        <span key={v} className="px-2 py-0.5 text-[11px] rounded-full"
                                          style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>{v}</span>
                                      ))}
                                    </div>
                                  </div>
                                )
                              })}
                              {(['cta_type','deal_size_range','offer_description','best_customer_description','calendly_link'] as const).map(key => {
                                const labels: Record<string, string> = { cta_type: 'CTA type', deal_size_range: 'Deal size', offer_description: 'Offer description', best_customer_description: 'Best customer', calendly_link: 'Calendly link' }
                                return !!stageData.stage3?.[key] && (
                                  <div key={key}>
                                    <p className="text-[11px] mb-0.5" style={{ color: 'var(--text-placeholder)' }}>{labels[key]}</p>
                                    <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{String(stageData.stage3[key])}</p>
                                  </div>
                                )
                              })}
                            </>
                          )}
                        </div>
                      ) : <p className="text-[13px]" style={{ color: 'var(--text-placeholder)' }}>Not completed yet</p>}
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {/* ── Copywriter ── */}
          {activeSection === 'copywriter' && (
            <motion.div key="copywriter" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="px-6 py-8">
              <CopywriterAgent clients={clients} />
            </motion.div>
          )}

          {/* ── Clay Prompts ── */}
          {activeSection === 'clay-prompts' && (
            <motion.div key="clay-prompts" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="px-6 py-8">
              <ClayPromptGenerator clients={clients} />
            </motion.div>
          )}

          {/* ── Market Research ── */}
          {activeSection === 'market-research' && (
            <motion.div key="market-research" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="px-6 py-8">
              <MarketResearchAgent clients={clients} />
            </motion.div>
          )}

          {/* ── Settings ── */}
          {activeSection === 'settings' && (
            <motion.div key="settings" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              <AccountSettings />
            </motion.div>
          )}

        </AnimatePresence>

        {/* ── Email Validator (always mounted so validation never drops) ── */}
        <div className={activeSection !== 'email-validator' ? 'invisible h-0 overflow-hidden' : ''}>
          <motion.div
            animate={{ opacity: activeSection === 'email-validator' ? 1 : 0 }}
            transition={{ duration: 0.15 }}
            className="max-w-3xl mx-auto px-6 py-8"
          >
            <EmailValidator onStatusChange={setValidatorStatus} />
          </motion.div>
        </div>

      </main>

      {/* ── Floating validator mini-bar ── */}
      {validatorStatus && activeSection !== 'email-validator' && (
        <button
          onClick={() => setActiveSection('email-validator')}
          className="fixed bottom-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl transition-colors"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: 260 }}
        >
          <span className="w-2 h-2 rounded-full bg-[#5E6AD2] animate-pulse shrink-0" />
          <div className="flex-1 min-w-0 text-left">
            <p className="text-[12px] font-medium leading-none mb-1.5" style={{ color: 'var(--text-primary)' }}>
              Email Validator running
            </p>
            <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
              <div
                className="h-full bg-[#5E6AD2] rounded-full transition-all duration-300"
                style={{
                  width: validatorStatus.total > 0
                    ? `${Math.round((validatorStatus.processed / validatorStatus.total) * 100)}%`
                    : '5%'
                }}
              />
            </div>
            {validatorStatus.total > 0 && (
              <p className="text-[11px] mt-1 leading-none tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                {validatorStatus.processed} / {validatorStatus.total}
              </p>
            )}
          </div>
        </button>
      )}
    </div>
  )
}
