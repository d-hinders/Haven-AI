import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'

const INTEGRATIONS = ['Safe', 'Gnosis Chain', 'x402', 'Stripe MPP', 'USDC', 'EURe']

const PROBLEM_CARDS = [
  {
    title: 'Agents hit paywalls and stop',
    body: 'Most agents have no way to handle payment-gated services. When they encounter a paywall, the workflow breaks — requiring human intervention to continue.',
  },
  {
    title: 'Hardcoded keys are a disaster',
    body: 'Giving agents raw wallet access means zero controls. One compromised agent can drain everything. There is no way to limit scope, revoke access, or audit what happened.',
  },
  {
    title: "Workarounds don't scale",
    body: "Manual approvals and shared credit cards negate the value of automation. You end up babysitting every transaction, defeating the purpose of autonomous agents entirely.",
  },
]

const HOW_IT_WORKS = [
  {
    step: '01',
    title: 'Create an account',
    body: 'Sign up and set up your Haven account in minutes. Your funds are held in a non-custodial smart wallet — you retain full ownership at all times.',
  },
  {
    step: '02',
    title: 'Create an agent with policies',
    body: 'Define exactly what each agent can do: daily spend limits, allowed assets, approved recipients, time constraints, and per-transaction approval thresholds.',
  },
  {
    step: '03',
    title: 'Agents transact within the rules',
    body: 'Agents send payment intents to Haven. The policy engine evaluates each one and executes via Safe — or queues for human approval when thresholds are exceeded.',
  },
]

const POLICY_METRICS = [
  { value: '$500', label: 'Daily spend limit' },
  { value: 'ERC-20', label: 'Asset allowlists' },
  { value: '>$100', label: 'Requires approval' },
  { value: '100%', label: 'Audited transactions' },
]

const DIFFERENTIATORS = [
  {
    title: 'Non-custodial',
    body: 'Your funds live in a smart wallet you control. Haven never holds signing authority — if we disappear tomorrow, your money is safe.',
  },
  {
    title: 'Policy-first',
    body: 'Every action is evaluated against your rules before execution. No intent touches the blockchain without passing through the policy engine.',
  },
  {
    title: 'Agent-first API',
    body: 'Agents express intent in plain terms — pay, transfer, approve. Haven handles the blockchain complexity so agents never need to.',
  },
  {
    title: 'Protocol native',
    body: 'Built-in support for x402 (HTTP 402 paywalls) and Stripe MPP (machine-payments protocol). Agents transact via open standards — stablecoin settlement today, fiat rails next.',
  },
  {
    title: 'Runtime agnostic',
    body: 'Works with Claude, GPT, custom scripts, and any orchestration framework. Haven makes no assumptions about where your agents run.',
  },
  {
    title: 'Defense in depth',
    body: 'Five independent security layers — smart account, policy engine, credential scoping, approval flows, and full audit trail.',
  },
]

