'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowUp, BookMarked, Brain, PanelRight, ChevronRight, KeyRound, MessageSquareDashed, PanelLeft, RotateCcw, ShieldCheck, ShieldOff, ShieldX, SquarePen, Wrench } from 'lucide-react'
import { AgentHistory, useConversationList, useMoveChat } from '@/components/agent/AgentHistory'
import { ProjectChip } from '@/components/agent/ProjectChip'
import { useProjectList } from '@/hooks/useProjectList'
import { useFileDropGuard } from '@/hooks/useFileDropGuard'
import { AttachButton, filesFrom, ImageChips, pastedImages, useImageAttachments } from '@/components/agent/ImageAttachments'
import { ApprovalCard, type ApprovalDecision } from '@/components/agent/ApprovalCard'
import { ManageSkills, SkillCard, SkillMenu, useSkillList } from '@/components/agent/AgentSkills'
import { Markdown } from '@/components/agent/Markdown'
import { Waveform } from '@/components/agent/Waveform'
import { AgentStatus, statusLabel } from '@/components/agent/AgentStatus'
import { AgentMemory } from '@/components/agent/AgentMemory'
import { AgentSidePanel, type ReviewSetRef, type SideTab } from '@/components/agent/AgentSidePanel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { chatDiagrams, REVIEW_TOOLS } from '@/lib/agent/chatDiagrams'
import { htmlLinksToMarkdown } from '@/lib/agent/linkify'
import { MESSAGE_MAX } from '@/lib/agent/chat'
import { ToolLog, type ToolLogEntry } from '@/components/orb/ToolLog'
import { useSpeechRecognition, VoiceInput } from '@/components/orb/VoiceInput'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgentChat, type ChatMessage } from '@/hooks/useAgentChat'
import type { Skill, SkillMode } from '@/lib/agent/skillModel'
import { cn } from '@/lib/utils'

/** What "Save this chat as a skill" sends: the agent drafts it and waits for the owner's OK. */
export const SAVE_SKILL_PROMPT =
  'Save the pipeline from this conversation as a skill. Draft the name, description, steps and variables, show them to me, and wait for my OK before calling save_skill.'

export const SUGGESTIONS = [
  "What's waiting on me?",
  'Summarize campaign performance this week',
  'Which rules run today?',
  'Any orders stuck in validation?',
] as const

/** Typing somewhere else: `/` and ⌘K belong to that field. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable || el.getAttribute('role') === 'textbox'
}

function greeting(d = new Date()) {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

const COLLAPSE_KEY = 'lume.agent.history.collapsed'

/**
 * `/agent`: a ChatGPT/Claude-style conversation with the Lume agent. History
 * sidebar on the left (collapsible; a sheet on narrow screens), then a
 * centered 760px column, messages above, composer pinned at the bottom with a
 * voice waveform (idle pulse / live mic / working shimmer). The open
 * conversation lives in `?c=<id>`, so a refresh keeps it.
 */
