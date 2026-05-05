'use client'

import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'

type Step = {
  step: string
  title: string
  body: string
  visual: 'account' | 'wallet' | 'vault' | 'fund' | 'credentials' | 'agent'
}

const STEPS: Step[] = [
  {
    step: '01',
    title: 'Create your Haven account',
    body: 'Sign up with your email, no credit card, no setup call.',
    visual: 'account',
  },
  {
    step: '02',
    title: 'Connect your wallet',
    body: "Bring an existing wallet — or spin up a new one. This is the personal key you use to sign off on changes. It's yours, not Haven's.",
    visual: 'wallet',
  },
  {
    step: '03',
    title: 'Create your Haven wallet',
    body: 'We deploy a smart wallet — your wallet — that holds the funds your agents will spend. You stay in control. Haven can never move money on its own.',
    visual: 'vault',
  },
  {
    step: '04',
    title: 'Fund your wallet',
    body: 'Send USDC, EURe, or any supported asset to your wallet address. Balances appear instantly. Withdraw or top up whenever you want.',
    visual: 'fund',
  },
  {
    step: '05',
    title: 'Add an agent',
    body: 'Set the rules — daily limit, allowed recipients, what kinds of things the agent can pay for. Generate credentials.',
    visual: 'credentials',
  },
  {
    step: '06',
    title: 'Hand the credential to your agent',
    body: 'Drop the credential into your agent — Claude, GPT, a custom script, anything. It can now pay autonomously, but only inside the rules you set.',
    visual: 'agent',
  },
]

const PROMISES = [
  { value: 'Non-custodial', label: 'Haven never holds your funds' },
  { value: '1-click revoke', label: 'Kill an agent instantly' },
  { value: 'Full audit log', label: 'Every payment, every check' },
]

function VisualAccount() {
  return (
    <div className="relative h-44 flex items-center justify-center">
      <div className="relative w-64 h-28 rounded-lg border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent overflow-hidden">
        <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)', backgroundSize: '14px 14px' }} />
        <div className="relative p-4 flex flex-col gap-2">
          <div className="h-2 w-20 rounded-full bg-white/10" />
          <div className="h-2 w-32 rounded-full bg-white/10" />
          <div className="mt-2 inline-flex items-center gap-2 self-start px-2 py-1 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-[10px] font-medium animate-[hwShimmer_2.4s_ease-in-out_infinite]">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            Account ready
          </div>
        </div>
        <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-300 text-sm animate-[hwPop_1.6s_ease-out_0.4s_both]">✓</div>
      </div>
    </div>
  )
}

function VisualWallet() {
  return (
    <div className="relative h-44 flex items-center justify-center">
      <div className="relative w-72 h-28 flex items-center justify-between px-2">
        <div className="w-24 h-20 rounded-md border border-white/10 bg-gradient-to-br from-white/[0.05] to-transparent flex items-center justify-center animate-[hwSlideR_1.4s_ease-out_both]">
          <span className="text-2xl">👤</span>
        </div>
        <div className="flex-1 mx-3 h-px bg-gradient-to-r from-indigo-500/0 via-indigo-400/60 to-violet-500/0 relative overflow-hidden">
          <span className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-indigo-300 shadow-[0_0_12px_3px_rgba(129,140,248,0.6)] animate-[hwFlow_2.2s_linear_infinite]" />
        </div>
        <div className="w-24 h-20 rounded-md border border-indigo-400/30 bg-gradient-to-br from-indigo-500/15 to-violet-600/15 flex items-center justify-center animate-[hwSlideL_1.4s_ease-out_both]">
          <span className="text-2xl">🔐</span>
        </div>
      </div>
    </div>
  )
}

