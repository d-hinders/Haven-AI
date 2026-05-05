import Link from 'next/link'
import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'

const PROTOCOLS = [
  {
    slug: 'x402',
    rail: 'Crypto rails',
    name: 'x402',
    tagline: 'Pay-per-request HTTP, settled on-chain.',
    body:
      'An open standard built on the long-dormant HTTP 402 status code. A server returns 402, the client pays in stablecoin, and retries with the proof. Haven plays the wallet role — agents never touch keys, and every settlement is gated by your policy.',
    bullets: ['HTTP-native — works with any service', 'Stablecoin settlement on Base / Gnosis', 'Per-call paywalls, no accounts'],
    cta: 'See an x402 payment',
    href: '/protocols/x402',
    accentFrom: 'from-indigo-500',
    accentTo: 'to-violet-600',
    badgeBorder: 'border-indigo-400/30',
    badgeBg: 'bg-indigo-500/10',
    badgeText: 'text-indigo-300',
    linkText: 'text-indigo-300 group-hover:text-indigo-200',
  },
  {
    slug: 'mpp',
    rail: 'Fiat rails',
    name: 'Stripe MPP',
    tagline: 'Agent commerce on cards, governed by policy.',
    body:
      "Stripe's Machine Payments Protocol turns regular payment methods into Shared Payment Tokens — one-time, scope-bound credentials an agent can hand to a merchant. Haven mints, governs, and revokes those tokens under the same policy that gates on-chain spend.",
    bullets: ['Works at any Stripe-accepting merchant', 'SPTs are scope-bound and one-time-use', 'Same allowance model as crypto rails'],
    cta: 'See an MPP payment',
    href: '/protocols/mpp',
    accentFrom: 'from-violet-500',
    accentTo: 'to-fuchsia-600',
    badgeBorder: 'border-violet-400/30',
    badgeBg: 'bg-violet-500/10',
    badgeText: 'text-violet-300',
    linkText: 'text-violet-300 group-hover:text-violet-200',
  },
] as const

export default function ProtocolsPage() {
  return (
    <div className="bg-[#0a0a0a] text-[#ededed] min-h-screen overflow-x-hidden">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.18) 0%, transparent 70%)',
        }}
      />

      <SiteHeader />

      {/* Hero */}
      <section className="relative max-w-6xl mx-auto px-6 pt-20 pb-12 md:pt-28 md:pb-16 z-10">
        <div className="pointer-events-none absolute -top-20 -left-40 w-[700px] h-[700px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)' }} />
        <div className="pointer-events-none absolute top-10 right-0 w-[500px] h-[500px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.10) 0%, transparent 70%)' }} />
        <div className="pointer-events-none absolute inset-0 opacity-30" style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)', backgroundSize: '28px 28px' }} />

        <div className="relative max-w-3xl">
          <div className="inline-flex items-center gap-2 mb-7 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
            Protocols
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05] mb-6">
            <span className="bg-gradient-to-br from-white via-white to-indigo-200 bg-clip-text text-transparent">
              One policy engine.
            </span>
            <br />
            <span className="bg-gradient-to-br from-white via-indigo-100 to-violet-300 bg-clip-text text-transparent">
              Every agent payment rail.
            </span>
          </h1>
          <p className="text-lg md:text-xl text-zinc-400 leading-relaxed max-w-2xl">
            Agents need to pay across crypto and fiat. Haven speaks both — natively. The same allowance, approval, and audit model wraps x402 settlement on-chain and Stripe MPP charges in the card networks.
          </p>
        </div>
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />

      {/* Why protocol-native */}
      <section className="relative max-w-6xl mx-auto px-6 py-16 md:py-20 z-10">
        <div className="flex items-baseline gap-4 mb-10">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">[01]</span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">Why protocol-native</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/[0.06]">
          {[
            {
              title: 'No proprietary checkout',
              body: "Haven doesn't invent a new payment flow. Agents speak the same protocols merchants already accept — HTTP 402 today, Stripe's MPP for fiat tomorrow.",
            },
            {
              title: 'One policy, both rails',
              body: 'Whether the agent is buying an API call or a SaaS seat, the same per-token allowance and approval flow gate the spend. You set rules once.',
            },
            {
              title: 'Portable, revocable credentials',
              body: 'On-chain delegate addresses for crypto, MPP Shared Payment Tokens for fiat. Both scope-bound, both revocable in a single call. Agents never hold raw secrets.',
            },
          ].map((card) => (
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

      {/* The two protocols */}
      <section className="relative max-w-6xl mx-auto px-6 py-16 md:py-20 z-10">
        <div className="flex items-baseline gap-4 mb-10">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">[02]</span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">Supported protocols</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/[0.06]">
          {PROTOCOLS.map((p) => (
            <Link
              key={p.slug}
              href={p.href}
              className="relative bg-[#0a0a0a] p-8 md:p-10 hover:bg-[#0d0d12] transition-colors duration-300 group block"
            >
              <div className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${p.accentFrom} ${p.accentTo} opacity-0 group-hover:opacity-60 transition-opacity duration-300`} />
              <div className={`inline-flex items-center gap-2 mb-6 px-2.5 py-1 rounded-full border ${p.badgeBorder} ${p.badgeBg} ${p.badgeText} text-[11px] font-medium uppercase tracking-wider`}>
                {p.rail}
              </div>
              <h3 className="text-2xl md:text-3xl font-semibold mb-2 tracking-tight">
                <span className={`bg-gradient-to-br ${p.accentFrom} ${p.accentTo} bg-clip-text text-transparent`}>{p.name}</span>
              </h3>
              <p className="text-base text-zinc-300 mb-5">{p.tagline}</p>
              <p className="text-sm text-zinc-500 leading-relaxed mb-6 max-w-md">{p.body}</p>
              <ul className="space-y-2 mb-8">
                {p.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2.5 text-xs text-zinc-400">
                    <span className={`mt-1.5 w-1 h-1 rounded-full bg-gradient-to-br ${p.accentFrom} ${p.accentTo} flex-shrink-0`} />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${p.linkText} transition-colors duration-200`}>
                {p.cta} <span aria-hidden>→</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <div className="h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />

      {/* CTA */}
      <section className="relative max-w-6xl mx-auto px-6 py-24 md:py-28 text-center z-10 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[400px]"
          style={{
            background:
              'radial-gradient(ellipse 60% 80% at 50% 50%, rgba(99,102,241,0.12) 0%, rgba(139,92,246,0.06) 40%, transparent 70%)',
          }}
        />
        <div className="relative">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight leading-[1.05] mb-4">
            <span className="bg-gradient-to-br from-white via-white to-indigo-200 bg-clip-text text-transparent">
              Build agents that pay
            </span>
            <br />
            <span className="bg-gradient-to-br from-indigo-200 via-violet-200 to-violet-300 bg-clip-text text-transparent">
              wherever the bill is.
            </span>
          </h2>
          <p className="text-zinc-500 text-sm mb-10">No credit card required. Deploy in minutes.</p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/signup"
              className="px-6 py-3 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-xl shadow-indigo-500/30"
            >
              Get Early Access
            </Link>
            <Link
              href="/how-it-works"
              className="text-sm text-zinc-500 hover:text-[#ededed] transition-colors duration-200 underline underline-offset-4 decoration-zinc-700"
            >
              See how Haven works
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}
