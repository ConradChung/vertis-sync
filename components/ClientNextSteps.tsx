'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'

// ── Coordinate offset: shifts canvas coords into positive screen space ──────
const XO = 2640
const YO = 420
const CW = 6200
const CH = 6200

// ── Types ───────────────────────────────────────────────────────────────────
interface ND { id:string; x:number; y:number; w:number; h:number; text:string; checkKey?:string; isLabel?:boolean; isNote?:boolean }
interface GD { id:string; x:number; y:number; w:number; h:number; label:string; color:string; border:string }
interface ED { id:string; fn:string; fs:string; tn:string; ts:string }

// ── Groups ──────────────────────────────────────────────────────────────────
const GROUPS: GD[] = [
  { id:'bd70641635686be3', x:-1560, y:-180, w:1530, h:840,  label:'Client Side',             color:'rgba(94,106,210,0.04)',  border:'rgba(94,106,210,0.15)'  },
  { id:'83c5e0a66ddcf15b', x:1360,  y:800,  w:1920, h:1600, label:'Admin Side',              color:'rgba(147,51,234,0.04)',  border:'rgba(147,51,234,0.15)'  },
  { id:'d64f4d3976d12601', x:-480,  y:2960, w:1020, h:860,  label:'Positive Reply Handling', color:'rgba(34,197,94,0.04)',   border:'rgba(34,197,94,0.15)'   },
  { id:'a37691b373788377', x:-2640, y:4080, w:1680, h:800,  label:'Reporting Layer',         color:'rgba(249,115,22,0.04)',  border:'rgba(249,115,22,0.15)'  },
]