function VisualVault() {
  return (
    <div className="relative h-44 flex items-center justify-center">
      <div className="relative w-32 h-32 rounded-2xl border border-indigo-400/40 bg-gradient-to-br from-indigo-500/15 to-violet-600/15 flex items-center justify-center shadow-[0_0_60px_-10px_rgba(99,102,241,0.55)] animate-[hwPulseGlow_2.6s_ease-in-out_infinite]">
        <div className="absolute inset-2 rounded-xl border border-white/10" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-10 h-10 rounded-full border-2 border-indigo-300/70 flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-gradient-to-br from-indigo-300 to-violet-400" />
          </div>
        </div>
        <div className="absolute -top-3 -right-3 w-10 h-10 rounded-full bg-[#0a0a0a] border border-emerald-400/50 flex items-center justify-center text-emerald-300 text-base shadow-lg shadow-emerald-500/20 animate-[hwPop_1.6s_ease-out_0.6s_both]">🛡</div>
      </div>
    </div>
  )
}

function VisualFund() {
  return (
    <div className="relative h-44 flex items-center justify-center">
      <div className="relative flex flex-col items-center gap-5">
        <div className="flex items-center gap-3">
          <span className="hw-anim w-7 h-7 rounded-full bg-gradient-to-br from-amber-300/80 to-amber-500/80 text-[#0a0a0a] text-[11px] font-semibold flex items-center justify-center shadow-md" style={{ animation: 'hwFadeUp 0.6s ease-out 0.1s both' }}>$</span>
          <span className="hw-anim w-7 h-7 rounded-full bg-gradient-to-br from-sky-300/80 to-indigo-400/80 text-[#0a0a0a] text-[11px] font-semibold flex items-center justify-center shadow-md" style={{ animation: 'hwFadeUp 0.6s ease-out 0.2s both' }}>€</span>
          <span className="hw-anim w-7 h-7 rounded-full bg-gradient-to-br from-emerald-300/80 to-emerald-500/80 text-[#0a0a0a] text-[11px] font-semibold flex items-center justify-center shadow-md" style={{ animation: 'hwFadeUp 0.6s ease-out 0.3s both' }}>◈</span>
        </div>
        <div className="relative w-40 h-24 rounded-xl border border-indigo-400/40 bg-gradient-to-br from-indigo-500/10 to-violet-600/10 flex flex-col items-center justify-center animate-[hwPulseGlow_3.2s_ease-in-out_infinite]">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">Balance</span>
          <span className="text-lg font-semibold bg-gradient-to-br from-white to-indigo-200 bg-clip-text text-transparent animate-[hwTick_0.7s_ease-out_0.5s_both]">
            1,250 USDC
          </span>
        </div>
      </div>
    </div>
  )
}

function VisualCredentials() {
  return (
    <div className="relative h-44 flex items-center justify-center">
      <div className="relative w-72 h-32">
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-36 rounded-md border border-white/10 bg-gradient-to-br from-white/[0.05] to-transparent p-3 animate-[hwSlideR_1.4s_ease-out_both]">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Policy</div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px]"><span className="text-zinc-500">Daily</span><span className="text-zinc-300">$500</span></div>
            <div className="flex items-center justify-between text-[10px]"><span className="text-zinc-500">Per tx</span><span className="text-zinc-300">$50</span></div>
            <div className="flex items-center justify-between text-[10px]"><span className="text-zinc-500">Asset</span><span className="text-indigo-300">USDC</span></div>
          </div>
        </div>
        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-36 rounded-md border border-indigo-400/30 bg-gradient-to-br from-indigo-500/15 to-violet-600/15 p-3 animate-[hwSlideL_1.4s_ease-out_both]">
          <div className="text-[10px] uppercase tracking-widest text-indigo-300/80 mb-2">Credential</div>
          <div className="font-mono text-[10px] text-zinc-300 break-all leading-snug">sk_live_••••<br/>9aF2c7•••</div>
          <div className="mt-2 inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-400/30 text-emerald-300 text-[9px]">
            <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" /> active
          </div>
        </div>
      </div>
    </div>
  )
}

