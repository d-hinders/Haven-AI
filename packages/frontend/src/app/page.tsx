import Link from 'next/link'
import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'
import { Button } from '@/components/ui/Button'
import { Section } from '@/components/marketing/Section'
import { Card } from '@/components/ui/Card'
import { StepList } from '@/components/marketing/StepList'
import { HeroBackdrop } from '@/components/marketing/HeroBackdrop'
import { FlowCard } from '@/components/marketing/FlowCard'

const INTEGRATIONS = ['Base', 'Gnosis Chain', 'x402', 'Stripe MPP', 'USDC', 'EURe']

const PROBLEM_CARDS = [
  {
    title: 'Agents hit paywalls and stop',
    body: 'Most agents have no way to pay for the services they need. The moment they hit a paywall — an API call, a subscription, a per‑use fee — the workflow stalls and a human has to step in. Autonomy ends at the checkout.',
  },
  {
    title: "Traditional payments weren't built for agents",
    body: 'Cards, bank transfers, and checkout flows assume a human is present to approve, sign in, or solve a captcha. Agents get blocked, abandoned, or forced into shared credentials. The rails simply don’t speak agent.',
  },
  {
    title: 'Stablecoins are the obvious rail — and the obvious risk',
    body: 'Stablecoins were practically built for AI agents: instant, programmable, global, machine‑native. But giving an agent a private key means unlimited authority, no spend caps, and no audit trail. The right rail becomes the fastest way to lose control.',
  },
]

const HAVEN_MODEL = [
  {
    title: 'A non‑custodial account',
    body: 'Your funds live in a Haven account that only you control. Nothing moves without your rules clearing first — if Haven vanished tomorrow, your money would still be yours.',
  },
  {
    title: 'A policy engine',
    body: 'Every payment is checked against your rules before it moves. Spending limits, approved currencies, approval thresholds — your policies, enforced before the transaction is sent.',
  },
  {
    title: 'A scoped agent credential',
    body: 'Agents carry a payment credential — scoped to what you allow and revocable at any time. If a credential leaks, you rotate it; your funds stay exactly where they were.',
  },
]

const HOW_IT_WORKS = [
  {
    step: '01',
    title: 'Create an account',
    body: 'Sign up and set up your Haven account in minutes. Your Haven wallet keeps funds under your control.',
  },
  {
    step: '02',
    title: 'Set agent rules',
    body: 'Set how much each agent can spend, and over what period. Anything outside that budget waits for your manual approval.',
  },
  {
    step: '03',
    title: 'Connect your agent',
    body: 'Add your Haven credential to Claude, GPT, or your own agent. It can now make payments — only within the rules you set.',
  },
]

const POLICY_METRICS = [
  { value: '$500', label: 'Daily budget' },
  { value: 'USDC', label: 'Allowed currencies' },
  { value: '>$100', label: 'Requires approval' },
  { value: '100%', label: 'Audited payments' },
]

const DIFFERENTIATORS = [
  {
    title: 'You stay in control',
    body: 'Your funds live in your Haven wallet. You approve actions; Haven never moves money on its own. If we disappear tomorrow, your money is safe.',
  },
  {
    title: 'Rules‑first',
    body: 'Every payment is checked against your rules before it goes through. Nothing reaches the network without clearing your rules.',
  },
  {
    title: 'Built for agents',
    body: 'Agents express intent in plain terms — pay, transfer, approve. Haven handles the blockchain complexity so agents never need to.',
  },
  {
    title: 'Open standards',
    body: 'Built‑in support for x402 (HTTP 402 paywalls) and Stripe MPP. Stablecoin settlement today, fiat rails next.',
  },
  {
    title: 'Works with any agent',
    body: 'Works with Claude, GPT, custom scripts, and any orchestration framework. Haven makes no assumptions about where your agents run.',
  },
  {
    title: 'Layered security',
    body: 'Five independent layers — your Haven account, your rules, scoped agent credentials, approval flows, and a full audit trail.',
  },
]