// ── Nodes ───────────────────────────────────────────────────────────────────
const NODES: ND[] = [
  // Titles / labels (no checkbox)
  { id:'dcb370e5693db7db', x:-40,   y:-420, w:260, h:60,  text:'Prod Roadmap: Northstar CRM', isLabel:true },
  { id:'83427e1748b60c63', x:-600,  y:-160, w:260, h:60,  text:'Client Side',   isLabel:true },
  { id:'b9315490ff7e855a', x:1740,  y:820,  w:260, h:60,  text:'Admin Side',    isLabel:true },
  { id:'c63851140e5883bc', x:-2360, y:4100, w:260, h:60,  text:'Reporting',     isLabel:true },
  { id:'75575afb2c962406', x:-300,  y:2980, w:260, h:60,  text:'On Positive Reply', isLabel:true },
  // Client Side checklist nodes
  { id:'2f309696db4a5e16', x:-1120, y:-10,  w:260, h:60,  text:'Welcome Message',           checkKey:'client_side::welcome_message' },
  { id:'2a4d9163db3b377a', x:-750,  y:-10,  w:260, h:60,  text:'DocuSign Agreement',         checkKey:'client_side::docusign' },
  { id:'195e244d98045f56', x:-440,  y:-10,  w:260, h:60,  text:'Comm Channel',               checkKey:'client_side::comm_channel' },
  { id:'f05e7fa20df3046e', x:-600,  y:150,  w:260, h:60,  text:'Onboarding Form',            checkKey:'client_side::onboarding_form' },
  { id:'c65e38fe6aeb1b35', x:-920,  y:360,  w:260, h:60,  text:'Domain Generation',          checkKey:'client_side::domain_generation' },
  { id:'169ad3ef4180e4e9', x:-1440, y:360,  w:260, h:120, text:'Buy Mailboxes\n(Zapmail → Instantly warmup)', checkKey:'client_side::buy_mailboxes' },
  { id:'0f3392b6d78fc7f3', x:-600,  y:360,  w:260, h:60,  text:'Extraction Questions + Call', checkKey:'client_side::extraction_questions' },
  { id:'215fed9db5d02017', x:-310,  y:360,  w:260, h:60,  text:'ICP & Targeting Data',       checkKey:'client_side::icp_targeting' },
  { id:'a029ab43f7b57b4c', x:640,   y:360,  w:260, h:220, text:'Apollo URL Structure Creation', checkKey:'client_side::apollo_url_structure' },
  { id:'8327eafe9ef4fdef', x:-600,  y:580,  w:260, h:60,  text:'Voice Note Confirmation',    checkKey:'client_side::voice_note' },
  // Admin Side checklist nodes
  { id:'465074ad9113774d', x:1380,  y:1000, w:260, h:60,  text:'Lead List: LeadsFriday / Apollo', checkKey:'admin_side::lead_list' },
  { id:'b28a422e630a18f5', x:1380,  y:1190, w:260, h:60,  text:'Validator: Northstar Dash',  checkKey:'admin_side::validator' },
  { id:'6fbb1dca16f34122', x:1740,  y:1000, w:260, h:60,  text:'Market Research Agent',      checkKey:'admin_side::market_research_agent' },
  { id:'58471f0652eec536', x:2080,  y:1000, w:260, h:60,  text:'Onboarding Agent',           checkKey:'admin_side::onboarding_agent' },
  { id:'ecefb70d6ee25b82', x:1900,  y:1220, w:260, h:60,  text:'Ops Layer',                  checkKey:'admin_side::ops_layer' },
  { id:'43195011c3a00c86', x:1740,  y:1360, w:260, h:60,  text:'Copywriter: Northstar Dash', checkKey:'admin_side::copywriter' },
  { id:'8308000efa3bfcfc', x:2080,  y:1360, w:260, h:60,  text:'Clay Prompt Generator',      checkKey:'admin_side::clay_prompt_generator' },
  { id:'9e53fb06ebb09510', x:1900,  y:1560, w:260, h:60,  text:'Sequence Creator: Northstar Dash', checkKey:'admin_side::sequence_creator' },
  { id:'da0c9e9d2c7c4596', x:1900,  y:1720, w:260, h:60,  text:'Sequencer: Instantly',       checkKey:'admin_side::sequencer_instantly' },
  { id:'db8997ac2e102f23', x:2680,  y:1000, w:260, h:60,  text:'Report Generation',          checkKey:'admin_side::report_generation' },
  // Campaign
  { id:'b612fc0e7c17f752', x:-240,  y:2200, w:260, h:120, text:'Campaign\n+ Launch Notification', checkKey:'campaign::campaign_created' },
  { id:'6c9f6396561b44d0', x:-1170, y:2540, w:260, h:60,  text:'Outbound: Non-Connector',    checkKey:'campaign::outbound_non_connector' },
  { id:'e3719def9fcf8782', x:610,   y:2540, w:260, h:60,  text:'Outbound: Connector',        checkKey:'campaign::outbound_connector' },
  // Positive Reply
  { id:'7157ef0483a73e65', x:-460,  y:3140, w:260, h:60,  text:'Blueprint PDF CTA Reply',    checkKey:'positive_reply::blueprint_pdf_cta' },
  { id:'47fa999b515cd697', x:-460,  y:3320, w:260, h:60,  text:'Automated Agent (<5 min)',   checkKey:'positive_reply::automated_agent' },
  { id:'4c70571103e54a38', x:-140,  y:3140, w:260, h:60,  text:'More Info Reply' },
  { id:'a771cf96bcce35fd', x:-140,  y:3320, w:260, h:60,  text:'Send Testimonials',          checkKey:'positive_reply::send_testimonials' },
  { id:'0f22af02cc992285', x:190,   y:3140, w:260, h:60,  text:'Other' },
  { id:'299fcc8526af9f19', x:190,   y:3320, w:260, h:60,  text:'Personal Reply',             checkKey:'positive_reply::personal_reply' },
  // Reporting
  { id:'0b0c9f1ff28ae59d', x:-2620, y:4390, w:260, h:220, text:'Daily Notif Channel',        checkKey:'reporting::daily_notif_channel' },
  { id:'36a68c2a3b1fcfd2', x:-2120, y:4390, w:260, h:390, text:'Weekly Report',              checkKey:'reporting::weekly_report' },
  { id:'d1478aaf92712ddd', x:-1640, y:4390, w:260, h:220, text:'Cal.com Webhook',            checkKey:'reporting::calcom_webhook' },
  { id:'d62fba804bb5511c', x:-1640, y:4680, w:260, h:140, text:'Meeting Outcome Form',       checkKey:'reporting::meeting_outcome_form' },
  // Notes (info only)
  { id:'7c16f530bc363d7b', x:100,   y:-45,  w:260, h:130, text:'Cal.com: Create separate link showing available times for lead tracking.', isNote:true },
  { id:'eff33bec529b5342', x:2540,  y:1193, w:260, h:435, text:'Clay Prompts:\n- 3 service locations + 1 main city\n- Latest achievements signal\n- Latest LinkedIn post\n- Google Reviews count', isNote:true },
  { id:'389fe413c353db75', x:2550,  y:1720, w:260, h:600, text:'Instantly Settings:\n- Standard warmup\n- <50 words\n- Min 3-step sequence\n- 2/3 inboxes free\n- Max 30 emails/day\n- Prioritize reply rate\n- Unsubscribe handling', isNote:true },
]

