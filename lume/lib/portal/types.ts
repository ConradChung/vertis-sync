// Shared contract for the read-only client portal (/portal).
// Server: app/api/portal/** (scoped by lume_portal_users). Client: components/portal/**.

export type PortalTab = 'email' | 'linkedin'

export type PortalReplyStatus = 'Interested' | 'Meeting booked' | 'Meeting completed' | 'Won'

export interface PortalLead {
  id: string // lead_bank.id (email tab) or lead_review_items.id (linkedin tab), as string
  kind: PortalTab
  name: string
  first_name: string | null
  title: string | null
  company: string | null
  phone: string | null
  phone_type: 'mobile' | 'company' | null
  email: string | null
  website: string | null
  linkedin_url: string | null
  city: string | null
  state: string | null
  country: string | null
  region: string | null
  timezone: string | null // IANA zone, e.g. "America/Chicago"; null when unknown
  campaign: string | null // campaign display name (email tab) or list title (linkedin tab)
  reply_status: PortalReplyStatus | null
  opened: boolean
  replied: boolean
}

export interface PortalMe {
  email: string
  client: string // e.g. "Kaspen"
}

export type PortalSort = 'company' | 'name' | 'region'

export interface PortalLeadsQuery {
  tab: PortalTab
  q?: string // matches name, company, email, title, phone, city
  region?: string
  has_phone?: boolean
  status?: 'replied_positive'
  sort?: PortalSort
  page?: number // 1-based
}

export interface PortalLeadsResponse {
  rows: PortalLead[]
  total: number
  page: number
  pageSize: number
  regions: string[] // distinct regions available on this tab, for the filter
}

export interface PortalAgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PortalAgentRequest {
  messages: PortalAgentMessage[]
}

export interface PortalAgentResponse {
  reply: string
  leads: PortalLead[] // leads the assistant found, shown as cards under the reply
}

// Owner-only: POST /api/portal/sign-in-link { email } -> { url }
export interface PortalSignInLinkResponse {
  url: string
  expires_in_minutes: number
}
