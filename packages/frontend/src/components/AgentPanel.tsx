'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Agent {
  id: string
  name: string
  type: string
  monthly_limit: string
  per_tx_limit: string
  allowed_assets: string[]
  recipient_address: string | null
  api_key: string
  status: string
  created_at: string
}

interface Purchase {
  id: string
  description: string
  amount: number
  asset: string
  date: string
  status: 'completed' | 'pending' | 'failed'
  tx_hash: string
}

interface DemoAgent {
  id: string
  name: string
  service: string
  type: string
  allocation: number
  balance: number
  asset: string
  next_payment: string
  status: string
  address: string
  purchases: Purchase[]
}

const DEMO_AGENTS_INITIAL: DemoAgent[] = [
  {
    id: 'demo-vpn',
    name: 'VPN',
    service: 'Mullvad VPN',
    type: 'vpn_payment',
    allocation: 5,
    balance: 5.0,
    asset: 'USDC',
    next_payment: '1 maj',
    status: 'active',
    address: '0x3f4B…2a1C',
    purchases: [
      { id: 'p1', description: 'Mullvad VPN — månadsabonnemang', amount: 5.0, asset: 'USDC', date: '1 apr 2026', status: 'completed', tx_hash: '0xab12…f3e1' },
      { id: 'p2', description: 'Mullvad VPN — månadsabonnemang', amount: 5.0, asset: 'USDC', date: '1 mar 2026', status: 'completed', tx_hash: '0xcd34…a7b2' },
      { id: 'p3', description: 'Mullvad VPN — månadsabonnemang', amount: 5.0, asset: 'USDC', date: '1 feb 2026', status: 'completed', tx_hash: '0xef56…c9d3' },
    ],
  },
  {
    id: 'demo-aws',
    name: 'Amazon AWS',
    service: 'Cloud compute',
    type: 'cloud',
    allocation: 50,
    balance: 23.4,
    asset: 'USDC',
    next_payment: '1 maj',
    status: 'active',
    address: '0x8c2A…9f7D',
    purchases: [
      { id: 'p4', description: 'EC2 compute — us-east-1', amount: 18.72, asset: 'USDC', date: '28 mar 2026', status: 'completed', tx_hash: '0x1a2b…e4f5' },
      { id: 'p5', description: 'S3 storage — 120 GB', amount: 2.76, asset: 'USDC', date: '28 mar 2026', status: 'completed', tx_hash: '0x3c4d…b6a7' },
      { id: 'p6', description: 'Lambda — 4.2M anrop', amount: 5.12, asset: 'USDC', date: '28 mar 2026', status: 'completed', tx_hash: '0x5e6f…d8c9' },
      { id: 'p7', description: 'EC2 compute — us-east-1', amount: 19.40, asset: 'USDC', date: '28 feb 2026', status: 'completed', tx_hash: '0x7g8h…f0e1' },
    ],
  },
  {
    id: 'demo-gym',
    name: 'Sats Gym',
    service: 'Medlemskap',
    type: 'gym',
    allocation: 35,
    balance: 35.0,
    asset: 'USDC',
    next_payment: '3 maj',
    status: 'active',
    address: '0x1d9E…4b8F',
    purchases: [
      { id: 'p9', description: 'Sats Gym — månadsmedlemskap', amount: 35.0, asset: 'USDC', date: '3 apr 2026', status: 'completed', tx_hash: '0xb1c2…h4i5' },
      { id: 'p10', description: 'Sats Gym — månadsmedlemskap', amount: 35.0, asset: 'USDC', date: '3 mar 2026', status: 'completed', tx_hash: '0xd3e4…j6k7' },
      { id: 'p11', description: 'Sats Gym — månadsmedlemskap', amount: 35.0, asset: 'USDC', date: '3 feb 2026', status: 'completed', tx_hash: '0xf5g6…l8m9' },
    ],
  },
]

const DEFAULT_FORM = { name: '', type: 'custom', monthly_limit: 10, per_tx_limit: 10, allowed_assets: ['USDC'], recipient_address: '' }

// ── Icons ──────────────────────────────────────────────────────────────────

function ShieldIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
}
function CloudIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>
}
function GymIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 6.5h11M6.5 17.5h11M3 12h18M6 3v18M18 3v18" /></svg>
}
function BotIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" /></svg>
}
function XIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
}
function ChevronRight() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
}
function PencilIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
}
function TrashIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>
}

