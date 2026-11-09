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
      {/* Dark: #050505 under a slow, blurred lime gradient (owner, 2026-11-09: no wallpaper, no grid).
          Three soft fields drift over minutes; the grain only breaks up gradient banding. */}
      <div className="absolute inset-0 hidden bg-[#050505] dark:block">
        <div className="absolute -top-[30vw] -left-[20vw] size-[70vw] rounded-full bg-[radial-gradient(circle,rgba(198,255,51,0.16),transparent_65%)] will-change-transform [animation:blob-drift-a_140s_ease-in-out_infinite]" />
        <div className="absolute -right-[25vw] -bottom-[35vw] size-[75vw] rounded-full bg-[radial-gradient(circle,rgba(74,107,0,0.30),transparent_65%)] will-change-transform [animation:blob-drift-c_170s_ease-in-out_infinite]" />
        <div className="absolute top-[25vh] left-[35vw] size-[45vw] rounded-full bg-[radial-gradient(circle,rgba(198,255,51,0.06),transparent_70%)] will-change-transform [animation:blob-drift-b_200s_ease-in-out_infinite]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.55)_100%)]" />
        <div className="absolute inset-0 opacity-[0.025]" style={{ backgroundImage: GRAIN }} />
      </div>

      {/* Light — "nature": moss branch as texture under a white veil + vignette. */}
      <div className="absolute inset-0 hidden bg-gradient-to-br from-[#E8EFE3] to-[#CFDCC6] light:block">
        <Image
          src="/bg/moss.jpg"
          alt=""
          fill
          loading="eager"
          sizes="100vw"
          className="scale-125 object-cover object-[50%_60%] blur-[9px]"
        />
        {/* Literal white: Tailwind `white` is remapped to ink in light mode. */}
        <div className="absolute inset-0 bg-[#ffffff]/58" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(15,26,18,0.10)_100%)]" />
      </div>
    </div>
  )
}
