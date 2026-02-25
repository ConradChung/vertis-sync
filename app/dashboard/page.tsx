import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ClientDashboard from '@/components/ClientDashboard'

export default async function DashboardPage() {
  const supabase = await createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) {
    redirect('/login')
  }

  // Get campaigns for this client
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('*')
    .eq('client_id', user.id)

  // Get onboarding steps
  const { data: onboardingSteps } = await supabase
    .from('onboarding_steps')
    .select('*')
    .eq('client_id', user.id)
    .order('order', { ascending: true })

  return (
    <ClientDashboard
      profile={profile}
      campaigns={campaigns || []}
      onboardingSteps={onboardingSteps || []}
    />
  )
}
