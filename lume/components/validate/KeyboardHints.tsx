const KEYS: [string, string][] = [
  ['J', 'next'],
  ['K', 'previous'],
  ['A', 'approve'],
  ['R', 'reject'],
  ['E', 'edit rows'],
]

/** Footer legend for the Validate shortcuts (ignored while typing in a field). */
export function KeyboardHints() {
  return (
    <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px] text-fg-24" aria-label="Keyboard shortcuts">
      {KEYS.map(([k, label]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <kbd className="rounded-sm border border-line px-[5px] py-[2px] font-mono text-fg-46">{k}</kbd>
          {label}
        </span>
      ))}
      <span>· same claims as the Telegram buttons — whichever lands first wins</span>
    </p>
  )
}
