import Image from 'next/image'

/**
 * Fixed full-viewport background, rendered once in the root layout behind
 * everything (`-z-10`, no pointer events). Both theme layers are in the DOM
 * and the `dark` / `light` class on <html> picks one, so there is no
 * hydration flash and no client JS.
 */
export function AppBackground() {
  return (
    <div aria-hidden data-app-bg className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Dark: the owner's lime-on-black gradient (2026-11-09), drifting slowly; a dark veil
          keeps text readable over the bright side. */}
      <div className="absolute inset-0 hidden bg-[#050505] dark:block">
        <Image
          src="/bg/lume-gradient.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover will-change-transform [animation:bg-drift_90s_ease-in-out_infinite_alternate]"
        />
        <div className="absolute inset-0 bg-[#050505]/45" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.5)_100%)]" />
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
