import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { MONTHLY_APIFY_CAP_USD } from '@/lib/influencers/model'

export const APIFY_CAP_KEY = 'apify_monthly_cap_usd'
export const APIFY_CAP_MAX_USD = 1000

/**
 * The shared monthly Apify cap, from Settings → Budget (`lume_settings`). The
 * edge functions that start Apify runs read the same row; the env / $29
 * constant is only the fallback when the row is missing or unreadable.
 */
export async function getApifyCapUsd(): Promise<number> {
  const res = await createServiceClient().from('lume_settings').select('value').eq('key', APIFY_CAP_KEY).maybeSingle()
  const n = Number(res.data?.value)
  return !res.error && Number.isFinite(n) && n > 0 && n <= APIFY_CAP_MAX_USD ? n : MONTHLY_APIFY_CAP_USD
}

export async function setApifyCapUsd(usd: number): Promise<number> {
  const res = await createServiceClient()
    .from('lume_settings')
    .upsert({ key: APIFY_CAP_KEY, value: usd, updated_at: new Date().toISOString() })
    .select('value')
    .single()
  if (res.error) throw res.error
  return Number(res.data.value)
}

export const LINEAR_PROJECT_KEY = 'linear_project_id'

/** The Linear project the Calendar files issues in (cached id; null = not resolved yet). */
export async function getLinearProjectId(): Promise<string | null> {
  const res = await createServiceClient().from('lume_settings').select('value').eq('key', LINEAR_PROJECT_KEY).maybeSingle()
  const v = res.data?.value
  return !res.error && typeof v === 'string' && v ? v : null
}

export async function setLinearProjectId(id: string): Promise<void> {
  const res = await createServiceClient()
    .from('lume_settings')
    .upsert({ key: LINEAR_PROJECT_KEY, value: id, updated_at: new Date().toISOString() })
  if (res.error) throw res.error
}