function VisualAgent() {
  return (
    <div className="relative h-44 flex items-center justify-center">
      <div className="relative w-72 h-32 flex items-center justify-between">
        <div className="w-20 h-20 rounded-full border border-indigo-400/40 bg-gradient-to-br from-indigo-500/15 to-violet-600/15 flex items-center justify-center text-3xl shadow-[0_0_30px_-8px_rgba(99,102,241,0.5)]">
          🤖
        </div>
        <div className="flex-1 mx-3 h-px bg-gradient-to-r from-indigo-400/0 via-indigo-400/60 to-emerald-400/60 relative overflow-hidden">
          <span className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-indigo-300 shadow-[0_0_12px_3px_rgba(129,140,248,0.6)] animate-[hwFlow_2s_linear_infinite]" />
        </div>
        <div className="w-28 rounded-md border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-3">
          <div className="text-[9px] uppercase tracking-widest text-emerald-300/80 mb-1">Receipt</div>
          <div className="text-[11px] text-zinc-200 font-medium">Paid · 2.50 USDC</div>
          <div className="mt-1 text-[9px] text-zinc-500">api.example.com</div>
          <div className="mt-1.5 inline-flex items-center gap-1 text-emerald-300 text-[10px]">
            <span className="text-sm leading-none">✓</span> settled
          </div>
        </div>
      </div>
    </div>
  )
}

const VISUALS = {
  account: VisualAccount,
  wallet: VisualWallet,
  vault: VisualVault,
  fund: VisualFund,
  credentials: VisualCredentials,
  agent: VisualAgent,
}

