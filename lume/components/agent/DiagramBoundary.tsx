'use client'

import { Component, type ReactNode } from 'react'

/**
 * Keeps a diagram that fails to draw from blanking its panel or card: shows a
 * short note instead. `resetKey` clears the error when a different diagram is shown.
 */
export class DiagramBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean; key?: string }> {
  state: { failed: boolean; key?: string } = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { failed: boolean; key?: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null
  }

  componentDidCatch(err: unknown) {
    console.error('[diagram] render failed', err)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-full min-h-32 items-center justify-center p-6 text-center" role="status">
        <p className="text-[13px] text-fg-46">This pipeline couldn&apos;t be drawn. Ask the agent to redraw it.</p>
      </div>
    )
  }
}
