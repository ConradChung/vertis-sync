import 'server-only'
import type { Json } from '@/lib/db/types'
import { createCampaign } from '@/lib/adapters/instantlyWrite'
import { logEvent, pickCampaign, setNoLocationCampaign } from '@/lib/db/service'
import { getVertical, updateVertical } from '@/lib/operators/store'
import { editMessage } from '@/lib/adapters/telegram'
import { parseChannels } from '@/lib/alerts'

/**
 * Runs an approved `new_campaign` (only lib/actions/execute.ts calls this):
 *  1. POST /campaigns with the confirmed snapshot — a draft; never activated.
 *  2. The No-Location sibling, when confirmed (its failure is reported, the
 *     main campaign stays).
 *  3. Adds the new campaign id(s) to the tag's `campaign_ids` (routing).
 *  4. With `job_id` and the job still waiting for a campaign: picks it for the
 *     job (the same `pickCampaign` the campaign-pick route uses), and points
 *     the job's city-less leads at the sibling.
 * Steps 2–4 never undo step 1; their outcome is in the result.
 */

const s = (v: Json | undefined) => (typeof v === 'string' && v.trim() ? v : null)

export async function executeNewCampaign(p: Record<string, Json>): Promise<Record<string, Json>> {
  const name = s(p.name)
  if (!name) throw new Error('payload.name is required')
  const main = await createCampaign({
    name,
    email_list: (p.email_list as string[]) ?? [],
    campaign_schedule: p.campaign_schedule,
    daily_limit: Number(p.daily_limit),
    stop_on_reply: p.stop_on_reply !== false,
    sequences: p.sequences,
  })
  const result: Record<string, Json> = { campaign_id: main.id, name: main.name, status: 'draft' }

  let sibling: { id: string; name: string } | null = null
  const nl = p.no_location as { name?: Json; sequences?: Json } | undefined
  if (nl && typeof nl.name === 'string') {
    try {
      sibling = await createCampaign({
        name: nl.name,
        email_list: (p.email_list as string[]) ?? [],
        campaign_schedule: p.campaign_schedule,
        daily_limit: Number(p.daily_limit),
        stop_on_reply: p.stop_on_reply !== false,
        sequences: nl.sequences,
      })
      result.no_location_campaign_id = sibling.id
      result.no_location_name = sibling.name
    } catch (err) {
      result.no_location_error = err instanceof Error ? err.message : String(err)
    }
  }

  const verticalId = s(p.vertical_id)
  if (verticalId) {
    try {
      const v = await getVertical(verticalId)
      if (v && !v.archived_at) {
        const ids = [...v.campaign_ids, main.id, ...(sibling ? [sibling.id] : [])]
        await updateVertical(v.id, { campaign_ids: ids })
        result.tagged = v.name
      } else {
        result.tag_error = 'tag not found or archived'
      }
    } catch (err) {
      result.tag_error = err instanceof Error ? err.message : String(err)
    }
  }

  const jobId = s(p.job_id)
  if (jobId) {
    try {
      const moved = await pickCampaign(jobId, { id: main.id, name: main.name })
      result.picked_for_job = !!moved
      if (moved) {
        if (sibling) {
          const r = await setNoLocationCampaign(jobId, sibling)
          result.no_location_set = r === 'ok'
        }
        await logEvent({
          type: 'lume.campaign_pick',
          source: 'lume',
          source_id: jobId,
          campaign_id: main.id,
          title: `New campaign picked for the job: ${main.name}`,
          payload: { campaign_id: main.id, campaign_name: main.name, via: 'new_campaign' },
        }).catch((err) => console.error('[new_campaign] logEvent failed:', err instanceof Error ? err.message : err))
        // Close the stale Telegram campaign prompt (best effort; only while Telegram is on).
        if (typeof moved === 'object' && moved.prompt_message_id !== null && parseChannels(process.env.ALERT_CHANNELS).has('telegram')) {
          await editMessage(moved.prompt_message_id, `✅ Campaign set in Lume: ${main.name}`).catch((err) =>
            console.error('[new_campaign] telegram prompt edit failed:', err instanceof Error ? err.message : err)
          )
        }
      }
    } catch (err) {
      result.pick_error = err instanceof Error ? err.message : String(err)
    }
  }
  return result
}
