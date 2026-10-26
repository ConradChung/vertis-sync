'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { OrbSheet, useAgentConversation } from '@/components/orb/OrbSheet'
import { useSpeechRecognition } from '@/components/orb/VoiceInput'
import { useLatestAgentRun } from '@/hooks/useAgentRun'
import { orbStateFrom } from '@/lib/agent/orbState'
import type { OrbState } from '@/components/orb/Orb'

// WebGL only exists in the browser; render a same-size placeholder on the server.
const Orb = dynamic(() => import('@/components/orb/Orb'), {
  ssr: false,
  loading: () => <div className="orb-placeholder" aria-hidden />,
})

/** Typing somewhere: space belongs to that field, not to the orb. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    (el as HTMLElement).isContentEditable ||
    el.getAttribute('role') === 'textbox'
  )
}

/**
 * The top-bar orb: state from the latest `agent_runs` row (Realtime) and the
 * live run in this tab; click toggles the agent sheet; holding space (when
 * no field is focused) dictates, and releasing sends the transcript.
 */
export function AgentOrb() {
  const [open, setOpen] = useState(false)
  const conversation = useAgentConversation()
  const speech = useSpeechRecognition()
  const { run, approvalSettled } = useLatestAgentRun()
  const spaceHeld = useRef(false)

  let state: OrbState = orbStateFrom(run, { listening: speech.listening, approvalSettled })
  // This tab's own stream is ahead of Realtime.
  if (!speech.listening && conversation.busy) state = conversation.acting || state === 'acting' ? 'acting' : 'thinking'

  const { send } = conversation
  const { start, stop, supported } = speech
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!supported) return
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || spaceHeld.current) return
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(document.activeElement)) return
      e.preventDefault()
      spaceHeld.current = true
      setOpen(true)
      start()
    }
    const up = async (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceHeld.current) return
      e.preventDefault()
      spaceHeld.current = false
      const text = await stop()
      if (text) void send(text)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [supported, start, stop, send])

  return (
    <>
      <button
        type="button"
        className="orb-button ml-auto"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close Lume agent' : 'Open Lume agent'}
        aria-expanded={open}
      >
        <Orb compact state={state} />
      </button>
      <OrbSheet open={open} onClose={close} orbState={state} conversation={conversation} speech={speech} />
    </>
  )
}
