import Image from 'next/image'

/** Film grain: inline SVG fractal noise, tiled. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/**
 * Fixed full-viewport background, rendered once in the root layout behind
 * everything (`-z-10`, no pointer events). Both theme layers are in the DOM
 * and the `dark` / `light` class on <html> picks one, so there is no
 * hydration flash and no client JS.
 */
export function AppBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Dark — "gamer": #050505, topo contours, drifting glow blobs, grain, grid. */}
      <div className="absolute inset-0 hidden bg-[#050505] dark:block">
        <Image
          src="/bg/dark-topo.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="scale-105 object-cover object-[70%_center] opacity-25 blur-[8px]"
        />
        <div className="anim-blob absolute -top-[22vw] -left-[18vw] size-[52vw] rounded-full bg-lime/10 blur-[120px] [animation:blob-drift-a_80s_ease-in-out_infinite]" />
        <div className="anim-blob absolute -top-[16vw] -right-[20vw] size-[46vw] rounded-full bg-[#7d39eb]/14 blur-[120px] [animation:blob-drift-b_90s_ease-in-out_infinite]" />
        <div className="anim-blob absolute -right-[14vw] -bottom-[26vw] size-[58vw] rounded-full bg-[#7d39eb]/14 blur-[120px] [animation:blob-drift-c_70s_ease-in-out_infinite]" />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.022) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.022) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: GRAIN }} />
      </div>

      {/* Light — "nature": moss branch as texture under a white veil + vignette. */}
      <div className="absolute inset-0 hidden bg-gradient-to-br from-[#E8EFE3] to-[#CFDCC6] light:block">
        <Image
          src="/bg/moss.jpg"
          alt=""
          fill
          loading="eager"
          sizes="100vw"
          className="scale-125 object-cover object-[50%_60%] blur-[20px]"
        />
        {/* Literal white: Tailwind `white` is remapped to ink in light mode. */}
        <div className="absolute inset-0 bg-[#ffffff]/58" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(15,26,18,0.10)_100%)]" />
      </div>
    </div>
  )
}
