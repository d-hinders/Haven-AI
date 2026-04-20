const NAV_LINKS = [
  { label: 'Product', href: '#' },
  { label: 'Live demo', href: '/demo/x402' },
  { label: 'Docs', href: '#' },
  { label: 'GitHub', href: '#' },
]

const INTEGRATIONS = ['Safe', 'Gnosis Chain', 'x402', 'USDC', 'EURe']

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
    title: 'x402 native',
    body: 'Built-in support for HTTP 402 payments. Agents can autonomously pay for API access, data, and compute without human intervention.',
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

      {/* Navigation */}
      <nav className="sticky top-0 z-50 border-b border-white/[0.06] backdrop-blur-md bg-[#0a0a0a]/80">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="text-[15px] font-semibold tracking-tight bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent">
            Haven
          </span>
          <div className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-sm text-zinc-500 hover:text-[#ededed] transition-colors duration-200"
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <a
              href="/login"
              className="text-sm text-zinc-400 hover:text-[#ededed] transition-colors duration-200"
            >
              Log in
            </a>
            <a
              href="/signup"
              className="text-sm px-4 py-1.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
            >
              Get Early Access
            </a>
          </div>
        </div>
      </nav>

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
              href="/demo/x402"
              className="px-5 py-2.5 border border-white/20 text-sm hover:border-white/40 hover:bg-white/[0.04] transition-all duration-200 rounded-md inline-flex items-center gap-2"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
              Watch the live demo
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

      {/* [04] Built for the Agent Economy */}
      <section className="relative max-w-6xl mx-auto px-6 py-20 md:py-24 z-10">
        <div className="flex items-baseline gap-4 mb-12">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">[04]</span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">Built for the Agent Economy</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/[0.06]">
          <div className="relative bg-[#0a0a0a] p-8 overflow-hidden group hover:bg-[#0d0d12] transition-colors duration-300">
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-indigo-500/40 via-violet-500/40 to-transparent opacity-40" />
            <h3 className="text-base font-semibold mb-3">x402 Protocol Support</h3>
            <p className="text-sm text-zinc-500 leading-relaxed">
              When an agent encounters an HTTP 402 response, Haven acts as the policy-aware wallet backend. It evaluates the payment against the agent's active policy, signs from the Safe if approved, and returns the proof — without the agent ever handling keys or understanding blockchain mechanics.
            </p>
          </div>
          <div className="relative bg-[#0a0a0a] p-8 overflow-hidden group hover:bg-[#0d0d12] transition-colors duration-300">
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-violet-500/40 to-indigo-500/40 opacity-40" />
            <h3 className="text-base font-semibold mb-3">Portable Credentials, Not Keys</h3>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Agents receive API credentials scoped to their policy — not private keys. Credentials are time-limited, independently revocable, and produce a full audit trail. Compromise an agent credential and you have compromised nothing on-chain. Revoke it in a single API call.
            </p>
          </div>
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
              href="#"
              className="text-sm text-zinc-500 hover:text-[#ededed] transition-colors duration-200 underline underline-offset-4 decoration-zinc-700"
            >
              Read the Technical Overview
            </a>
          </div>
        </div>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-6 py-8 relative z-10">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <span className="block text-sm font-semibold mb-1 bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent">
              Haven
            </span>
            <span className="text-xs text-zinc-600">© 2026 Haven. Built on Safe & Gnosis Chain.</span>
          </div>
          <div className="flex flex-wrap gap-6">
            {['Docs', 'GitHub', 'Twitter'].map((link) => (
              <a
                key={link}
                href="#"
                className="text-xs text-zinc-500 hover:text-[#ededed] transition-colors duration-200"
              >
                {link}
              </a>
            ))}
          </div>
        </div>
      </footer>

    </div>
  )
}