export function AgentChat() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const urlId = params.get('c')
  const [refreshKey, setRefreshKey] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<SideTab>('pipeline')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [activeSetId, setActiveSetId] = useState<string | null>(null)
  const [leadsRefresh, setLeadsRefresh] = useState(0)
  const desktop = useMediaQuery('(min-width: 1024px)')
  const phone = useMediaQuery('(max-width: 639.98px)')
  const bump = useCallback(() => setRefreshKey((k) => k + 1), [])
  const list = useConversationList(refreshKey)
  const projects = useProjectList(refreshKey)
  // A file dropped beside a project row must not navigate away from the chat.
  useFileDropGuard()
  const moveChat = useMoveChat(list)
  const newProjectId = params.get('project')
  const skills = useSkillList(refreshKey)
  const [picked, setPicked] = useState<Skill | null>(null)
  const [attach, setAttach] = useState<SkillMode | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const chat = useAgentChat({
    conversationId: urlId,
    verticalId: params.get('vertical'),
    projectId: newProjectId,
    onConversation: (id) => {
      router.replace(`${pathname}?c=${id}`, { scroll: false })
      bump()
    },
    onSettled: bump,
  })
  const speech = useSpeechRecognition()
  const [draft, setDraft] = useState('')
  const images = useImageAttachments()
  const [dragging, setDragging] = useState(false)
  const [hello, setHello] = useState('Hello')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const { messages, busy, send } = chat

  // Split screen: diagrams and lead review sets from this conversation live in the right panel.
  const diagrams = useMemo(() => chatDiagrams(messages), [messages])
  const latestDiagram = diagrams.at(-1)?.key ?? null
  const reviewSig = useMemo(
    () => messages.reduce((n, m) => n + m.tools.filter((t) => REVIEW_TOOLS.has(t.name) && t.status !== 'running').length, 0),
    [messages]
  )
  const sets = useReviewSets(chat.conversationId, reviewSig)
  const latestSet = sets[0]?.id ?? null

  useEffect(() => {
    setPanelOpen(false)
    setActiveKey(null)
    setActiveSetId(null)
  }, [chat.conversationId])
  useEffect(() => {
    if (!latestDiagram) return
    setActiveKey(latestDiagram)
    setPanelTab('pipeline')
    // On phones the panel is a full-screen sheet: don't cover the chat unasked (the chip / Show button opens it).
    if (!onPhone()) setPanelOpen(true)
  }, [latestDiagram])
  useEffect(() => {
    if (!latestSet) return
    setActiveSetId(latestSet)
    setPanelTab('leads')
    if (!onPhone()) setPanelOpen(true)
  }, [latestSet])
  // The agent loaded or filtered leads: refresh the table and bring it forward.
  useEffect(() => {
    if (!reviewSig) return
    setLeadsRefresh((n) => n + 1)
    setPanelTab('leads')
    if (!onPhone()) setPanelOpen(true)
  }, [reviewSig])
  const hasPanel = diagrams.length > 0 || sets.length > 0
  const split = panelOpen && hasPanel
  const viewDiagram = useCallback((key: string) => {
    setActiveKey(key)
    setPanelTab('pipeline')
    setPanelOpen(true)
  }, [])

  useEffect(() => setHello(greeting()), [])

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {
      // storage blocked: start expanded
    }
  }, [])
  const toggleCollapsed = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1')
      } catch {
        // per-viewer convenience only
      }
      return !v
    })

  const newChat = useCallback(() => {
    if (busy) return
    chat.reset()
    setSheetOpen(false)
    if (urlId || newProjectId) router.push(pathname, { scroll: false })
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [busy, chat, urlId, newProjectId, router, pathname])

  const newChatInProject = useCallback(
    (projectId: string) => {
      if (busy) return
      chat.reset()
      setSheetOpen(false)
      router.push(`${pathname}?project=${projectId}`, { scroll: false })
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [busy, chat, router, pathname]
  )
  const openProject = useCallback((projectId: string) => router.push(`/agent/projects/${projectId}`), [router])

  // The open chat's project (from the list), or the one a new chat will start in.
  const known = new Set((projects.items ?? []).map((p) => p.id))
  const listed = list.items?.find((c) => c.id === chat.conversationId)
  const rawProject = chat.conversationId ? (listed?.project_id ?? null) : newProjectId
  const currentProject = rawProject && known.has(rawProject) ? rawProject : null
  const pickProject = useCallback(
    (projectId: string | null) => {
      if (chat.conversationId) void moveChat(chat.conversationId, projectId)
      else router.replace(projectId ? `${pathname}?project=${projectId}` : pathname, { scroll: false })
    },
    [chat.conversationId, moveChat, router, pathname]
  )

  const openConversation = useCallback(
    (id: string) => {
      setSheetOpen(false)
      if (id !== chat.conversationId) router.push(`${pathname}?c=${id}`, { scroll: false })
    },
    [chat.conversationId, router, pathname]
  )

  const clearSkill = useCallback(() => {
    setPicked(null)
    setAttach(null)
  }, [])

  const submit = useCallback(
    (text: string) => {
      // Images still uploading hold the send; an image-only message is fine.
      if ((!text.trim() && !images.refs.length) || busy || chat.loading || images.pending) return
      setDraft('')
      const opts = images.refs.length ? { images: images.refs } : undefined
      images.clear()
      // A skill attached as reference rides along with this one message.
      if (picked && attach === 'reference') {
        void send(text, { id: picked.id, name: picked.name, mode: 'reference' }, opts)
        clearSkill()
        return
      }
      void send(text, undefined, opts)
    },
    [busy, chat.loading, send, picked, attach, clearSkill, images]
  )

  const runSkill = useCallback(() => {
    if (!picked || busy || chat.loading) return
    if (images.pending) return
    const extra = draft.trim()
    setDraft('')
    const opts = images.refs.length ? { images: images.refs } : undefined
    images.clear()
    void send(`Run the skill "${picked.name}".${extra ? `\n\n${extra}` : ''}`, { id: picked.id, name: picked.name, mode: 'run' }, opts)
    clearSkill()
  }, [picked, busy, chat.loading, draft, send, clearSkill, images])

  // Drop a picked skill that was deleted in Manage.
  useEffect(() => {
    if (picked && skills.items && !skills.items.some((s) => s.id === picked.id)) clearSkill()
  }, [picked, skills.items, clearSkill])

  // Hand the composer back once a run finishes (it is disabled while one is live).
  const hadRun = messages.length > 0
  useEffect(() => {
    if (!busy && hadRun) inputRef.current?.focus()
  }, [busy, hadRun])

  // Auto-grow the textarea up to ~8 lines.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft])

  // Keep the newest message in view while it streams.
  const last = messages.at(-1)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages.length, last?.text, last?.tools.length, last?.approvals.length])

  // `/` or ⌘K / Ctrl+K focuses the composer when nothing else is being typed in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey
      const cmdK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)
      if (!slash && !cmdK) return
      if (isTypingTarget(document.activeElement)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const history = (
    <AgentHistory
      list={list}
      projects={projects}
      activeId={chat.conversationId}
      busy={busy}
      onSelect={openConversation}
      onNew={newChat}
      onNewInProject={newChatInProject}
      onOpenProject={openProject}
      onDeletedActive={() => {
        chat.reset()
        router.replace(pathname, { scroll: false })
      }}
      className="h-full"
    />
  )

  return (
    <div className="flex w-full gap-6">
      {!collapsed && (
        <aside className="glass sticky top-[calc(var(--topbar-h)+2rem)] hidden h-[calc(100dvh-var(--topbar-h)-4rem)] w-64 shrink-0 overflow-hidden rounded-panel p-3 lg:block">
          {history}
        </aside>
      )}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="w-72 p-4 pt-12">
          <SheetTitle className="sr-only">Chat history</SheetTitle>
          {history}
        </SheetContent>
      </Sheet>

      <div className="relative min-w-0 flex-1">
        {/* Toolbar is its own row above the chat panel so it never covers messages. */}
        <div className={cn('z-10 mb-2 flex items-center gap-1', !(split && desktop) && 'mx-auto max-w-[1200px]')}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hidden lg:inline-flex"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Show chat history' : 'Hide chat history'}
            aria-pressed={!collapsed}
          >
            <PanelLeft className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="max-sm:size-10 lg:hidden" onClick={() => setSheetOpen(true)} aria-label="Show chat history">
            <PanelLeft className="size-4" />
          </Button>
          {/* New chat lives in the sidebar; repeat it here whenever the sidebar is out of view. */}
          <Button variant="ghost" size="icon-sm" className={cn('max-sm:size-10', !collapsed && 'lg:hidden')} onClick={newChat} disabled={busy} aria-label="New chat">
            <SquarePen className="size-4" />
          </Button>
          {(projects.items?.length ?? 0) > 0 && (
            <ProjectChip projects={projects.items ?? []} current={currentProject} disabled={busy} onPick={pickProject} onOpen={openProject} />
          )}
          <Button variant="ghost" size="icon-sm" className="max-sm:size-10" onClick={() => setMemoryOpen(true)} aria-label="Memory" title="What Lume remembers">
            <Brain className="size-4" />
          </Button>
          {/* Per conversation, in memory only: a new chat or another conversation turns it off. */}
          <Button
            variant="ghost"
            size="sm"
            className={cn('max-sm:h-10', chat.skipPermissions && 'bg-red/10 text-red hover:bg-red/15 hover:text-red')}
            onClick={() => chat.setSkipPermissions(!chat.skipPermissions)}
            aria-pressed={chat.skipPermissions}
            aria-label="Skip permissions"
            title="Let Lume act without asking in this chat (never for spending money or emailing leads)"
          >
            <ShieldOff className="size-3.5" />
            <span className="max-sm:sr-only">Skip permissions</span>
          </Button>
          {hasPanel && !panelOpen && (
            <Button variant="outline" size="sm" className="anim-rise ml-1 max-sm:h-10" onClick={() => setPanelOpen(true)}>
              <PanelRight className="size-3.5" /> Show {diagrams.length ? 'pipeline' : 'leads'}
            </Button>
          )}
        </div>
        <AgentMemory open={memoryOpen} onOpenChange={setMemoryOpen} />
        {/* The conversation sits on its own dense glass panel so text stays readable over the wallpaper. */}
        {(() => {
          const column = (
        <div
          className={cn(
            // Fixed-height rounded panel: only the messages scroll (inside the clip), so the
            // corners stay rounded at any scroll position and nothing passes behind the composer.
            'glass-overlay flex w-full flex-col overflow-hidden rounded-panel',
            split && desktop
              ? 'split-chat-in h-full'
              : // Phones: visual viewport (shrinks with the keyboard) minus header, bottom bar, padding and the toolbar row.
                'mx-auto h-[calc(var(--vvh,100dvh)-var(--topbar-h)-var(--bottombar-h)-4.75rem)] max-w-[1200px] sm:h-[calc(100dvh-var(--topbar-h)-6.75rem)]'
          )}
        >
          <div
            className="thin-scroll scroll-fade-bottom min-h-0 flex-1 overflow-y-auto px-4 pt-4 sm:px-8 sm:pt-7"
            aria-live="polite"
            aria-busy={busy || chat.loading}
          >
            {chat.notFound ? (
              <MissingConversation onNew={newChat} />
            ) : chat.loading ? (
              <LoadingConversation />
            ) : messages.length === 0 ? (
              <EmptyState hello={hello} onPick={submit} disabled={busy} />
            ) : (
              <ol className="flex flex-col gap-7 pt-2 pb-6" aria-label="Conversation">
                {messages.map((m) => (
                  <li key={m.id} className="min-w-0">
                    <Message
                      m={m}
                      onDecided={chat.followUp}
                      activeFlow={split && activeKey?.startsWith(`${m.id}:`) ? Number(activeKey.split(':').at(-1)) : null}
                      onViewFlow={(k) => viewDiagram(`${m.id}:${k}`)}
                    />
                  </li>
                ))}
              </ol>
            )}
            <div ref={endRef} />
          </div>

          <div className="shrink-0 border-t border-line bg-[var(--glass-fill-strong)] px-3 pt-2.5 pb-3 sm:px-8 sm:pt-3 sm:pb-4">
            {chat.skipPermissions && (
              <div className="mb-3 flex items-center gap-2 rounded-control border border-red/40 bg-red/10 px-3 py-2 text-[13px] text-red" role="status">
                <ShieldOff className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">Skip permissions is on — I&apos;ll act without asking, except spending money or emailing leads.</span>
                <Button variant="outline" size="xs" className="shrink-0" onClick={() => chat.setSkipPermissions(false)}>
                  Turn off
                </Button>
              </div>
            )}
            {speech.listening ? (
              <>
                <div className="mb-2 flex items-center justify-center gap-3">
                  <Waveform mode="listening" className="h-11" />
                </div>
                <p className="mb-2 truncate text-center text-[12px] text-fg-46" role="status">
                  {speech.transcript || 'Listening…'}
                </p>
              </>
            ) : (
              <AgentStatus
                active={busy}
                label={statusLabel({ runningTool: chat.runningTool, liveStatus: chat.liveStatus, streaming: chat.streaming })}
                className="mb-3"
              />
            )}
            {picked && (
              <SkillCard
                skill={picked}
                mode={attach}
                busy={busy || chat.loading}
                onRun={runSkill}
                onReference={() => {
                  setAttach((m) => (m === 'reference' ? null : 'reference'))
                  inputRef.current?.focus()
                }}
                onClear={clearSkill}
              />
            )}
            <div className="mb-2 flex items-center gap-2">
              <SkillMenu
                list={skills}
                disabled={busy}
                canSave={messages.length > 0 && !busy && !chat.loading}
                onPick={(s) => {
                  setPicked(s)
                  setAttach(null)
                }}
                onSave={() => submit(SAVE_SKILL_PROMPT)}
                onManage={() => setManageOpen(true)}
              />
            </div>
            <ImageChips items={images.items} onRemove={images.remove} disabled={busy} />
            <form
              className={cn(
                'glass flex items-end gap-2 rounded-2xl p-2 pl-4 transition-colors focus-within:border-primary/60',
                (speech.listening || dragging) && 'border-primary/60',
                dragging && 'bg-accent'
              )}
              onSubmit={(e) => {
                e.preventDefault()
                submit(draft)
              }}
              onDragOver={(e) => {
                if (busy || !Array.from(e.dataTransfer.types ?? []).includes('Files')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDragging(true)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
              }}
              onDrop={(e) => {
                setDragging(false)
                const files = filesFrom(e.dataTransfer)
                if (busy || !files.length) return
                e.preventDefault()
                images.add(files)
                inputRef.current?.focus()
              }}
            >
              <label htmlFor="agent-composer" className="sr-only">
                Message Lume
              </label>
              <textarea
                id="agent-composer"
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  // A copied screenshot arrives as a file; a paste with any text pastes the text only.
                  const files = pastedImages(e.clipboardData)
                  if (!files.length) return
                  e.preventDefault()
                  images.add(files)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    submit(draft)
                  }
                }}
                rows={1}
                maxLength={MESSAGE_MAX}
                disabled={busy}
                placeholder={
                  busy
                    ? 'Lume is working…'
                    : picked && attach === 'reference'
                      ? `Ask with “${picked.name}” as reference…`
                      : phone
                        ? 'Ask Lume anything'
                        : 'Ask Lume anything — press / to focus'
                }
                aria-describedby="agent-composer-hint"
                className="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent py-2 focus-visible:outline-none! text-[15px] leading-6 text-fg outline-none placeholder:text-fg-24 disabled:opacity-60"
              />
              <AttachButton onFiles={images.add} disabled={busy} />
              <VoiceInput speech={speech} onFinal={submit} />
              <button
                type="submit"
                disabled={busy || images.pending || (!draft.trim() && !images.refs.length)}
                aria-label="Send message"
                className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-[opacity,background-color] outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-35 dark:shadow-(--primary-glow)"
              >
                <ArrowUp className="size-4" />
              </button>
            </form>
            {images.error && (
              <p className="mt-2 text-center text-[12px] text-red" role="alert">
                {images.error}
              </p>
            )}
            <p id="agent-composer-hint" className="mt-2 flex items-center justify-center gap-3 text-[11px] text-fg-24 max-sm:sr-only">
              <span>Enter to send · Shift+Enter for a new line</span>
              <span aria-hidden>·</span>
              <span className={cn(chat.skipPermissions && 'text-red/80')}>
                {chat.skipPermissions ? 'Skip permissions on — money and emails still ask' : 'Anything risky waits for your approval'}
              </span>
              {messages.length > 0 && !busy && (
                <button type="button" onClick={newChat} className="inline-flex items-center gap-1 text-fg-46 hover:text-fg">
                  <RotateCcw className="size-3" /> New chat
                </button>
              )}
            </p>
            <ManageSkills open={manageOpen} onOpenChange={setManageOpen} list={skills} />
            {speech.error && (
              <p className="mt-1 text-center text-[12px] text-red" role="alert">
                Microphone: {speech.error}
              </p>
            )}
          </div>
        </div>
          )
          const panel = (
            <AgentSidePanel
              tab={panelTab}
              onTab={setPanelTab}
              diagrams={diagrams}
              activeKey={activeKey}
              onSelectDiagram={setActiveKey}
              sets={sets}
              activeSetId={activeSetId}
              onSelectSet={setActiveSetId}
              leadsRefresh={leadsRefresh}
              onClose={() => setPanelOpen(false)}
            />
          )
          if (!split) return column
          if (!desktop)
            return (
              <>
                {column}
                <Sheet open onOpenChange={(o) => !o && setPanelOpen(false)}>
                  <SheetContent side="right" className="w-full! max-w-none! p-0" showCloseButton={false}>
                    <SheetTitle className="sr-only">Pipeline and leads</SheetTitle>
                    {panel}
                  </SheetContent>
                </Sheet>
              </>
            )
          return (
            <div className="h-[calc(100dvh-var(--topbar-h)-6.5rem)]">
              <ResizablePanelGroup orientation="horizontal" className="gap-0">
                <ResizablePanel defaultSize="45" minSize="28">
                  {column}
                </ResizablePanel>
                <ResizableHandle withHandle className="mx-2 bg-transparent" />
                <ResizablePanel defaultSize="55" minSize="28">
                  {panel}
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

const onPhone = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639.98px)').matches

/** Matches a media query on the client (false during SSR). */
function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const update = () => setOn(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])
  return on
}

/** Lead review sets loaded in this conversation, newest first; refetched after each review tool call. */
function useReviewSets(conversationId: string | null, sig: number): ReviewSetRef[] {
  const [sets, setSets] = useState<ReviewSetRef[]>([])
  useEffect(() => setSets([]), [conversationId])
  useEffect(() => {
    if (!conversationId) return
    let live = true
    fetch(`/api/review-sets?conversation=${conversationId}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { sets: [] }))
      .then((b: { sets?: ReviewSetRef[] }) => {
        if (!live) return
        const next = (b.sets ?? []).map((x) => ({ id: x.id, title: x.title }))
        setSets((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.title === next[i].title) ? prev : next))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [conversationId, sig])
  return sets
}

function MissingConversation({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex min-h-[46vh] flex-col items-center justify-center text-center" role="status">
      <MessageSquareDashed className="size-6 text-fg-46" />
      <h2 className="mt-3 text-[18px] font-semibold text-fg">This chat isn&apos;t here</h2>
      <p className="mt-1 text-[14px] text-fg-46">It was deleted, or the link is wrong.</p>
      <Button className="mt-5" onClick={onNew}>
        Start a new chat
      </Button>
    </div>
  )
}

function LoadingConversation() {
  return (
    <div className="flex flex-col gap-7 pt-2" aria-label="Loading conversation">
      <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}

function EmptyState({ hello, onPick, disabled }: { hello: string; onPick: (t: string) => void; disabled: boolean }) {
  return (
    <div className="flex min-h-[46vh] flex-col items-center justify-center text-center">
      <h2 className="text-[30px] font-semibold tracking-[-0.8px] text-fg">{hello}.</h2>
      <p className="mt-2 text-[15px] text-fg-46">Ask about orders, gates, campaigns or rules — or tell me what to run.</p>
      <div className="mt-7 flex max-w-[620px] flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="rounded-full border border-(--glass-border) bg-(--glass-fill) px-3.5 py-2 backdrop-blur-md text-[13px] text-fg-70 transition-colors hover:border-primary/50 hover:bg-white/8 hover:text-fg disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function Message({
  m,
  activeFlow = null,
  onViewFlow,
  onDecided,
}: {
  m: ChatMessage
  activeFlow?: number | null
  onViewFlow?: (k: number) => void
  onDecided?: (d: ApprovalDecision) => void
}) {
  if (m.role === 'user' && m.auto) return <AutoTurn text={m.text} />
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] flex-col items-end gap-1.5">
          {m.skill && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/4 px-2.5 py-0.5 text-[11.5px] text-fg-70">
              <BookMarked className="size-3 text-positive" />
              {m.skill.mode === 'run' ? 'Running skill' : 'Skill as reference'}: {m.skill.name}
            </span>
          )}
          {m.images && m.images.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {m.images.map((img, i) => (
                <a key={`${img.url}-${i}`} href={img.url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl border border-line bg-white/4">
                  {/* eslint-disable-next-line @next/next/no-img-element -- served by the owner-only proxy; next/image would fetch it without the session */}
                  <img src={img.url} alt={img.name} title={img.name} loading="lazy" className="max-h-48 max-w-[16rem] object-cover" />
                </a>
              ))}
            </div>
          )}
          {m.text && <div className="rounded-2xl bg-white/8 px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-fg">{m.text}</div>}
        </div>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {m.tools.length > 0 && <ToolChips tools={m.tools} live={!!m.streaming} />}
      {m.text && <Markdown text={htmlLinksToMarkdown(m.text)} flow={onViewFlow ? { onView: onViewFlow, active: activeFlow } : undefined} />}
      <ApprovalCard approvals={m.approvals} onDecided={onDecided} />
      {m.notConfigured ? (
        <div className="flex items-start gap-3 rounded-panel border border-amber/40 bg-amber/8 px-4 py-3 text-[13px]" role="status">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-amber" />
          <div>
            <p className="font-medium text-amber">The agent isn&apos;t set up yet</p>
            <p className="mt-0.5 text-fg-70">
              {m.error} Add <code className="font-mono text-[12px] text-fg">ANTHROPIC_API_KEY</code> to the deployment&apos;s environment and redeploy — the
              rest of Lume works without it.
            </p>
          </div>
        </div>
      ) : (
        m.error && (
          <p className="rounded-control border border-red/40 bg-red/10 px-3 py-2 text-[13px] text-red" role="alert">
            {m.error}
          </p>
        )
      )}
    </div>
  )
}

/** Lume told the agent how an approval came out: one muted line, not a bubble. */
function AutoTurn({ text }: { text: string }) {
  const denied = text.startsWith('[approval] I denied') || /handled elsewhere: rejected\b/.test(text)
  const Icon = denied ? ShieldX : ShieldCheck
  return (
    <p className="flex items-start gap-1.5 text-[12px] text-fg-46" aria-label="Approval outcome sent to Lume">
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{text.replace(/^\[approval\]\s*/, '')}</span>
    </p>
  )
}

function ToolChips({ tools, live }: { tools: ToolLogEntry[]; live: boolean }) {
  const running = tools.some((t) => t.status === 'running')
  const failed = tools.filter((t) => t.status === 'error').length
  const ms = tools.reduce((s, t) => s + (t.ms ?? 0), 0)
  return (
    <details className="group w-fit max-w-full" open={live && running ? true : undefined}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-line bg-white/4 px-3 py-1 text-[12px] text-fg-46 select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <Wrench className={cn('size-3', running && 'animate-pulse text-violet-soft')} />
        {running ? `Using ${tools.at(-1)?.name}` : `Used ${tools.length} tool${tools.length === 1 ? '' : 's'}`}
        {failed > 0 && <span className="text-red">· {failed} failed</span>}
        {!running && ms > 0 && <span className="text-fg-24">· {(ms / 1000).toFixed(1)}s</span>}
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-2">
        <ToolLog entries={tools} />
      </div>
    </details>
  )
}

