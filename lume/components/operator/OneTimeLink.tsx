'use client'

import { useState } from 'react'

/**
 * A Grok Bot sign-in link returned once by an approved issue_operator_key.
 * Lives only in this component's state: Lume stores a masked copy, so a
 * reload loses it (revoke and re-issue if it was not copied).
 */
export function OneTimeLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-2 rounded-md border border-primary/60 p-2 text-[13px]" role="status" aria-label="New Grok Bot sign-in link">
      <p className="text-fg-70">Sign-in link, shown once. Copy it into the new Grok Bot now; Lume keeps only a masked copy.</p>
      <div className="mt-1.5 flex gap-2">
        <input
          readOnly
          value={url}
          aria-label="Sign-in link"
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 font-mono text-[12px]"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="rounded border border-primary bg-primary px-2 text-[12px] text-primary-foreground"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true))
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
