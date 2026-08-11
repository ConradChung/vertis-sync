import { NextResponse } from 'next/server'

// Campaign list for the dashboard's push dropdown.
//
// The Telegram path resolves a campaign by typed NAME because a chat can't
// render a picker. On the dashboard we can do better: return the real list and
// let the browser show a <select>, so there's no name matching to get wrong.
//
// Server-side so INSTANTLY_API_KEY never reaches the browser.

const INSTANTLY_BASE_URL = 'https://api.instantly.ai/api/v2'
const PAGE_SIZE = 100
const MAX_PAGES = 10

interface InstantlyCampaign {
  id: string
  name: string
  status: number
}

function statusLabel(status: number): string {
  if (status === 0) return 'draft'
  if (status === 1) return 'active'
  if (status === 2) return 'paused'
  if (status === 3) return 'completed'
  return String(status)
}

export async function GET() {
  const apiKey = process.env.INSTANTLY_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'INSTANTLY_API_KEY is not configured' }, { status: 500 })
  }

  try {
    const campaigns: InstantlyCampaign[] = []
    let startingAfter: string | undefined

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${INSTANTLY_BASE_URL}/campaigns`)
      url.searchParams.set('limit', String(PAGE_SIZE))
      if (startingAfter) url.searchParams.set('starting_after', startingAfter)

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const text = await res.text()
        return NextResponse.json(
          { error: `Instantly campaign list failed (${res.status}): ${text.slice(0, 200)}` },
          { status: 502 },
        )
      }

      const data = (await res.json()) as {
        items?: InstantlyCampaign[]
        next_starting_after?: string
      }
      const items = data.items ?? []
      campaigns.push(...items)

      // The cursor comes back even on a short final page, so stop on page size
      // rather than trusting the cursor alone.
      if (items.length < PAGE_SIZE || !data.next_starting_after) break
      startingAfter = data.next_starting_after
    }

    // Deleted campaigns (status < 0) must never be selectable.
    const selectable = campaigns
      .filter(c => c.status >= 0)
      .map(c => ({ id: c.id, name: c.name, status: c.status, statusLabel: statusLabel(c.status) }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({ campaigns: selectable })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
