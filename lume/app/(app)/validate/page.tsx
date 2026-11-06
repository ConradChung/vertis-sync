import { redirect } from 'next/navigation'

/** Validate is now Progress: old links (alerts, Telegram, `?gate=` deep links) land on /progress with their query. */
export default async function ValidateRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(await searchParams)) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x))
    else if (v !== undefined) q.set(k, v)
  }
  const s = q.toString()
  redirect(s ? `/progress?${s}` : '/progress')
}
