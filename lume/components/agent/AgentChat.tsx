'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowDown, ArrowUp, BookMarked, Brain, Menu, PanelRight, ChevronRight, Table2, KeyRound, MessageSquareDashed, PanelLeft, RotateCcw, ShieldCheck, ShieldOff, ShieldX, SquarePen, Wrench } from 'lucide-react'
import { AgentHistory, useConversationList, useMoveChat } from '@/components/agent/AgentHistory'
import { ProjectChip } from '@/components/agent/ProjectChip'
import { useProjectList } from '@/hooks/useProjectList'
import { useFileDropGuard } from '@/hooks/useFileDropGuard'
import { AttachButton, filesFrom, ImageChips, pastedImages, useImageAttachments } from '@/components/agent/ImageAttachments'
import { FileChips, MessageFileChips, splitAttachments, useFileAttachments } from '@/components/agent/FileAttachments'
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
import { Button, buttonVariants } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgentChat, type ChatMessage, type SkillRef } from '@/hooks/useAgentChat'
import type { Skill, SkillMode } from '@/lib/agent/skillModel'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { uniqueLinks } from '@/lib/leads/lists/link'
import { FLOW, TOOLS } from '@/components/shell/nav'

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
  const sheets = useFileAttachments()
  /** Spreadsheets to their own chips (≤ 3), everything else to the image path (≤ 5, or its refusal). */
  const attachFiles = useCallback(
    (list: File[]) => {
      const { sheets: xs, others } = splitAttachments(list)
      if (xs.length) sheets.add(xs)
      if (others.length) images.add(others)
    },
    [sheets, images]
  )
  const attachments = { pending: images.pending || sheets.pending, any: images.refs.length + sheets.refs.length > 0 }
  const [dragging, setDragging] = useState(false)
  const [hello, setHello] = useState('Hello')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow the stream only while the owner is at the bottom: scrolling up to
  // read stops the auto-scroll, scrolling back down resumes it.
  const followRef = useRef(true)
  // Shows the jump-to-latest button once the owner has scrolled away from the bottom.
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const jumpToBottom = () => {
    const box = scrollRef.current
    if (!box) return
    followRef.current = true
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
  }
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

  /**
   * Send with the attached images. The chips leave the composer at once and
   * come back if the request fails; their previews are freed once it went
   * through. Returns false when nothing was sent.
   */
  const sendWith = useCallback(
    (text: string, skill?: SkillRef): boolean => {
      const refs = images.refs
      const fileRefs = sheets.refs
      const taken = refs.length ? images.take() : []
      const takenFiles = fileRefs.length ? sheets.take() : []
      const opts = { ...(refs.length ? { images: refs } : {}), ...(fileRefs.length ? { files: fileRefs } : {}) }
      const sent = send(text, skill, refs.length || fileRefs.length ? opts : undefined)
      if (taken.length) void sent.then((ok) => (ok ? images.release(taken) : images.restore(taken)))
      if (takenFiles.length) void sent.then((ok) => (ok ? undefined : sheets.restore(takenFiles)))
      return true
    },
    [send, images, sheets]
  )

  const submit = useCallback(
    (text: string, opts: { withImages?: boolean } = {}): boolean => {
      const withImages = opts.withImages !== false
      // Attachments still uploading hold the send; an attachment-only message is fine.
      if ((!text.trim() && !(withImages && attachments.any)) || busy || chat.loading || (withImages && attachments.pending)) return false
      setDraft('')
      if (!withImages) {
        void send(text)
        return true
      }
      // A skill attached as reference rides along with this one message.
      if (picked && attach === 'reference') {
        sendWith(text, { id: picked.id, name: picked.name, mode: 'reference' })
        clearSkill()
        return true
      }
      return sendWith(text)
    },
    [busy, chat.loading, send, sendWith, picked, attach, clearSkill, attachments.any, attachments.pending]
  )

  /** A finished voice transcript: sent when it can be, else kept in the draft (never dropped). */
  const onVoice = useCallback(
    (text: string) => {
      if (submit(text)) return
      setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
    },
    [submit]
  )

  const runSkill = useCallback(() => {
    if (!picked || busy || chat.loading || attachments.pending) return
    const extra = draft.trim()
    setDraft('')
    sendWith(`Run the skill "${picked.name}".${extra ? `\n\n${extra}` : ''}`, { id: picked.id, name: picked.name, mode: 'run' })
    clearSkill()
  }, [picked, busy, chat.loading, draft, sendWith, clearSkill, attachments.pending])

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
    // Phones: about 5 lines, then it scrolls; desktop about 8.
    el.style.height = `${Math.min(el.scrollHeight, phone ? COMPOSER_MAX_PHONE : 220)}px`
  }, [draft, phone])

  // Opening a chat lands at the bottom (the latest reply).
  const openedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = chat.conversationId ?? null
    if (chat.loading || !messages.length || openedRef.current === id) return
    openedRef.current = id
    const box = scrollRef.current
    if (!box) return
    box.scrollTop = box.scrollHeight
    followRef.current = true
  }, [chat.conversationId, chat.loading, messages.length])

  // Images, diagrams and tool cards render after the text and grow the list,
  // and the phone keyboard shrinks the box: stay pinned to the bottom through
  // both while following.
  const hasMessages = messages.length > 0
  useEffect(() => {
    const box = scrollRef.current
    const content = box?.firstElementChild
    if (!box || !content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followRef.current) box.scrollTop = box.scrollHeight
    })
    ro.observe(content)
    ro.observe(box)
    return () => ro.disconnect()
  }, [chat.conversationId, chat.loading, hasMessages])

  // Keep the newest message in view while it streams, unless the owner has
  // scrolled up. Sending a new message always follows again.
  const last = messages.at(-1)
  useEffect(() => {
    if (last?.role === 'user') followRef.current = true
    if (!followRef.current || openedRef.current !== (chat.conversationId ?? null)) return
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages.length, last?.role, last?.text, last?.tools.length, last?.approvals.length, chat.conversationId])

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
      {!collapsed && !phone && (
        <aside className="glass sticky top-[calc(var(--topbar-h)+1.25rem)] hidden h-[calc(100dvh-var(--topbar-h)-3.25rem)] w-64 shrink-0 overflow-hidden rounded-panel p-3 lg:block">
          {history}
        </aside>
      )}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="flex w-72 flex-col p-4 pt-12 max-sm:w-[86vw] max-sm:pt-[calc(env(safe-area-inset-top)+3rem)]">
          <SheetTitle className="sr-only">Chat history</SheetTitle>
          {phone && (
            // Phones: the app's tabs and this chat's options live here (the chat hides the app header and bottom bar).
            <div className="mb-3 flex shrink-0 flex-col gap-2.5 border-b border-line pb-3">
              <nav aria-label="App" className="grid grid-cols-3 gap-1">
                {[...FLOW, ...TOOLS].map((t) => {
                  const Icon = t.icon
                  return (
                    <Link
                      key={t.href}
                      href={t.href}
                      onClick={() => setSheetOpen(false)}
                      aria-current={t.href === '/agent' ? 'page' : undefined}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] text-fg-70 outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring',
                        t.href === '/agent' && 'bg-primary/15 text-fg'
                      )}
                    >
                      <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                      <span>
                        {t.step && <span aria-hidden className="mr-1 font-mono text-fg-46">{t.step}</span>}
                        {t.label}
                      </span>
                    </Link>
                  )
                })}
              </nav>
              <div className="flex flex-wrap items-center gap-1.5">
                {(projects.items?.length ?? 0) > 0 && (
                  <ProjectChip projects={projects.items ?? []} current={currentProject} disabled={busy} onPick={pickProject} onOpen={openProject} />
                )}
                <Button variant="ghost" size="sm" className="h-10" onClick={() => setMemoryOpen(true)} aria-label="Memory">
                  <Brain className="size-4" /> Memory
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn('h-10', chat.skipPermissions && 'bg-red/10 text-red hover:bg-red/15 hover:text-red')}
                  onClick={() => chat.setSkipPermissions(!chat.skipPermissions)}
                  aria-pressed={chat.skipPermissions}
                  aria-label="Skip permissions"
                >
                  <ShieldOff className="size-3.5" /> Skip permissions
                </Button>
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1">{history}</div>
        </SheetContent>
      </Sheet>

      <div
        className={cn(
          'relative min-w-0 flex-1',
          // Phones: the chat is the whole visual viewport (it shrinks with the keyboard):
          // slim header, messages, composer — nothing else.
          'max-sm:fixed max-sm:inset-x-0 max-sm:top-[var(--vvtop,0px)] max-sm:z-20 max-sm:flex max-sm:h-[var(--vvh,100dvh)] max-sm:flex-col max-sm:bg-background'
        )}
      >
        {phone && (
          <header role="banner" aria-label="Chat" className="box-content flex h-11 shrink-0 items-center gap-0.5 border-b border-line px-1 pt-[env(safe-area-inset-top)]">
            <Button variant="ghost" size="icon" className="size-10" onClick={() => setSheetOpen(true)} aria-label="Open menu">
              <Menu className="size-5" />
            </Button>
            <p className="min-w-0 flex-1 truncate px-1 text-center text-[15px] font-medium text-fg">{listed?.title || (messages.length ? 'Chat' : 'New chat')}</p>
            {hasPanel && (
              <Button variant="ghost" size="icon" className="size-10" onClick={() => setPanelOpen(true)} aria-label={`Show ${diagrams.length ? 'pipeline' : 'leads'}`}>
                <PanelRight className="size-5" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="size-10" onClick={newChat} disabled={busy} aria-label="New chat">
              <SquarePen className="size-5" />
            </Button>
          </header>
        )}
        {/* Desktop: the chat's controls float in the top row between the corner controls, so the
            conversation gets the full height (like the phone header). Phones use the slim header above. */}
        {!phone && (
        <div className="glass fixed top-4 left-1/2 z-30 flex h-11 max-w-[calc(100vw-24rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-2xl bg-(--bar-fill) px-1.5 shadow-(--bar-shadow) backdrop-blur-xl [scrollbar-width:none] max-sm:hidden">
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
        )}
        <AgentMemory open={memoryOpen} onOpenChange={setMemoryOpen} />
        {/* The conversation sits on its own dense glass panel so text stays readable over the wallpaper. */}
        {(() => {
          const column = (
        <div
          className={cn(
            // Fixed-height rounded panel: only the messages scroll (inside the clip), so the
            // corners stay rounded at any scroll position and nothing passes behind the composer.
            'glass-overlay flex w-full flex-col overflow-hidden rounded-panel',
            // Phones: no panel around the chat — edge to edge, it fills what the slim header leaves.
            'max-sm:min-h-0 max-sm:flex-1 max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:shadow-none max-sm:backdrop-blur-none',
            split && desktop ? 'split-chat-in h-full' : 'mx-auto max-w-[1200px] sm:h-[calc(100dvh-var(--topbar-h)-3.25rem)]'
          )}
        >
          <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget
              const gap = el.scrollHeight - el.scrollTop - el.clientHeight
              followRef.current = gap < 120
              const away = gap > 240
              setAwayFromBottom((a) => (a === away ? a : away))
            }}
            className="thin-scroll scroll-fade-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pt-3 sm:px-8 sm:pt-7"
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
              <ol className="flex flex-col gap-5 pt-1 pb-4 sm:gap-7 sm:pt-2 sm:pb-6" aria-label="Conversation">
                {messages.map((m) => (
                  <li key={m.id} className="min-w-0" data-role={m.role}>
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
          {awayFromBottom && !chat.loading && messages.length > 0 && (
            <button
              type="button"
              onClick={jumpToBottom}
              aria-label="Jump to latest message"
              className="absolute bottom-3 left-1/2 z-10 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-[var(--glass-fill-strong)] text-fg shadow-lg backdrop-blur hover:bg-surface"
            >
              <ArrowDown className="size-4" />
            </button>
          )}
          </div>

          <div className="shrink-0 border-t border-line bg-[var(--glass-fill-strong)] px-2.5 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:px-8 sm:pt-3 sm:pb-4">
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
            {!phone && (
            <div className="mb-2 flex items-center gap-2">
              <SkillMenu
                list={skills}
                disabled={busy}
                canSave={messages.length > 0 && !busy && !chat.loading}
                onPick={(s) => {
                  setPicked(s)
                  setAttach(null)
                }}
                onSave={() => submit(SAVE_SKILL_PROMPT, { withImages: false })}
                onManage={() => setManageOpen(true)}
              />
            </div>
            )}
            <ImageChips items={images.items} onRemove={images.remove} disabled={busy} />
            <FileChips items={sheets.items} onRemove={sheets.remove} disabled={busy} />
            <form
              className={cn(
                'glass flex items-end gap-2 rounded-2xl p-2 pl-4 transition-colors focus-within:border-primary/60 max-sm:gap-0.5 max-sm:rounded-[22px] max-sm:p-1.5 max-sm:pl-3',
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
                attachFiles(files)
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
                  // A copied .xlsx / .csv file attaches even when the paste also names it as text.
                  const copied = splitAttachments(filesFrom(e.clipboardData)).sheets
                  if (copied.length) {
                    e.preventDefault()
                    sheets.add(copied)
                    return
                  }
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
                className="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent py-2 focus-visible:outline-none! text-[15px] leading-6 text-fg outline-none placeholder:text-fg-24 disabled:opacity-60 max-sm:max-h-[136px] max-sm:text-[16px]"
              />
              {phone && (
                <SkillMenu
                  compact
                  list={skills}
                  disabled={busy}
                  canSave={messages.length > 0 && !busy && !chat.loading}
                  onPick={(s) => {
                    setPicked(s)
                    setAttach(null)
                  }}
                  onSave={() => submit(SAVE_SKILL_PROMPT, { withImages: false })}
                  onManage={() => setManageOpen(true)}
                />
              )}
              <AttachButton onFiles={attachFiles} disabled={busy} />
              <VoiceInput speech={speech} onFinal={onVoice} />
              <button
                type="submit"
                disabled={busy || attachments.pending || (!draft.trim() && !attachments.any)}
                aria-label="Send message"
                className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-[opacity,background-color] outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-35 dark:shadow-(--primary-glow)"
              >
                <ArrowUp className="size-4" />
              </button>
            </form>
            {(images.error || sheets.error) && (
              <p className="mt-2 text-center text-[12px] text-red" role="alert">
                {[images.error, sheets.error].filter(Boolean).join(' ')}
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
            <div className="h-[calc(100dvh-var(--topbar-h)-3.25rem)]">
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

/** The phone composer grows to about 5 lines (24 px each + padding), then scrolls. */
const COMPOSER_MAX_PHONE = 136

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
          {m.files && m.files.length > 0 && <MessageFileChips files={m.files} />}
          {m.text && <div className="rounded-2xl bg-white/8 px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-fg">{m.text}</div>}
        </div>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {m.tools.length > 0 && <ToolChips tools={m.tools} live={!!m.streaming} />}
      <ToolLinks tools={m.tools} />
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

/** "Open in Leads" for each lead list this message's tools created, showed or appended to. */
function ToolLinks({ tools }: { tools: ToolLogEntry[] }) {
  const links = uniqueLinks(tools)
  if (!links.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-fit')}>
          <Table2 className="size-3.5" /> {l.label}
        </Link>
      ))}
    </div>
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

