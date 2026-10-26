import Link from 'next/link'

/** App-wide 404 in the glass system (Next's default page paints its own white canvas). */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="glass w-full max-w-sm rounded-2xl p-7 text-center">
        <div className="eyebrow">404</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.5px]">Nothing here</h1>
        <p className="mt-2 text-sm text-muted-foreground">That page or action doesn&apos;t exist (or was already handled).</p>
        <Link href="/overview" className="link-accent mt-6 inline-block text-sm hover:underline">
          Back to Overview →
        </Link>
      </section>
    </main>
  )
}