export default function HowItWorksPage() {
  return (
    <div className="bg-[#0a0a0a] text-[#ededed] min-h-screen overflow-x-hidden">
      <style jsx global>{`
        @keyframes hwFadeUp { 0% { opacity: 0; transform: translateY(14px); } 100% { opacity: 1; transform: translateY(0); } }
        @keyframes hwFlow { 0% { left: -8px; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { left: calc(100% + 8px); opacity: 0; } }
        @keyframes hwPop { 0% { opacity: 0; transform: scale(0.4); } 60% { opacity: 1; transform: scale(1.15); } 100% { opacity: 1; transform: scale(1); } }
        @keyframes hwPulseGlow { 0%, 100% { box-shadow: 0 0 50px -12px rgba(99,102,241,0.45); } 50% { box-shadow: 0 0 70px -8px rgba(139,92,246,0.65); } }
        @keyframes hwSlideR { 0% { opacity: 0; transform: translateX(-18px); } 100% { opacity: 1; transform: translateX(0); } }
        @keyframes hwSlideL { 0% { opacity: 0; transform: translateX(18px); } 100% { opacity: 1; transform: translateX(0); } }
        @keyframes hwShimmer { 0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); } 50% { box-shadow: 0 0 24px 0 rgba(99,102,241,0.4); } }
        @keyframes hwTick { 0% { opacity: 0; transform: translateY(6px); } 100% { opacity: 1; transform: translateY(0); } }
        @keyframes hwDrop { 0% { opacity: 0; transform: translateY(-30px) scale(0.8); } 30% { opacity: 1; } 80% { opacity: 1; transform: translateY(72px) scale(1); } 100% { opacity: 0; transform: translateY(80px) scale(0.6); } }
        @keyframes hwNodePulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(129,140,248,0.0); } 50% { box-shadow: 0 0 0 6px rgba(129,140,248,0.15); } }
        .hw-anim { animation-fill-mode: both; }
      `}</style>

      {/* Page-level top gradient wash */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{ background: 'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.18) 0%, transparent 70%)' }}
      />

      <SiteHeader />

      {/* Hero */}
      <section className="relative max-w-6xl mx-auto px-6 pt-20 pb-16 md:pt-28 md:pb-24 z-10">
        <div className="pointer-events-none absolute -top-20 -left-40 w-[700px] h-[700px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)' }} />
        <div className="pointer-events-none absolute top-10 right-0 w-[500px] h-[500px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.10) 0%, transparent 70%)' }} />
        <div className="pointer-events-none absolute inset-0 opacity-30" style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)', backgroundSize: '28px 28px' }} />

        <div className="relative max-w-3xl">
          <div className="inline-flex items-center gap-2 mb-7 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-medium hw-anim" style={{ animation: 'hwFadeUp 0.6s ease-out' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
            Get started in minutes
          </div>

          <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05] mb-6 hw-anim" style={{ animation: 'hwFadeUp 0.7s ease-out 0.05s' }}>
            <span className="bg-gradient-to-br from-white via-white to-indigo-200 bg-clip-text text-transparent">
              Empower your agent
            </span>
            <br />
            <span className="bg-gradient-to-br from-white via-indigo-100 to-violet-300 bg-clip-text text-transparent">
              with payment functionality
            </span>
          </h1>

          <p className="text-lg md:text-xl text-zinc-400 leading-relaxed mb-10 max-w-2xl hw-anim" style={{ animation: 'hwFadeUp 0.7s ease-out 0.15s' }}>
            Your agent pays for things on its own — and you stay in control of every dollar.
          </p>

          <div className="flex flex-wrap gap-3 hw-anim" style={{ animation: 'hwFadeUp 0.7s ease-out 0.25s' }}>
            <a href="/signup" className="px-5 py-2.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/25">
              Get Early Access
            </a>
            <a href="/protocols/x402" className="px-5 py-2.5 border border-white/20 text-sm hover:border-white/40 hover:bg-white/[0.04] transition-all duration-200 rounded-md inline-flex items-center gap-2">
              See how x402 works
            </a>
          </div>
        </div>
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />

      {/* Step rows */}
      <section className="relative max-w-6xl mx-auto px-6 py-16 md:py-24 z-10">
        <div className="mb-12">
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">The Six Steps</h2>
        </div>

        <div className="space-y-px bg-white/[0.06]">
          {STEPS.map((s, i) => {
            const Visual = VISUALS[s.visual]
            const reverse = i % 2 === 1
            return (
              <div
                key={s.step}
                className="relative bg-[#0a0a0a] hover:bg-[#0d0d12] transition-colors duration-300 group overflow-hidden"
              >
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-indigo-500/40 via-violet-500/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <div className={`grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center px-6 md:px-10 py-12 md:py-16 ${reverse ? 'md:[direction:rtl]' : ''}`}>
                  <div className={`${reverse ? 'md:[direction:ltr]' : ''}`}>
                    <span className="block text-3xl font-bold mb-4 bg-gradient-to-br from-indigo-400 to-violet-500 bg-clip-text text-transparent">
                      {s.step}
                    </span>
                    <h3 className="text-2xl md:text-3xl font-semibold mb-4 tracking-tight">{s.title}</h3>
                    <p className="text-base text-zinc-400 leading-relaxed max-w-md">{s.body}</p>
                  </div>
                  <div className={`${reverse ? 'md:[direction:ltr]' : ''}`}>
                    <Visual />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-violet-500/30 to-transparent" />

      {/* Promises band */}
      <section className="relative max-w-6xl mx-auto px-6 py-16 md:py-20 z-10">
        <div className="mb-10">
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">What You Get</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/[0.06]">
          {PROMISES.map((p) => (
            <div key={p.value} className="relative bg-[#0a0a0a] p-8 overflow-hidden group hover:bg-[#0d0d12] transition-colors duration-300">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              <span className="block text-2xl font-bold tracking-tight mb-1 bg-gradient-to-br from-indigo-300 to-violet-400 bg-clip-text text-transparent">
                {p.value}
              </span>
              <span className="text-sm text-zinc-500">{p.label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />

      {/* CTA */}
      <section className="relative max-w-6xl mx-auto px-6 py-24 md:py-32 text-center z-10 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[400px]" style={{ background: 'radial-gradient(ellipse 60% 80% at 50% 50%, rgba(99,102,241,0.12) 0%, rgba(139,92,246,0.06) 40%, transparent 70%)' }} />
        <div className="relative">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight leading-[1.05] mb-4">
            <span className="bg-gradient-to-br from-white via-white to-indigo-200 bg-clip-text text-transparent">
              Ready to set up
            </span>
            <br />
            <span className="bg-gradient-to-br from-indigo-200 via-violet-200 to-violet-300 bg-clip-text text-transparent">
              your first agent?
            </span>
          </h2>
          <p className="text-zinc-500 text-sm mb-10">No credit card required. Deploy in minutes.</p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a href="/signup" className="px-6 py-3 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-xl shadow-indigo-500/30">
              Get Early Access
            </a>
            <a href="/protocols/x402" className="text-sm text-zinc-500 hover:text-[#ededed] transition-colors duration-200 underline underline-offset-4 decoration-zinc-700">
              See how x402 works
            </a>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
