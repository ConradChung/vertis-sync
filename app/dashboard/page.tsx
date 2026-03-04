import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ClientDashboard from '@/components/ClientDashboard'

export default async function DashboardPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, company_name, role, docusign_url, onboarding_stage, docusign_acknowledged')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
        <div className="bg-[#111111] border border-[#222222] rounded-lg p-8 text-center">
          <p className="text-white text-lg font-semibold mb-2">Profile not found</p>
          <p className="text-gray-400">Please contact your administrator to set up your account.</p>
        </div>
      </div>
    )
  }

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('*')
    .eq('client_id', user.id)

  return (
    <ClientDashboard
      profile={profile}
      campaigns={campaigns || []}
    />
  )
}