export default function Home() {
  return (
    <>
      <SiteHeader />

      {/* Hero with mesh backdrop */}
      <section className="relative overflow-hidden">
        <HeroBackdrop />
        <div className="relative max-w-6xl mx-auto px-6 pt-20 md:pt-28 pb-16 md:pb-24">
          <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-12 lg:gap-16 items-center">
            <div>
              <div className="inline-flex items-center gap-2 mb-6 px-2.5 py-1 rounded-full border border-[var(--v2-border)] bg-white/80 backdrop-blur text-[12px] text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] animate-pulse" />
                Agent‑first wallet infrastructure
              </div>

              <h1 className="text-[44px] md:text-[64px] font-semibold tracking-[-0.03em] leading-[1.02] text-[var(--v2-ink)] mb-6">
                Agents{' '}
                <span className="relative whitespace-nowrap">
                  <span
                    className="bg-clip-text text-transparent"
                    style={{
                      backgroundImage:
                        'linear-gradient(110deg, #4f46e5 0%, #7c3aed 45%, #ec4899 100%)',
                    }}
                  >
                    transact
                  </span>
                  <span className="text-[var(--v2-ink)]">.</span>
                </span>
                <br />
                You set the rules.
              </h1>

              <p className="text-[17px] md:text-[18px] leading-relaxed text-[var(--v2-ink-2)] mb-8 max-w-[520px]">
                An account for your agents. You set the rules — they pay within them,
                never beyond. No raw keys, no shared cards.
              </p>

              <div className="flex flex-wrap items-center gap-3 mb-10">
                <Button href="/signup" size="lg" trailingIcon>Get early access</Button>
                <Button href="/how-it-works" variant="ghost" size="lg">
                  See how it works
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                <span className="text-[12px] text-[var(--v2-ink-3)] mr-1">Integrates with</span>
                {INTEGRATIONS.map((name) => (
                  <span
                    key={name}
                    className="text-[12px] px-2 py-1 rounded-md bg-white/80 backdrop-blur text-[var(--v2-ink-2)] border border-[var(--v2-border)]"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>

            <div className="relative">
              <FlowCard />
            </div>
          </div>
        </div>
      </section>

      {/* The problem */}
      <Section
        eyebrow="The problem"
        title="Agents need money. Today, that's an open wound."
        lede="Hardcoded credentials, shared cards, manual approvals — every workaround undoes the value of automation."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {PROBLEM_CARDS.map((card) => (
            <Card key={card.title} className="p-7">
              <h3 className="text-[15px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                {card.title}
              </h3>
              <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">{card.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* The Haven model */}
      <Section
        eyebrow="The Haven model"
        title="A wallet built around rules — not keys."
        lede="Your money stays in your account. Haven is the rules layer between your agents and your funds, checking every payment against the policies you set. Three pieces work together to make that possible."
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {HAVEN_MODEL.map((card) => (
            <Card key={card.title} className="p-7">
              <h3 className="text-[15px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                {card.title}
              </h3>
              <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">{card.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* How it works — striking dark indigo band, with policy tiles as proof */}
      <section
        data-v2-dark-section
        className="relative overflow-hidden text-white"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 20% 0%, rgba(124,58,237,0.55) 0%, transparent 60%), radial-gradient(ellipse 70% 70% at 100% 100%, rgba(236,72,153,0.45) 0%, transparent 55%), linear-gradient(180deg, #1e1b4b 0%, #2e2a78 100%)',
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.18] pointer-events-none"
          style={{
            backgroundImage:
              'radial-gradient(circle, rgba(255,255,255,0.6) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
            maskImage:
              'radial-gradient(ellipse 80% 60% at 50% 30%, black 0%, transparent 75%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 80% 60% at 50% 30%, black 0%, transparent 75%)',
          }}
        />
        <div className="relative max-w-6xl mx-auto px-6 py-20 md:py-28">
          <div className="max-w-2xl mb-12">
            <div className="text-[12px] font-medium tracking-tight text-fuchsia-200 mb-3">
              <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-300 inline-block mr-2" />
              How it works
            </div>
            <h2 className="text-[28px] md:text-[40px] font-semibold tracking-[-0.025em] leading-[1.1] mb-4">
              Three steps. One set of rules.
            </h2>
            <p className="text-[16px] leading-relaxed text-white/75">
              Set up your account, define your rules, plug in your agent. Your rules
              decide every payment before any money moves.
            </p>
          </div>

          <StepList steps={HOW_IT_WORKS} tone="dark" />

          <div className="mt-12">
            <div className="text-[12px] font-medium tracking-tight text-fuchsia-200/90 mb-4">
              A sample agent rule set
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-[12px] overflow-hidden bg-white/10 border border-white/10 backdrop-blur">
              {POLICY_METRICS.map((metric) => (
                <div
                  key={metric.label}
                  className="bg-white/[0.04] hover:bg-white/[0.08] transition-colors px-6 py-7"
                >
                  <div className="text-[28px] md:text-[32px] font-semibold tracking-[-0.02em] text-white v2-tabular">
                    {metric.value}
                  </div>
                  <div className="text-[13px] text-white/70 mt-1">{metric.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-10">
            <Link
              href="/how-it-works"
              className="inline-flex items-center gap-1.5 text-[14px] font-medium text-white hover:text-white/90 transition-colors group"
            >
              See the full walkthrough
              <svg
                className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
              >
                <path
                  d="M3.5 8h9M9 4.5L12.5 8 9 11.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* Protocol native */}
      <Section
        eyebrow="Protocol native"
        title="One set of rules. Open standards. Built on stablecoins."
        lede="Agents move at machine speed and need money that does too. Stablecoins settle in seconds, 24/7, with spend rules enforced by smart contracts — not by a bank that takes days. Haven speaks the open standards on those rails — x402 for pay‑per‑request flows, Stripe MPP for broader agent commerce — under one agent rules layer."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Card hover={false} className="p-7 hover:border-[var(--v2-brand)]/40 hover:shadow-[0_12px_32px_-16px_rgba(79,70,229,0.30)] transition-all group">
            <Link href="/protocols/x402" className="block">
              <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-3">
                HTTP paywalls
              </div>
              <h3 className="text-[18px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                x402 — pay‑per‑request HTTP
              </h3>
              <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)] mb-4">
                Agents resolve HTTP 402 paywalls autonomously. Haven evaluates the payment
                against your agent rules, settles on‑chain, and returns the proof.
              </p>
              <span className="text-[13px] font-medium text-[var(--v2-brand)] inline-flex items-center gap-1 group-hover:gap-2 transition-all">
                See the x402 flow
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
                  <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </Link>
          </Card>

          <Card hover={false} className="p-7 hover:border-[var(--v2-brand)]/40 hover:shadow-[0_12px_32px_-16px_rgba(124,58,237,0.30)] transition-all group">
            <Link href="/protocols/mpp" className="block">
              <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-3">
                Stablecoin checkout
              </div>
              <h3 className="text-[18px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                Stripe MPP — agent‑initiated payments
              </h3>
              <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)] mb-4">
                Stripe's Machine Payments Protocol is rail‑agnostic — stablecoins on‑chain or
                fiat via Shared Payment Tokens. Haven implements the stablecoin path today.
              </p>
              <span className="text-[13px] font-medium text-[var(--v2-brand)] inline-flex items-center gap-1 group-hover:gap-2 transition-all">
                See the MPP flow
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
                  <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </Link>
          </Card>
        </div>
      </Section>

      {/* Why Haven */}
      <Section
        eyebrow="Why Haven"
        title="Built for the way agents actually transact."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {DIFFERENTIATORS.map((item, i) => (
            <Card key={item.title} className="p-7">
              <div className="text-[12px] font-medium text-[var(--v2-brand)] mb-4 v2-tabular">
                {String(i + 1).padStart(2, '0')}
              </div>
              <h3 className="text-[15px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                {item.title}
              </h3>
              <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">{item.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* CTA — bold brand band */}
      <section
        data-v2-dark-section
        className="relative overflow-hidden text-white"
        style={{
          background:
            'radial-gradient(ellipse 80% 80% at 50% 0%, rgba(236,72,153,0.35) 0%, transparent 55%), linear-gradient(180deg, #4f46e5 0%, #4338ca 100%)',
        }}
      >
        <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32 text-center">
          <h2 className="text-[34px] md:text-[48px] font-semibold tracking-[-0.025em] leading-[1.1] mb-4 max-w-[720px] mx-auto">
            Ready to put your agents to work?
          </h2>
          <p className="text-[16px] text-white/80 mb-9">
            No credit card. No setup call. Live in minutes.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors h-12 px-6 text-[15px] bg-white text-[var(--v2-ink)] hover:bg-white/95 shadow-[0_1px_2px_rgba(16,24,40,0.06)]"
            >
              Get early access
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
                <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <Link
              href="/how-it-works"
              className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors h-12 px-6 text-[15px] bg-white/10 hover:bg-white/15 text-white border border-white/20 backdrop-blur"
            >
              Read the technical overview
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}