// ── Edges ───────────────────────────────────────────────────────────────────
const EDGES: ED[] = [
  { id:'e1', fn:'b9315490ff7e855a', fs:'bottom', tn:'6fbb1dca16f34122', ts:'top'    },
  { id:'e2', fn:'b9315490ff7e855a', fs:'bottom', tn:'58471f0652eec536', ts:'top'    },
  { id:'e3', fn:'ecefb70d6ee25b82', fs:'bottom', tn:'43195011c3a00c86', ts:'top'    },
  { id:'e4', fn:'ecefb70d6ee25b82', fs:'bottom', tn:'8308000efa3bfcfc', ts:'top'    },
  { id:'e5', fn:'58471f0652eec536', fs:'bottom', tn:'ecefb70d6ee25b82', ts:'top'    },
  { id:'e6', fn:'6fbb1dca16f34122', fs:'bottom', tn:'ecefb70d6ee25b82', ts:'top'    },
  { id:'e7', fn:'465074ad9113774d', fs:'bottom', tn:'b28a422e630a18f5', ts:'top'    },
  { id:'e8', fn:'b28a422e630a18f5', fs:'right',  tn:'ecefb70d6ee25b82', ts:'left'   },
  { id:'e9', fn:'83427e1748b60c63', fs:'bottom', tn:'2a4d9163db3b377a', ts:'top'    },
  { id:'e10',fn:'2a4d9163db3b377a', fs:'bottom', tn:'f05e7fa20df3046e', ts:'top'    },
  { id:'e11',fn:'f05e7fa20df3046e', fs:'bottom', tn:'c65e38fe6aeb1b35', ts:'top'    },
  { id:'e12',fn:'83427e1748b60c63', fs:'bottom', tn:'195e244d98045f56', ts:'top'    },
  { id:'e13',fn:'195e244d98045f56', fs:'bottom', tn:'f05e7fa20df3046e', ts:'top'    },
  { id:'e14',fn:'f05e7fa20df3046e', fs:'bottom', tn:'0f3392b6d78fc7f3', ts:'top'    },
  { id:'e15',fn:'f05e7fa20df3046e', fs:'bottom', tn:'215fed9db5d02017', ts:'top'    },
  { id:'e16',fn:'215fed9db5d02017', fs:'bottom', tn:'8327eafe9ef4fdef', ts:'top'    },
  { id:'e17',fn:'0f3392b6d78fc7f3', fs:'bottom', tn:'8327eafe9ef4fdef', ts:'top'    },
  { id:'e18',fn:'c65e38fe6aeb1b35', fs:'bottom', tn:'8327eafe9ef4fdef', ts:'top'    },
  { id:'e19',fn:'b9315490ff7e855a', fs:'left',   tn:'465074ad9113774d', ts:'top'    },
  { id:'e20',fn:'43195011c3a00c86', fs:'bottom', tn:'9e53fb06ebb09510', ts:'top'    },
  { id:'e21',fn:'8308000efa3bfcfc', fs:'bottom', tn:'9e53fb06ebb09510', ts:'top'    },
  { id:'e22',fn:'9e53fb06ebb09510', fs:'bottom', tn:'da0c9e9d2c7c4596', ts:'top'    },
  { id:'e23',fn:'58471f0652eec536', fs:'right',  tn:'db8997ac2e102f23', ts:'left'   },
  { id:'e24',fn:'c63851140e5883bc', fs:'bottom', tn:'0b0c9f1ff28ae59d', ts:'top'    },
  { id:'e25',fn:'c63851140e5883bc', fs:'bottom', tn:'36a68c2a3b1fcfd2', ts:'top'    },
  { id:'e26',fn:'195e244d98045f56', fs:'right',  tn:'7c16f530bc363d7b', ts:'left'   },
  { id:'e27',fn:'75575afb2c962406', fs:'bottom', tn:'7157ef0483a73e65', ts:'top'    },
  { id:'e28',fn:'7157ef0483a73e65', fs:'bottom', tn:'47fa999b515cd697', ts:'top'    },
  { id:'e29',fn:'75575afb2c962406', fs:'bottom', tn:'4c70571103e54a38', ts:'top'    },
  { id:'e30',fn:'4c70571103e54a38', fs:'bottom', tn:'a771cf96bcce35fd', ts:'top'    },
  { id:'e31',fn:'75575afb2c962406', fs:'right',  tn:'0f22af02cc992285', ts:'top'    },
  { id:'e32',fn:'0f22af02cc992285', fs:'bottom', tn:'299fcc8526af9f19', ts:'top'    },
  { id:'e33',fn:'b612fc0e7c17f752', fs:'bottom', tn:'6c9f6396561b44d0', ts:'top'    },
  { id:'e34',fn:'da0c9e9d2c7c4596', fs:'bottom', tn:'b612fc0e7c17f752', ts:'top'    },
  { id:'e35',fn:'b612fc0e7c17f752', fs:'bottom', tn:'e3719def9fcf8782', ts:'top'    },
  { id:'e36',fn:'6c9f6396561b44d0', fs:'bottom', tn:'d64f4d3976d12601', ts:'top'    },
  { id:'e37',fn:'e3719def9fcf8782', fs:'bottom', tn:'d64f4d3976d12601', ts:'top'    },
  { id:'e38',fn:'d64f4d3976d12601', fs:'bottom', tn:'c63851140e5883bc', ts:'top'    },
  { id:'e39',fn:'c65e38fe6aeb1b35', fs:'left',   tn:'169ad3ef4180e4e9', ts:'right'  },
  { id:'e40',fn:'8308000efa3bfcfc', fs:'right',  tn:'eff33bec529b5342', ts:'left'   },
  { id:'e41',fn:'da0c9e9d2c7c4596', fs:'right',  tn:'389fe413c353db75', ts:'left'   },
  { id:'e42',fn:'8327eafe9ef4fdef', fs:'bottom', tn:'b9315490ff7e855a', ts:'top'    },
  { id:'e43',fn:'8327eafe9ef4fdef', fs:'bottom', tn:'c63851140e5883bc', ts:'top'    },
  { id:'e44',fn:'215fed9db5d02017', fs:'right',  tn:'a029ab43f7b57b4c', ts:'left'   },
  { id:'e45',fn:'a029ab43f7b57b4c', fs:'right',  tn:'465074ad9113774d', ts:'left'   },
  { id:'e46',fn:'83427e1748b60c63', fs:'left',   tn:'2f309696db4a5e16', ts:'top'    },
  { id:'e47',fn:'c63851140e5883bc', fs:'bottom', tn:'d1478aaf92712ddd', ts:'top'    },
  { id:'e48',fn:'d1478aaf92712ddd', fs:'bottom', tn:'d62fba804bb5511c', ts:'top'    },
]

