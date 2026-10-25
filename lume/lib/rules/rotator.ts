/**
 * The Instantly campaign the existing `instantly-rotate` edge function drains
 * from lead_bank. Same env name and default as that function
 * (supabase/functions/instantly-rotate, retargeted by
 * 20261009074150_lead_bank_retarget_campaign.sql). Not a secret.
 */
export const DEFAULT_ROTATE_CAMPAIGN_ID = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'

export function rotatorCampaignId(): string {
  return process.env.ROTATE_CAMPAIGN_ID?.trim() || DEFAULT_ROTATE_CAMPAIGN_ID
}
