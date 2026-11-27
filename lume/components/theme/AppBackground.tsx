/**
 * Fixed full-viewport background, rendered once in the root layout behind
 * everything (`-z-10`, no pointer events): a near-neutral base with three
 * soft fields of colour that drift very slowly, one of them a faint lime
 * tint. Pure CSS (`.app-bg*` in globals.css); the theme tokens pick the
 * colours, so there is no image, no client JS and no hydration flash.
 */
export function AppBackground() {
  return (
    <div aria-hidden data-app-bg className="app-bg pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="app-bg-field app-bg-field-a" />
      <div className="app-bg-field app-bg-field-b" />
      <div className="app-bg-field app-bg-field-c" />
    </div>
  )
}