// ── Build lookup map at module level (NODES + GROUPS for edge routing) ──────
const NODE_MAP = new Map<string, { x:number; y:number; w:number; h:number }>()
for (const n of NODES)  NODE_MAP.set(n.id, { x:n.x, y:n.y, w:n.w, h:n.h })
for (const g of GROUPS) NODE_MAP.set(g.id, { x:g.x, y:g.y, w:g.w, h:g.h })

// ── Edge path helpers ────────────────────────────────────────────────────────
function pt(node:{x:number;y:number;w:number;h:number}, side:string):[number,number] {
  const sx = node.x + XO, sy = node.y + YO
  if (side === 'top')    return [sx + node.w/2, sy]
  if (side === 'bottom') return [sx + node.w/2, sy + node.h]
  if (side === 'left')   return [sx,            sy + node.h/2]
  if (side === 'right')  return [sx + node.w,   sy + node.h/2]
  return [sx + node.w/2, sy + node.h/2]
}

function mkPath(n1:{x:number;y:number;w:number;h:number}, s1:string, n2:{x:number;y:number;w:number;h:number}, s2:string): string {
  const [x1,y1] = pt(n1,s1), [x2,y2] = pt(n2,s2)
  const dist = Math.hypot(x2-x1, y2-y1)
  const str  = Math.min(Math.max(dist * 0.35, 60), 380)
  let cx1=x1, cy1=y1, cx2=x2, cy2=y2
  if (s1==='bottom') cy1+=str; else if (s1==='top') cy1-=str
  else if (s1==='right') cx1+=str; else if (s1==='left') cx1-=str
  if (s2==='top') cy2-=str; else if (s2==='bottom') cy2+=str
  else if (s2==='left') cx2-=str; else if (s2==='right') cx2+=str
  return `M${x1},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`
}

