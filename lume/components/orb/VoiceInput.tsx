'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Web Speech dictation (Chrome / Edge / Safari). Live interim transcript;
 * `stop()` resolves with the final text. Unsupported browsers get
 * `supported: false` and the mic button hides.
 */

interface SpeechResultLike {
  isFinal: boolean
  0: { transcript: string }
}
interface SpeechEventLike {
  resultIndex: number
  results: ArrayLike<SpeechResultLike>
}
interface RecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: SpeechEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start: () => void
  stop: () => void
}
type RecognitionCtor = new () => RecognitionLike

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface Speech {
  supported: boolean
  listening: boolean
  transcript: string
  error: string | null
  start: () => void
  /** Stop and resolve with the transcript heard so far. */
  stop: () => Promise<string>
}

export function useSpeechRecognition(): Speech {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<RecognitionLike | null>(null)
  const finalText = useRef('')
  const interim = useRef('')
  const waiters = useRef<((t: string) => void)[]>([])

  useEffect(() => setSupported(recognitionCtor() !== null), [])

  const flush = useCallback(() => {
    const text = `${finalText.current} ${interim.current}`.trim()
    waiters.current.splice(0).forEach((resolve) => resolve(text))
    return text
  }, [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor || rec.current) return
    const r = new Ctor()
    r.lang = navigator.language || 'en-US'
    r.interimResults = true
    r.continuous = true
    finalText.current = ''
    interim.current = ''
    setTranscript('')
    setError(null)
    r.onresult = (e) => {
      let live = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) finalText.current = `${finalText.current} ${res[0].transcript}`.trim()
        else live += res[0].transcript
      }
      interim.current = live
      setTranscript(`${finalText.current} ${live}`.trim())
    }
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') setError(e.error)
    }
    r.onend = () => {
      rec.current = null
      setListening(false)
      flush()
    }
    rec.current = r
    try {
      r.start()
      setListening(true)
    } catch {
      rec.current = null
    }
  }, [flush])

  const stop = useCallback(() => {
    const r = rec.current
    if (!r) return Promise.resolve(`${finalText.current} ${interim.current}`.trim())
    return new Promise<string>((resolve) => {
      waiters.current.push(resolve)
      r.stop()
    })
  }, [])

  useEffect(() => () => rec.current?.stop(), [])

  return { supported, listening, transcript, error, start, stop }
}

export function VoiceInput({ speech, onFinal }: { speech: Speech; onFinal: (text: string) => void }) {
  if (!speech.supported) return null
  const toggle = async () => {
    if (!speech.listening) return speech.start()
    const text = await speech.stop()
    if (text) onFinal(text)
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={speech.listening}
      aria-label={speech.listening ? 'Stop listening' : 'Speak to Lume'}
      title={speech.listening ? 'Stop' : 'Speak (or hold space)'}
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-full border border-line text-fg-70 transition-colors hover:bg-white/8 hover:text-fg',
        speech.listening && 'border-primary bg-accent text-fg'
      )}
    >
      {speech.listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
    </button>
  )
}