export default function Home() {
  return (
    <div className="bg-[#0a0a0a] text-[#ededed] min-h-screen overflow-x-hidden">

      {/* Page-level top gradient wash */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{ background: 'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.18) 0%, transparent 70%)' }}
      />

      <SiteHeader />

      {/* Hero */}
      <section className="relative max-w-6xl mx-auto px-6 pt-24 pb-20 md:pt-32 md:pb-28 z-10">

        {/* Hero background blobs */}
        <div
          className="pointer-events-none absolute -top-20 -left-40 w-[700px] h-[700px] rounded-full opacity-100"
          style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)' }}
        />
        <div
          className="pointer-events-none absolute top-10 right-0 w-[500px] h-[500px] rounded-full opacity-100"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.10) 0%, transparent 70%)' }}
        />

        {/* Dot grid texture */}
        <div
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />

        <div className="relative max-w-3xl">
          {/* Eyebrow badge */}
          <div className="inline-flex items-center gap-2 mb-7 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
            Agent-first wallet infrastructure
          </div>

          <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05] mb-6">
            <span className="bg-gradient-to-br from-white via-white to-indigo-200 bg-clip-text text-transparent">
              Agents transact.
            </span>
            <br />
            <span className="bg-gradient-to-br from-white via-indigo-100 to-violet-300 bg-clip-text text-transparent">
              You set the rules.
            </span>
          </h1>

          <p className="text-lg md:text-xl text-zinc-400 leading-relaxed mb-10 max-w-2xl">
            Non-custodial wallet infrastructure that gives AI agents the ability to hold, send, and receive money — within strict, user-defined guardrails.
          </p>

          <div className="flex flex-wrap gap-3 mb-16">
            <a
              href="/signup"
              className="px-5 py-2.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/25"
            >
              Get Early Access
            </a>
            <a
              href="/how-it-works"
              className="px-5 py-2.5 border border-white/20 text-sm hover:border-white/40 hover:bg-white/[0.04] transition-all duration-200 rounded-md inline-flex items-center gap-2"
            >
              See how it works
            </a>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-600 mr-1">Integrates with</span>
            {INTEGRATIONS.map((name) => (
              <span
                key={name}
                className="text-xs px-3 py-1 border border-white/[0.1] text-zinc-400 rounded-sm hover:border-indigo-500/40 hover:text-indigo-300 transition-colors duration-200"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Gradient divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />

      {/* [01] The Problem */}
      <section className="relative max-w-6xl mx-auto px-6 py-20 md:py-24 z-10">
        <div className="flex items-baseline gap-4 mb-12">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">[01]</span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">The Problem</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/[0.06]">
          {PROBLEM_CARDS.map((card) => (
            <div
              key={card.title}
              className="bg-[#0a0a0a] p-8 hover:bg-[#0d0d12] transition-colors duration-300"
            >
              <div className="w-6 h-px bg-gradient-to-r from-indigo-500 to-violet-500 mb-5 opacity-70" />
              <h3 className="text-base font-semibold mb-3 leading-snug">{card.title}</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* [02] How It Works */}
      <section className="relative max-w-6xl mx-auto px-6 py-20 md:py-24 z-10">
        <div className="flex items-baseline gap-4 mb-12">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">[02]</span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">How It Works</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/[0.06]">
          {HOW_IT_WORKS.map((item) => (
            <div key={item.step} className="bg-[#0a0a0a] p-8 hover:bg-[#0d0d12] transition-colors duration-300">
              <span className="block text-2xl font-bold mb-5 bg-gradient-to-br from-indigo-400 to-violet-500 bg-clip-text text-transparent">
                {item.step}
              </span>
              <h3 className="text-base font-semibold mb-3">{item.title}</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Gradient divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-violet-500/30 to-transparent" />

      {/* [03] Policy Engine */}
      <section className="relative max-w-6xl mx-auto px-6 py-20 md:py-24 z-10">
        {/* Background glow for this section */}
        <div
          className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 w-[500px] h-[400px] opacity-100"
          style={{ background: 'radial-gradient(ellipse, rgba(139,92,246,0.07) 0%, transparent 70%)' }}
        />
        <div className="flex items-baseline gap-4 mb-12">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">[03]</span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">Policy Engine</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-white/[0.06] mb-12">
          {POLICY_METRICS.map((metric) => (
            <div key={metric.label} className="relative bg-[#0a0a0a] p-8 overflow-hidden group hover:bg-[#0d0d12] transition-colors duration-300">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              <span className="block text-3xl font-bold tracking-tight mb-1 bg-gradient-to-br from-indigo-300 to-violet-400 bg-clip-text text-transparent">
                {metric.value}
              </span>
              <span className="text-xs text-zinc-500">{metric.label}</span>
            </div>
          ))}
        </div>
        <p className="relative text-sm text-zinc-400 leading-relaxed max-w-2xl">
          Every payment intent passes through the policy engine before any money moves. Policies are owned and set by the account holder — agents can request actions, but cannot modify the rules that govern them. Nothing reaches the blockchain without policy clearance.
        </p>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* [04] Protocol Native */}
      <section className="relative max-w-6xl mx-auto px-6 py-20 md:py-24 z-10">
        <div className="flex items-baseline gap-4 mb-12">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">[04]</span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">Protocol Native</h2>
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl mb-10">
          Agents need to transact across rails. Haven speaks the open standards — x402 for pay-per-request flows, Stripe MPP for broader agent commerce — under one policy engine. Stablecoin settlement today; SPT-backed fiat rails next.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/[0.06]">
          <a
            href="/protocols/x402"
            className="relative bg-[#0a0a0a] p-8 overflow-hidden group hover:bg-[#0d0d12] transition-colors duration-300 block"
          >
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-indigo-500/40 via-violet-500/40 to-transparent opacity-40" />
            <div className="text-[11px] uppercase tracking-widest text-indigo-300/80 mb-3 font-mono">HTTP paywalls</div>
            <h3 className="text-base font-semibold mb-3">x402 — pay-per-request HTTP</h3>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Agents resolve HTTP 402 paywalls autonomously. Haven evaluates the payment against the agent's allowance, settles on-chain from the Safe, and returns the proof — the agent never handles keys.
            </p>
            <span className="inline-flex items-center gap-1 mt-4 text-xs text-indigo-300 group-hover:text-indigo-200 transition-colors duration-200">
              See the x402 flow →
            </span>
          </a>
          <a
            href="/protocols/mpp"
            className="relative bg-[#0a0a0a] p-8 overflow-hidden group hover:bg-[#0d0d12] transition-colors duration-300 block"
          >
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-violet-500/40 to-indigo-500/40 opacity-40" />
            <div className="text-[11px] uppercase tracking-widest text-violet-300/80 mb-3 font-mono">Stablecoin checkout</div>
            <h3 className="text-base font-semibold mb-3">Stripe MPP — agent-initiated payments</h3>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Stripe's Machine Payments Protocol is rail-agnostic — stablecoins on-chain or fiat (cards, wallets, BNPL) via Shared Payment Tokens. Haven implements the stablecoin path today: agents settle USDC under the same policy that gates x402 spend. SPT-backed fiat next.
            </p>
            <span className="inline-flex items-center gap-1 mt-4 text-xs text-violet-300 group-hover:text-violet-200 transition-colors duration-200">
              See the MPP flow →
            </span>
          </a>
        </div>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* [05] Key Differentiators */}
      <section className="relative max-w-6xl mx-auto px-6 py-20 md:py-24 z-10">
        <div className="flex items-baseline gap-4 mb-12">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">[05]</span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">Why Haven</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-px bg-white/[0.06]">
          {DIFFERENTIATORS.map((item, i) => (
            <div key={item.title} className="relative bg-[#0a0a0a] p-8 overflow-hidden group hover:bg-[#0d0d12] transition-colors duration-300">
              {/* Top gradient accent line */}
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-indigo-500/60 via-violet-500/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              {/* Index number */}
              <span className="block text-xs font-mono mb-5 bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="text-sm font-semibold text-[#ededed] mb-2">{item.title}</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Gradient divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />

      {/* [06] CTA */}
      <section className="relative max-w-6xl mx-auto px-6 py-24 md:py-32 text-center z-10 overflow-hidden">
        {/* CTA section glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[400px]"
          style={{ background: 'radial-gradient(ellipse 60% 80% at 50% 50%, rgba(99,102,241,0.12) 0%, rgba(139,92,246,0.06) 40%, transparent 70%)' }}
        />

        <div className="relative">
          <span className="block text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent mb-8">[06]</span>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight leading-[1.05] mb-4">
            <span className="bg-gradient-to-br from-white via-white to-indigo-200 bg-clip-text text-transparent">
              Ready to give your agents
            </span>
            <br />
            <span className="bg-gradient-to-br from-indigo-200 via-violet-200 to-violet-300 bg-clip-text text-transparent">
              financial superpowers?
            </span>
          </h2>
          <p className="text-zinc-500 text-sm mb-10">No credit card required. Deploy in minutes.</p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="/signup"
              className="px-6 py-3 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-xl shadow-indigo-500/30"
            >
              Get Early Access
            </a>
            <a
              href="/how-it-works"
              className="text-sm text-zinc-500 hover:text-[#ededed] transition-colors duration-200 underline underline-offset-4 decoration-zinc-700"
            >
              Read the Technical Overview
            </a>
          </div>
        </div>
      </section>

      <SiteFooter />

    </div>
  )
}