function typeIcon(type: string, size = 15) {
  if (type === 'vpn_payment') return <ShieldIcon size={size} />
  if (type === 'cloud') return <CloudIcon size={size} />
  if (type === 'gym') return <GymIcon size={size} />
  return <BotIcon size={size} />
}

// ── Shared UI ──────────────────────────────────────────────────────────────

function BalanceBar({ balance, allocation }: { balance: number; allocation: number }) {
  const pct = allocation > 0 ? Math.min((balance / allocation) * 100, 100) : 0
  const color = pct > 60 ? 'from-indigo-500 to-violet-500' : pct > 25 ? 'from-amber-500 to-orange-500' : 'from-red-500 to-rose-500'
  return (
    <div className="w-full h-[3px] bg-white/[0.05] rounded-full overflow-hidden">
      <div className={`h-full rounded-full bg-gradient-to-r ${color} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function EditModal({
  title,
  initial,
  onSave,
  onClose,
}: {
  title: string
  initial: { name: string; allocation: number; per_tx: number; address: string }
  onSave: (v: typeof initial) => Promise<void>
  onClose: () => void
}) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(form)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fel vid sparning')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0e0e0e] border border-white/[0.08] rounded-2xl p-8 max-w-md w-full shadow-2xl">
        <div className="flex items-center justify-between mb-7">
          <div>
            <h3 className="text-sm font-semibold mb-0.5">Redigera agent</h3>
            <p className="text-xs text-zinc-600">{title}</p>
          </div>
          <button onClick={onClose} className="text-zinc-700 hover:text-zinc-400 transition-colors"><XIcon /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Namn</label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Månadsallokering</label>
              <div className="relative">
                <input
                  type="number" min="0.01" step="0.01"
                  value={form.allocation}
                  onChange={(e) => setForm((f) => ({ ...f, allocation: Number(e.target.value) }))}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 pr-14 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
                  required
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-600">USDC</span>
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Max per tx</label>
              <div className="relative">
                <input
                  type="number" min="0.01" step="0.01"
                  value={form.per_tx}
                  onChange={(e) => setForm((f) => ({ ...f, per_tx: Number(e.target.value) }))}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 pr-14 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
                  required
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-600">USDC</span>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Mottagaradress <span className="normal-case text-zinc-700">(valfri)</span></label>
            <input
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
              placeholder="0x…"
            />
          </div>
          {error && <div className="text-xs text-red-400 bg-red-500/5 border border-red-500/10 rounded-lg px-3 py-2">⚠ {error}</div>}
          <button type="submit" disabled={saving} className="w-full text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-xl py-2.5 transition-colors">
            {saving ? 'Sparar…' : 'Spara ändringar'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Agent drawer ───────────────────────────────────────────────────────────

function AgentDrawer({
  agent,
  onClose,
  onDelete,
  onAllocationChange,
  onShutdown,
}: {
  agent: DemoAgent
  onClose: () => void
  onDelete: () => void
  onAllocationChange: (allocation: number) => void
  onShutdown: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmShutdown, setConfirmShutdown] = useState(false)
  const [editingAlloc, setEditingAlloc] = useState(false)
  const [newAlloc, setNewAlloc] = useState(agent.allocation)
  const pct = agent.allocation > 0 ? (agent.balance / agent.allocation) * 100 : 0
  const isActive = agent.status === 'active'

  function saveAllocation() {
    if (newAlloc > 0) onAllocationChange(newAlloc)
    setEditingAlloc(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[#0c0c0c] border-l border-white/[0.07] h-full flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${isActive ? 'bg-indigo-500/10 text-indigo-400' : 'bg-white/[0.04] text-zinc-600'}`}>
              {typeIcon(agent.type, 17)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">{agent.name}</h2>
                {!isActive && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-500 font-mono">pausad</span>
                )}
              </div>
              <p className="text-[11px] text-zinc-600">{agent.service}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-zinc-500">Ta bort?</span>
                <button onClick={onDelete} className="text-[11px] text-red-400 hover:text-red-300 font-medium transition-colors">Ja</button>
                <button onClick={() => setConfirmDelete(false)} className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors">Nej</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="text-zinc-700 hover:text-red-400 transition-colors" title="Ta bort"><TrashIcon /></button>
            )}
            <button onClick={onClose} className="text-zinc-700 hover:text-zinc-400 transition-colors"><XIcon /></button>
          </div>
        </div>

        {/* Info + balance card */}
        <div className="px-6 py-5 border-b border-white/[0.05]">
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Adress</p>
              <p className="text-xs font-mono text-zinc-400">{agent.address}</p>
            </div>
            <div>
              <p className="text-[10px] text-zinc-700 uppercase tracking-wide mb-1">Nästa betalning</p>
              <p className="text-xs text-zinc-400">{agent.next_payment}</p>
            </div>
          </div>
          <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.05]">
            <div className="flex items-end justify-between mb-3">
              <div>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-1">Balans</p>
                <p className="text-2xl font-semibold tracking-tight">
                  {agent.balance.toFixed(2)}<span className="text-sm text-zinc-500 ml-1.5">{agent.asset}</span>
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-1">Allokering / mån</p>
                {editingAlloc ? (
                  <div className="flex items-center gap-2 justify-end">
                    <div className="relative">
                      <input
                        type="number" min="0.01" step="0.01"
                        value={newAlloc}
                        onChange={(e) => setNewAlloc(Number(e.target.value))}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveAllocation(); if (e.key === 'Escape') setEditingAlloc(false) }}
                        className="w-24 bg-white/[0.06] border border-indigo-500/40 rounded-lg px-2 py-1 text-sm text-zinc-200 focus:outline-none text-right pr-10"
                        autoFocus
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-zinc-600">USDC</span>
                    </div>
                    <button onClick={saveAllocation} className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium transition-colors">Spara</button>
                    <button onClick={() => setEditingAlloc(false)} className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors">✕</button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setNewAlloc(agent.allocation); setEditingAlloc(true) }}
                    className="group flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    {agent.allocation} {agent.asset}
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity"><PencilIcon /></span>
                  </button>
                )}
              </div>
            </div>
            <BalanceBar balance={agent.balance} allocation={agent.allocation} />
            <p className="text-[11px] text-zinc-700 mt-1.5">{pct.toFixed(0)}% kvar av månadsbudget</p>
          </div>
        </div>

        {/* Purchase history */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-3">Köp &amp; betalningar</p>
          <div className="space-y-1">
            {agent.purchases.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-3 border-b border-white/[0.04] last:border-0">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-300 truncate">{p.description}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-zinc-600">{p.date}</span>
                    <span className="text-[10px] font-mono text-zinc-700">{p.tx_hash}</span>
                  </div>
                </div>
                <div className="shrink-0 ml-4 text-right">
                  <p className="text-xs font-mono text-zinc-300">−{p.amount.toFixed(2)}</p>
                  <p className="text-[10px] text-zinc-600">{p.asset}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer — shutdown */}
        <div className="px-6 py-4 border-t border-white/[0.05]">
          {confirmShutdown ? (
            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-500">{isActive ? 'Pausa agenten?' : 'Återaktivera agenten?'}</p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { onShutdown(); setConfirmShutdown(false) }}
                  className="text-xs text-amber-400 hover:text-amber-300 font-medium transition-colors"
                >
                  Ja, {isActive ? 'pausa' : 'aktivera'}
                </button>
                <button onClick={() => setConfirmShutdown(false)} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">Avbryt</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmShutdown(true)}
              className={`w-full text-xs transition-colors py-1 text-center ${isActive ? 'text-zinc-600 hover:text-amber-400' : 'text-zinc-600 hover:text-emerald-400'}`}
            >
              {isActive ? 'Pausa agent' : 'Återaktivera agent'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Demo agent card ────────────────────────────────────────────────────────

function DemoAgentCard({
  agent,
  onClick,
  onEdit,
  onDelete,
}: {
  agent: DemoAgent
  onClick: () => void
  onEdit: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const pct = agent.allocation > 0 ? (agent.balance / agent.allocation) * 100 : 0
  const isActive = agent.status === 'active'

  return (
    <div className={`rounded-xl border p-4 transition-all group ${isActive ? 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.035] hover:border-white/[0.12]' : 'border-white/[0.04] bg-white/[0.01] opacity-60'}`}>
      <div className="flex items-start justify-between mb-3">
        <button onClick={onClick} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isActive ? 'bg-indigo-500/10 text-indigo-400' : 'bg-white/[0.04] text-zinc-600'}`}>
            {typeIcon(agent.type)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-200">{agent.name}</span>
              {isActive ? (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-mono">
                  <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse inline-block" />aktiv
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-500 font-mono">pausad</span>
              )}
            </div>
            <p className="text-[11px] text-zinc-600 mt-0.5 font-mono">{agent.address}</p>
          </div>
        </button>

        <div className="flex items-center gap-3 shrink-0 ml-2">
          <div className="text-right">
            <p className="text-sm font-mono text-zinc-200">{agent.balance.toFixed(2)}</p>
            <p className="text-[10px] text-zinc-600">{agent.asset} kvar</p>
          </div>
          <div className="flex flex-col gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={onEdit} className="text-zinc-600 hover:text-zinc-300 transition-colors" title="Redigera"><PencilIcon /></button>
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(e) }}
                  className="text-[10px] text-red-400 hover:text-red-300 font-medium"
                >Ja</button>
                <span className="text-zinc-700">/</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false) }}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400"
                >Nej</button>
              </div>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(true) }}
                className="text-zinc-700 hover:text-red-400 transition-colors"
                title="Ta bort"
              ><TrashIcon /></button>
            )}
          </div>
          <button onClick={onClick} className="text-zinc-700 group-hover:text-zinc-500 transition-colors">
            <ChevronRight />
          </button>
        </div>
      </div>

      <BalanceBar balance={agent.balance} allocation={agent.allocation} />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] text-zinc-700">{pct.toFixed(0)}% av {agent.allocation} {agent.asset}/mån</span>
        <span className="text-[11px] text-zinc-700">Nästa: {agent.next_payment}</span>
      </div>
    </div>
  )
}

// ── Real agent card ────────────────────────────────────────────────────────

function RealAgentCard({
  agent,
  onEdit,
  onDelete,
}: {
  agent: Agent
  onEdit: () => void
  onDelete: (id: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const limit = Number(agent.monthly_limit)
  const asset = agent.allowed_assets[0] ?? 'USDC'
  const isActive = agent.status === 'active'
  const addr = agent.recipient_address
    ? `${agent.recipient_address.slice(0, 6)}…${agent.recipient_address.slice(-4)}`
    : 'Ingen adress satt'

  return (
    <div className={`rounded-xl border p-4 transition-colors group ${
      isActive ? 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.035]' : 'border-white/[0.04] bg-white/[0.01] opacity-50'
    }`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isActive ? 'bg-indigo-500/10 text-indigo-400' : 'bg-white/[0.04] text-zinc-600'}`}>
            {typeIcon(agent.type)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-200">{agent.name}</span>
              <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-mono ${isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-600'}`}>
                {isActive && <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse inline-block" />}
                {isActive ? 'aktiv' : 'inaktiv'}
              </span>
            </div>
            <p className="text-[11px] text-zinc-600 mt-0.5 font-mono">{addr}</p>
          </div>
        </div>
        <div className="flex items-start gap-3 shrink-0">
          <div className="text-right">
            <p className="text-sm font-mono text-zinc-200">{limit.toFixed(2)}</p>
            <p className="text-[10px] text-zinc-600">{asset}/mån</p>
          </div>
          <div className="flex flex-col gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {isActive && (
              <button onClick={onEdit} className="text-zinc-600 hover:text-zinc-300 transition-colors" title="Redigera"><PencilIcon /></button>
            )}
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <button onClick={() => onDelete(agent.id)} className="text-[10px] text-red-400 hover:text-red-300 font-medium">Ja</button>
                <span className="text-zinc-700">/</span>
                <button onClick={() => setConfirmDelete(false)} className="text-[10px] text-zinc-600 hover:text-zinc-400">Nej</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="text-zinc-700 hover:text-red-400 transition-colors" title="Ta bort"><TrashIcon /></button>
            )}
          </div>
        </div>
      </div>
      <BalanceBar balance={limit} allocation={limit} />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] text-zinc-700">Månadsallokering</span>
        <span className="text-[11px] text-zinc-700">{limit.toFixed(2)} {asset}</span>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function AgentPanel() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [demoAgents, setDemoAgents] = useState<DemoAgent[]>(DEMO_AGENTS_INITIAL)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [revealKey, setRevealKey] = useState<string | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)
  const [selectedDemo, setSelectedDemo] = useState<DemoAgent | null>(null)
  const [editingDemo, setEditingDemo] = useState<DemoAgent | null>(null)
  const [editingReal, setEditingReal] = useState<Agent | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ agents: Agent[] }>('/agents')
      .then((d) => { if (!cancelled) setAgents(d.agents) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // ── Create ────────────────────────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      const agent = await api.post<Agent>('/agents', {
        name: form.name, type: form.type,
        monthly_limit: form.monthly_limit, per_tx_limit: form.per_tx_limit,
        allowed_assets: form.allowed_assets,
        recipient_address: form.recipient_address || undefined,
      })
      setAgents((prev) => [agent, ...prev])
      setShowCreate(false)
      setRevealKey(agent.api_key)
      setForm(DEFAULT_FORM)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Kunde inte skapa agent')
    } finally {
      setCreating(false)
    }
  }

  // ── Edit ──────────────────────────────────────────────────────────────────

  async function handleEditDemo(values: { name: string; allocation: number; per_tx: number; address: string }) {
    if (!editingDemo) return
    setDemoAgents((prev) => prev.map((a) =>
      a.id === editingDemo.id
        ? { ...a, name: values.name, allocation: values.allocation, address: values.address || a.address }
        : a,
    ))
    if (selectedDemo?.id === editingDemo.id) {
      setSelectedDemo((prev) => prev ? { ...prev, name: values.name, allocation: values.allocation } : null)
    }
  }

  async function handleEditReal(values: { name: string; allocation: number; per_tx: number; address: string }) {
    if (!editingReal) return
    const updated = await api.put<Agent>(`/agents/${editingReal.id}`, {
      name: values.name,
      monthly_limit: values.allocation,
      per_tx_limit: values.per_tx,
      recipient_address: values.address || null,
    })
    setAgents((prev) => prev.map((a) => (a.id === editingReal.id ? updated : a)))
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  function handleDeleteDemo(id: string) {
    setDemoAgents((prev) => prev.filter((a) => a.id !== id))
    if (selectedDemo?.id === id) setSelectedDemo(null)
  }

  function handleShutdownDemo(id: string) {
    setDemoAgents((prev) => prev.map((a) =>
      a.id === id ? { ...a, status: a.status === 'active' ? 'paused' : 'active' } : a,
    ))
    setSelectedDemo((prev) =>
      prev?.id === id ? { ...prev, status: prev.status === 'active' ? 'paused' : 'active' } : prev,
    )
  }

  function handleAllocationChangeDemo(id: string, allocation: number) {
    setDemoAgents((prev) => prev.map((a) => (a.id === id ? { ...a, allocation } : a)))
    setSelectedDemo((prev) => (prev?.id === id ? { ...prev, allocation } : prev))
  }

  async function handleDeleteReal(id: string) {
    await api.delete(`/agents/${id}`)
    setAgents((prev) => prev.filter((a) => a.id !== id))
  }

  function copyKey() {
    if (!revealKey) return
    navigator.clipboard.writeText(revealKey)
    setKeyCopied(true)
    setTimeout(() => setKeyCopied(false), 2000)
  }

  return (
    <>
      {/* Demo agent drawer */}
      {selectedDemo && (
        <AgentDrawer
          agent={selectedDemo}
          onClose={() => setSelectedDemo(null)}
          onDelete={() => { handleDeleteDemo(selectedDemo.id) }}
          onAllocationChange={(allocation) => handleAllocationChangeDemo(selectedDemo.id, allocation)}
          onShutdown={() => handleShutdownDemo(selectedDemo.id)}
        />
      )}

      {/* Edit demo modal */}
      {editingDemo && (
        <EditModal
          title={editingDemo.service}
          initial={{ name: editingDemo.name, allocation: editingDemo.allocation, per_tx: editingDemo.allocation, address: '' }}
          onSave={handleEditDemo}
          onClose={() => setEditingDemo(null)}
        />
      )}

      {/* Edit real modal */}
      {editingReal && (
        <EditModal
          title={editingReal.name}
          initial={{
            name: editingReal.name,
            allocation: Number(editingReal.monthly_limit),
            per_tx: Number(editingReal.per_tx_limit),
            address: editingReal.recipient_address ?? '',
          }}
          onSave={handleEditReal}
          onClose={() => setEditingReal(null)}
        />
      )}

      {/* API key modal */}
      {revealKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-[#0e0e0e] border border-white/[0.08] rounded-2xl p-8 max-w-md w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Agent skapad</h3>
                <p className="text-xs text-zinc-600">Kopiera nyckeln — visas bara en gång</p>
              </div>
            </div>
            <div onClick={copyKey} className="group relative bg-black rounded-xl p-4 font-mono text-xs text-emerald-400 break-all mb-2 cursor-pointer border border-white/[0.05] hover:border-white/[0.12] transition-colors select-all">
              {revealKey}
              <span className="absolute top-2 right-2 text-[10px] text-zinc-700 group-hover:text-zinc-500 transition-colors">
                {keyCopied ? '✓ Kopierad' : 'Klicka för att kopiera'}
              </span>
            </div>
            <p className="text-[10px] text-zinc-700 mb-6">Spara nyckeln säkert. Den kan inte visas igen.</p>
            <button onClick={() => { setRevealKey(null); setKeyCopied(false) }} className="w-full text-sm font-medium bg-white/[0.06] hover:bg-white/[0.10] text-zinc-200 rounded-xl py-2.5 transition-colors">
              Klar
            </button>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-[#0e0e0e] border border-white/[0.08] rounded-2xl p-8 max-w-md w-full shadow-2xl">
            <div className="flex items-center justify-between mb-7">
              <div>
                <h3 className="text-sm font-semibold mb-0.5">Ny agent</h3>
                <p className="text-xs text-zinc-600">Tilldela månadsallokering från din wallet</p>
              </div>
              <button onClick={() => setShowCreate(false)} className="text-zinc-700 hover:text-zinc-400 transition-colors"><XIcon /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-5">
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Namn</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
                  placeholder="t.ex. VPN, AWS, Gym…"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Månadsallokering</label>
                  <div className="relative">
                    <input type="number" min="0.01" step="0.01" value={form.monthly_limit}
                      onChange={(e) => setForm((f) => ({ ...f, monthly_limit: Number(e.target.value), per_tx_limit: Number(e.target.value) }))}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 pr-14 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all" required />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-600">USDC</span>
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Max per tx</label>
                  <div className="relative">
                    <input type="number" min="0.01" step="0.01" value={form.per_tx_limit}
                      onChange={(e) => setForm((f) => ({ ...f, per_tx_limit: Number(e.target.value) }))}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 pr-14 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all" required />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-600">USDC</span>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wide">Mottagaradress <span className="normal-case text-zinc-700">(valfri)</span></label>
                <input value={form.recipient_address}
                  onChange={(e) => setForm((f) => ({ ...f, recipient_address: e.target.value }))}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.06] transition-all"
                  placeholder="0x…" />
              </div>
              {createError && <div className="text-xs text-red-400 bg-red-500/5 border border-red-500/10 rounded-lg px-3 py-2">⚠ {createError}</div>}
              <button type="submit" disabled={creating} className="w-full text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-xl py-2.5 transition-colors">
                {creating ? 'Skapar…' : 'Skapa agent'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center gap-2 py-10 justify-center">
          <div className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse" />
          <span className="text-xs text-zinc-700">Laddar…</span>
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => (
            <RealAgentCard
              key={agent.id}
              agent={agent}
              onEdit={() => setEditingReal(agent)}
              onDelete={handleDeleteReal}
            />
          ))}
          {demoAgents.map((agent) => (
            <DemoAgentCard
              key={agent.id}
              agent={agent}
              onClick={() => setSelectedDemo(agent)}
              onEdit={(e) => { e.stopPropagation(); setEditingDemo(agent) }}
              onDelete={(e) => { e.stopPropagation(); handleDeleteDemo(agent.id) }}
            />
          ))}
          <button
            onClick={() => setShowCreate(true)}
            className="w-full text-xs text-zinc-700 hover:text-zinc-400 border border-dashed border-white/[0.06] hover:border-white/[0.12] rounded-xl py-3 transition-all"
          >
            + Ny agent
          </button>
        </div>
      )}
    </>
  )
}
