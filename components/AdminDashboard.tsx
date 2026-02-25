'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

interface Client {
  id: string
  email: string
  company_name: string
  created_at: string
}

interface Campaign {
  id: string
  client_id: string
  instantly_campaign_id: string
  campaign_name: string
  status: string
}

interface OnboardingStep {
  id: string
  client_id: string
  step_title: string
  step_description: string
  completed: boolean
  order: number
}

export default function AdminDashboard() {
  const [clients, setClients] = useState<Client[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [onboardingSteps, setOnboardingSteps] = useState<OnboardingStep[]>([])
  const [selectedClient, setSelectedClient] = useState<string | null>(null)
  const [showCreateClient, setShowCreateClient] = useState(false)
  const [showAddCampaign, setShowAddCampaign] = useState(false)
  const [showAddStep, setShowAddStep] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    loadClients()
    loadCampaigns()
    loadOnboardingSteps()
  }, [])

  const loadClients = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'client')
      .order('created_at', { ascending: false })
    if (data) setClients(data)
  }

  const loadCampaigns = async () => {
    const { data } = await supabase
      .from('campaigns')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setCampaigns(data)
  }

  const loadOnboardingSteps = async () => {
    const { data } = await supabase
      .from('onboarding_steps')
      .select('*')
      .order('client_id', { ascending: true })
      .order('order', { ascending: true })
    if (data) setOnboardingSteps(data)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const handleCreateClient = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const email = formData.get('email') as string
    const password = formData.get('password') as string
    const companyName = formData.get('company_name') as string

    // Create user
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          company_name: companyName,
        },
      },
    })

    if (authError) {
      alert(`Error creating client: ${authError.message}`)
      return
    }

    if (authData.user) {
      // Create profile
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: authData.user.id,
          email,
          role: 'client',
          company_name: companyName,
        })

      if (profileError) {
        alert(`Error creating profile: ${profileError.message}`)
        return
      }

      setShowCreateClient(false)
      loadClients()
      ;(e.target as HTMLFormElement).reset()
    }
  }

  const handleAddCampaign = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    
    const { error } = await supabase.from('campaigns').insert({
      client_id: formData.get('client_id') as string,
      instantly_campaign_id: formData.get('instantly_campaign_id') as string,
      campaign_name: formData.get('campaign_name') as string,
      status: 'active',
    })

    if (error) {
      alert(`Error adding campaign: ${error.message}`)
      return
    }

    setShowAddCampaign(false)
    loadCampaigns()
    ;(e.target as HTMLFormElement).reset()
  }

  const handleAddStep = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    
    const { error } = await supabase.from('onboarding_steps').insert({
      client_id: formData.get('client_id') as string,
      step_title: formData.get('step_title') as string,
      step_description: formData.get('step_description') as string,
      order: parseInt(formData.get('order') as string),
      completed: false,
    })

    if (error) {
      alert(`Error adding step: ${error.message}`)
      return
    }

    setShowAddStep(false)
    loadOnboardingSteps()
    ;(e.target as HTMLFormElement).reset()
  }

  const toggleStepCompletion = async (stepId: string, currentStatus: boolean) => {
    const { error } = await supabase
      .from('onboarding_steps')
      .update({ completed: !currentStatus })
      .eq('id', stepId)

    if (error) {
      alert(`Error updating step: ${error.message}`)
      return
    }

    loadOnboardingSteps()
  }

  const filteredCampaigns = selectedClient
    ? campaigns.filter(c => c.client_id === selectedClient)
    : campaigns

  const filteredSteps = selectedClient
    ? onboardingSteps.filter(s => s.client_id === selectedClient)
    : onboardingSteps

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <header className="border-b border-[#222222] bg-[#111111]">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-white">Admin Panel</h1>
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-8 space-y-8">
        {/* Clients Section */}
        <section className="bg-[#111111] border border-[#222222] rounded-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-white">Clients</h2>
            <button
              onClick={() => setShowCreateClient(!showCreateClient)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
            >
              + Create Client
            </button>
          </div>

          {showCreateClient && (
            <form onSubmit={handleCreateClient} className="mb-6 p-4 bg-[#0a0a0a] border border-[#222222] rounded-md space-y-4">
              <input
                name="email"
                type="email"
                placeholder="Email"
                required
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                name="password"
                type="password"
                placeholder="Password"
                required
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                name="company_name"
                type="text"
                placeholder="Company Name"
                required
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors"
              >
                Create
              </button>
            </form>
          )}

          <div className="space-y-2">
            {clients.map(client => (
              <div
                key={client.id}
                onClick={() => setSelectedClient(client.id === selectedClient ? null : client.id)}
                className={`p-4 border rounded-md cursor-pointer transition-colors ${
                  selectedClient === client.id
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-[#222222] hover:border-[#333333]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white font-medium">{client.company_name || 'Unnamed Company'}</p>
                    <p className="text-sm text-gray-400">{client.email}</p>
                  </div>
                  <div className="text-sm text-gray-500">
                    {new Date(client.created_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Campaigns Section */}
        <section className="bg-[#111111] border border-[#222222] rounded-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-white">
              Campaigns {selectedClient && '(Filtered)'}
            </h2>
            <button
              onClick={() => setShowAddCampaign(!showAddCampaign)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
            >
              + Add Campaign
            </button>
          </div>

          {showAddCampaign && (
            <form onSubmit={handleAddCampaign} className="mb-6 p-4 bg-[#0a0a0a] border border-[#222222] rounded-md space-y-4">
              <select
                name="client_id"
                required
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select Client</option>
                {clients.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.company_name || client.email}
                  </option>
                ))}
              </select>
              <input
                name="campaign_name"
                type="text"
                placeholder="Campaign Name"
                required
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                name="instantly_campaign_id"
                type="text"
                placeholder="Instantly Campaign ID"
                required
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors"
              >
                Add Campaign
              </button>
            </form>
          )}

          <div className="space-y-2">
            {filteredCampaigns.map(campaign => {
              const client = clients.find(c => c.id === campaign.client_id)
              return (
                <div key={campaign.id} className="p-4 border border-[#222222] rounded-md">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white font-medium">{campaign.campaign_name}</p>
                      <p className="text-sm text-gray-400">
                        {client?.company_name || 'Unknown Client'} • ID: {campaign.instantly_campaign_id}
                      </p>
                    </div>
                    <span className="text-xs px-2 py-1 bg-green-500/20 text-green-400 rounded">
                      {campaign.status}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Onboarding Steps Section */}
        <section className="bg-[#111111] border border-[#222222] rounded-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-white">
              Onboarding Steps {selectedClient && '(Filtered)'}
            </h2>
            <button
              onClick={() => setShowAddStep(!showAddStep)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md transition-colors"
            >
              + Add Step
            </button>
          </div>

          {showAddStep && (
            <form onSubmit={handleAddStep} className="mb-6 p-4 bg-[#0a0a0a] border border-[#222222] rounded-md space-y-4">
              <select
                name="client_id"
                required
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select Client</option>
                {clients.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.company_name || client.email}
                  </option>
                ))}
              </select>
              <input
                name="step_title"
                type="text"
                placeholder="Step Title"
                required
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <textarea
                name="step_description"
                placeholder="Step Description"
                rows={3}
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                name="order"
                type="number"
                placeholder="Order"
                required
                min="1"
                className="w-full px-3 py-2 bg-[#111111] border border-[#222222] rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors"
              >
                Add Step
              </button>
            </form>
          )}

          <div className="space-y-2">
            {filteredSteps.map(step => {
              const client = clients.find(c => c.id === step.client_id)
              return (
                <div key={step.id} className="p-4 border border-[#222222] rounded-md">
                  <div className="flex items-start gap-4">
                    <button
                      onClick={() => toggleStepCompletion(step.id, step.completed)}
                      className={`mt-1 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        step.completed
                          ? 'bg-blue-600 border-blue-600'
                          : 'border-[#444444] hover:border-blue-500'
                      }`}
                    >
                      {step.completed && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                    <div className="flex-1">
                      <p className={`font-medium ${step.completed ? 'text-gray-400 line-through' : 'text-white'}`}>
                        {step.step_title}
                      </p>
                      <p className="text-sm text-gray-400 mt-1">{step.step_description}</p>
                      <p className="text-xs text-gray-500 mt-2">
                        {client?.company_name || 'Unknown Client'} • Order: {step.order}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