const EDGE_PATHS = EDGES.map(e => {
  const n1 = NODE_MAP.get(e.fn), n2 = NODE_MAP.get(e.tn)
  if (!n1 || !n2) return null
  return { id: e.id, d: mkPath(n1, e.fs, n2, e.ts) }
}).filter(Boolean) as { id:string; d:string }[]

// ── Component ────────────────────────────────────────────────────────────────
interface Props { clientId:string; docusignUrl:string|null; onboardingStage:number; hasCampaign:boolean }

export default function ClientNextSteps({ clientId, docusignUrl, onboardingStage, hasCampaign }: Props) {
  const [checked, setChecked] = useState<Record<string,boolean>>({})
  const [loading, setLoading] = useState(true)
  const [scale, setScale]     = useState(0.17)
  const [pan, setPan]         = useState({ x: 20, y: 20 })
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging     = useRef(false)
  const dragStart    = useRef({ x:0, y:0 })
  const panStart     = useRef({ x:0, y:0 })
  const supabase     = createClient()

  const isAutoChecked = useCallback((checkKey: string): boolean => {
    if (checkKey === 'client_side::docusign')        return !!docusignUrl
    if (checkKey === 'client_side::onboarding_form') return onboardingStage >= 2
    if (checkKey === 'client_side::icp_targeting')   return onboardingStage >= 3
    if (checkKey === 'campaign::campaign_created')    return hasCampaign
    return false
  }, [docusignUrl, onboardingStage, hasCampaign])

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const { data } = await supabase
        .from('client_onboarding_checklist')
        .select('section, item_key, completed')
        .eq('client_id', clientId)
      const map: Record<string,boolean> = {}
      if (data) for (const row of data) map[`${row.section}::${row.item_key}`] = row.completed
      for (const n of NODES) {
        if (n.checkKey && !(n.checkKey in map)) map[n.checkKey] = isAutoChecked(n.checkKey)
      }
      setChecked(map)
      setLoading(false)
    }
    load()
  }, [clientId, isAutoChecked])

  const toggle = async (n: ND) => {
    if (!n.checkKey) return
    const [section, item_key] = n.checkKey.split('::')
    const newVal = !checked[n.checkKey]
    setChecked(prev => ({ ...prev, [n.checkKey!]: newVal }))
    await supabase.from('client_onboarding_checklist').upsert({
      client_id: clientId, section, item_key,
      completed: newVal,
      completed_at: newVal ? new Date().toISOString() : null,
    }, { onConflict: 'client_id,section,item_key' })
  }

  // ── Pan handlers ────────────────────────────────────────────────────────
  const onContainerMouseDown = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-node]')) return
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current  = { ...pan }
    e.preventDefault()
  }

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return
      setPan({
        x: panStart.current.x + (e.clientX - dragStart.current.x),
        y: panStart.current.y + (e.clientY - dragStart.current.y),
      })
    }
    const up = () => { dragging.current = false }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [])

  // Native (non-passive) wheel listener so preventDefault actually works
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.92 : 1.08
      setScale(s => Math.max(0.05, Math.min(3, s * factor)))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const fitToView = () => {
    const el = containerRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const s = Math.min(width / CW, height / CH) * 0.88
    setScale(s)
    setPan({ x: (width - CW * s) / 2, y: (height - CH * s) / 2 })
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <p className="text-[13px] text-[#4A4A4A]">Loading canvas...</p>
    </div>
  )

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-[#0A0A0A]"
      style={{ cursor: 'grab' }}
      onMouseDown={onContainerMouseDown}
    >
      {/* Controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        {[
          { icon: <ZoomIn size={13} />,  action: () => setScale(s => Math.min(3, s * 1.2)) },
          { icon: <ZoomOut size={13} />, action: () => setScale(s => Math.max(0.05, s * 0.83)) },
          { icon: <Maximize2 size={11} />, action: fitToView },
        ].map((btn, i) => (
          <button key={i} onMouseDown={e => e.stopPropagation()} onClick={btn.action}
            className="w-7 h-7 bg-[#111111] border border-[#1E1E1E] rounded-lg flex items-center justify-center text-[#555] hover:text-white hover:border-[#3A3A3A] transition-colors">
            {btn.icon}
          </button>
        ))}
      </div>
      <div className="absolute bottom-3 right-3 z-10 text-[10px] text-[#333] tabular-nums select-none">
        {Math.round(scale * 100)}%
      </div>

      {/* Canvas */}
      <div style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${scale})`, transformOrigin: '0 0', width: CW, height: CH, position: 'relative' }}>

        {/* Dot grid */}
        <svg style={{ position:'absolute', inset:0, width:CW, height:CH, pointerEvents:'none' }}>
          <defs>
            <pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">
              <circle cx="40" cy="40" r="0.7" fill="#1A1A1A" />
            </pattern>
            <marker id="arr" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#333" />
            </marker>
          </defs>
          <rect width={CW} height={CH} fill="url(#dots)" />
          {EDGE_PATHS.map(ep => (
            <path key={ep.id} d={ep.d} stroke="#282828" strokeWidth="1.5" fill="none" markerEnd="url(#arr)" />
          ))}
        </svg>

        {/* Groups */}
        {GROUPS.map(g => (
          <div key={g.id} style={{
            position: 'absolute',
            left: g.x + XO, top: g.y + YO,
            width: g.w, height: g.h,
            background: g.color,
            border: `1px solid ${g.border}`,
            borderRadius: 16,
            pointerEvents: 'none',
          }}>
            <span style={{
              position: 'absolute', top: 10, left: 14,
              fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: g.border,
            }}>{g.label}</span>
          </div>
        ))}

        {/* Nodes */}
        {NODES.map(n => {
          const isChecked = n.checkKey ? !!checked[n.checkKey] : false
          const isAuto    = n.checkKey ? isAutoChecked(n.checkKey) : false

          // Section label
          if (n.isLabel) return (
            <div key={n.id} data-node="true" style={{
              position: 'absolute', left: n.x+XO, top: n.y+YO,
              width: n.w, height: n.h,
              display: 'flex', alignItems: 'center',
              pointerEvents: 'none',
            }}>
              <span style={{
                fontSize: 13, fontWeight: 700,
                color: n.id === 'dcb370e5693db7db' ? '#5E6AD2' : 'rgba(255,255,255,0.4)',
                letterSpacing: n.id === 'dcb370e5693db7db' ? '-0.01em' : '0',
              }}>{n.text}</span>
            </div>
          )

          // Note
          if (n.isNote) return (
            <div key={n.id} data-node="true" style={{
              position: 'absolute', left: n.x+XO, top: n.y+YO,
              width: n.w, minHeight: n.h,
              background: 'rgba(255,255,255,0.015)',
              border: '1px solid rgba(255,255,255,0.05)',
              borderRadius: 10, padding: '10px 12px',
              pointerEvents: 'none',
            }}>
              <p style={{ fontSize: 11, lineHeight: 1.65, color: 'rgba(255,255,255,0.18)', whiteSpace: 'pre-line' }}>{n.text}</p>
            </div>
          )

          // Checklist node
          return (
            <button key={n.id} data-node="true" onClick={() => toggle(n)}
              style={{
                position: 'absolute', left: n.x+XO, top: n.y+YO,
                width: n.w, minHeight: n.h,
                background: isChecked ? 'rgba(94,106,210,0.07)' : '#0F0F0F',
                border: `1px solid ${isChecked ? 'rgba(94,106,210,0.28)' : '#1E1E1E'}`,
                borderRadius: 10, padding: '9px 11px',
                display: 'flex', alignItems: 'flex-start', gap: 9,
                cursor: n.checkKey ? 'pointer' : 'default',
                textAlign: 'left',
                transition: 'border-color 0.12s, background 0.12s',
              }}
            >
              {n.checkKey && (
                <div style={{
                  width: 13, height: 13, borderRadius: 3, flexShrink: 0, marginTop: 1,
                  background: isChecked ? '#5E6AD2' : 'transparent',
                  border: `1.5px solid ${isChecked ? '#5E6AD2' : '#333'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.12s, border-color 0.12s',
                }}>
                  {isChecked && (
                    <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                      <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
              )}
              <span style={{
                fontSize: 12, lineHeight: 1.45,
                color: isChecked ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.72)',
                whiteSpace: 'pre-line', flex: 1,
                textDecoration: isChecked ? 'line-through' : 'none',
              }}>{n.text}</span>
              {isAuto && isChecked && (
                <span style={{ fontSize: 9, color: '#5E6AD2', flexShrink: 0, marginTop: 2 }}>auto</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
