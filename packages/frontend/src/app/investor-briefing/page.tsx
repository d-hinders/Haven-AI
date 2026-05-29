import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { HeroBackdrop } from '@/components/marketing/HeroBackdrop'
import { Card } from '@/components/ui/Card'
import { HavenMark } from '@/components/brand/HavenMark'

const CONTACT_DANIEL_HREF =
  'mailto:replace-this-email-before-sharing@example.com?subject=Haven%20investor%20briefing'

export const metadata: Metadata = {
  title: 'Haven Investor Briefing',
  description:
    'An unlisted investor briefing for Haven, the rules layer for agent payments.',
  robots: {
    index: false,
    follow: false,
  },
}

const NAV_ITEMS = [
  { label: 'Thesis', href: '#thesis' },
  { label: 'Product', href: '#product' },
  { label: 'Market', href: '#market' },
  { label: 'Model', href: '#model' },
]

const SIGNAL_CARDS = [
  { label: 'Category', value: 'Agentic payments', footer: 'AI workflows need controlled spending before they can scale' },
  { label: 'Wedge', value: 'Payment guardrails for AI agents', footer: 'Start with developer and agent infrastructure' },
  { label: 'Timing', value: 'Payment protocols forming', footer: 'x402, MPP, and stablecoins are converging' },
]

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

const PRODUCT_POINTS = [
  {
    title: 'A non‑custodial account',
    body: 'Funds live in a Haven account the user controls. Haven never holds them and can never move them outside the rules the user has set.',
  },
  {
    title: 'A policy engine',
    body: 'Every payment is checked against the user’s rules before it moves. The spending limit — per‑currency budget and reset window — is enforced on‑chain by the smart account itself.',
  },
  {
    title: 'A scoped agent credential',
    body: 'Agents connect from Claude, GPT, scripts, or custom frameworks with a payment credential that’s scoped to the rules and revocable at any time. Never unlimited authority over the wallet.',
  },
  {
    title: 'Full audit trail',
    body: 'Every request, rule check, approval, and payment is logged — which agent asked, which rule cleared it, when it went through.',
  },
]

const INVESTOR_STEPS = [
  {
    step: '01',
    title: 'Create a Haven account',
    body: 'The user gets a controlled account for agent payments.',
  },
  {
    step: '02',
    title: 'Choose approval method',
    body: 'Passkey or wallet-based approval keeps the user in control.',
  },
  {
    step: '03',
    title: 'Fund the Haven wallet',
    body: 'Stablecoins sit in the user-controlled wallet.',
  },
  {
    step: '04',
    title: 'Define agent rules',
    body: 'Set budgets, tokens, protocols, recipients, and approval thresholds.',
  },
  {
    step: '05',
    title: 'Connect the agent',
    body: 'The external agent receives a scoped Haven credential — not unlimited access to the wallet.',
  },
  {
    step: '06',
    title: 'Agent initiates payment',
    body: 'The external agent requests payment. Haven checks the rules; the payment goes through from the user’s wallet, and Haven records the receipt.',
  },
]

const WHY_NOW = [
  {
    title: 'Agents are becoming operators',
    body: 'The next wave of automation is not just drafting text. Agents will procure tools, pay for data, trigger workflows, and settle tasks.',
  },
  {
    title: 'Payment standards are arriving',
    body: 'x402 and Stripe MPP point toward a web where services can quote price and accept payment inside the request flow.',
  },
  {
    title: 'Stablecoins make tiny payments practical',
    body: 'Internet-native settlement makes per-request payments and high-frequency agent commerce plausible without card rails in every loop.',
  },
]

const STABLECOIN_REASONS = [
  {
    title: 'Enforced on‑chain, not by an admin',
    body: 'Stablecoins are enforced by smart contracts, not banks. Haven’s spend rules live on‑chain in the smart‑account allowance itself — verifiable, and impossible to bypass by anyone, including Haven.',
  },
  {
    title: 'Settles in seconds, not days',
    body: 'Bank wires take days. Card networks can cut off in 48 hours. On Base or Gnosis Chain, a stablecoin settles in seconds, 24/7, globally — no correspondent bank to fail mid‑workflow.',
  },
]

const DIFFERENTIATORS = [
  'Agent‑native by design',
  'Works with any agent',
  'Audit‑first',
  'Layered security',
  'Live today',
  'Built to integrate',
]

const MODEL_CARDS = [
  {
    title: 'Usage-based API fees',
    body: 'Charge where Haven is already in the flow: authorization, rule checks, payment execution, and receipts.',
  },
  {
    title: 'Protocol payment rails',
    body: 'Become the controlled wallet backend for agents paying x402 services, MPP merchants, and stablecoin-native APIs.',
  },
  {
    title: 'Premium controls',
    body: 'Expand into team controls, compliance exports, advanced approval paths, and higher-volume agent operations.',
  },
]

export default function InvestorBriefingPage() {
  return (
    <main className="min-h-screen bg-[var(--v2-bg)] text-[var(--v2-ink)]">
      <InvestorHeader />

      <section id="thesis" className="relative overflow-hidden">
        <HeroBackdrop />
        <div className="relative max-w-6xl mx-auto px-6 pt-20 md:pt-28 pb-16 md:pb-24">
          <div className="grid grid-cols-1 lg:grid-cols-[0.95fr_1.05fr] gap-12 lg:gap-16 items-center">
            <div>
              <div className="inline-flex items-center gap-2 mb-6 px-2.5 py-1 rounded-full border border-[var(--v2-border)] bg-white/80 backdrop-blur text-[12px] text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] animate-pulse" />
                Unlisted investor briefing
              </div>

              <h1 className="text-[44px] md:text-[64px] font-semibold tracking-[-0.03em] leading-[1.02] text-[var(--v2-ink)] mb-6">
                Agent payments,
                <br />
                <span
                  className="bg-clip-text text-transparent"
                  style={{
                    backgroundImage:
                      'linear-gradient(110deg, #4f46e5 0%, #7c3aed 45%, #ec4899 100%)',
                  }}
                >
                  within rules
                </span>
                .
              </h1>

              <p className="text-[17px] md:text-[18px] leading-relaxed text-[var(--v2-ink-2)] mb-8 max-w-[580px]">
                Haven is the guardrails layer for AI agents that spend money. Users keep
                custody, budgets, approvals, and audit; agents get a scoped credential,
                never unlimited authority over the wallet.
              </p>

              <div className="flex flex-wrap items-center gap-3 mb-10">
                <InvestorButton href={CONTACT_DANIEL_HREF} variant="primary">
                  Contact Daniel
                </InvestorButton>
                <InvestorButton href="#product" variant="ghost">
                  View product thesis
                </InvestorButton>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {SIGNAL_CARDS.map((card) => (
                  <div
                    key={card.label}
                    className="rounded-[10px] border border-[var(--v2-border)] bg-white/80 backdrop-blur px-4 py-3 shadow-[var(--v2-shadow-card)]"
                  >
                    <div className="text-[11px] text-[var(--v2-ink-3)] mb-1">{card.label}</div>
                    <div className="text-[14px] font-semibold tracking-tight text-[var(--v2-ink)]">
                      {card.value}
                    </div>
                    <div className="text-[12px] leading-snug text-[var(--v2-ink-2)] mt-1">
                      {card.footer}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <ControlSurfaceMock />
          </div>
        </div>
      </section>

      <BriefingSection
        id="problem"
        eyebrow="The problem"
        title="The internet is getting agents before it gets a safe way for them to spend."
        lede="Autonomous workflows break the moment money is involved. The default options are too risky, too manual, or too narrow for real agent commerce."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {PROBLEM_CARDS.map((card) => (
            <Card key={card.title} className="p-7" hover={false}>
              <h3 className="text-[15px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                {card.title}
              </h3>
              <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">{card.body}</p>
            </Card>
          ))}
        </div>
      </BriefingSection>

      <BriefingSection
        id="product"
        eyebrow="The product"
        title="A wallet built around rules — not keys."
        lede="Haven separates the agent’s right to request a payment from the rules that govern whether it goes through. The user controls the wallet and the policy; the agent gets a scoped credential, never unlimited authority."
      >
        <div className="grid grid-cols-1 lg:grid-cols-[0.9fr_1.1fr] gap-8 lg:gap-12 items-start">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {PRODUCT_POINTS.map((point) => (
              <Card key={point.title} className="p-6" hover={false}>
                <h3 className="text-[15px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                  {point.title}
                </h3>
                <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">
                  {point.body}
                </p>
              </Card>
            ))}
          </div>

          <RulesTrace />
        </div>

        <div className="mt-12">
          <div className="mb-6 max-w-2xl">
            <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-3">
              How Haven works
            </div>
            <h3 className="text-[22px] md:text-[26px] font-semibold tracking-[-0.02em] leading-[1.18] text-[var(--v2-ink)]">
              A compact path from controlled account to agent-initiated payment.
            </h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px rounded-[12px] overflow-hidden bg-[var(--v2-border)] border border-[var(--v2-border)]">
            {INVESTOR_STEPS.map((item) => (
              <div key={item.step} className="bg-white px-6 py-6 min-h-[168px]">
                <div className="text-[12px] font-mono text-[var(--v2-brand)] v2-tabular mb-4">
                  {item.step}
                </div>
                <h4 className="text-[15px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                  {item.title}
                </h4>
                <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </BriefingSection>

      <section
        id="market"
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
              Why now
            </div>
            <h2 className="text-[28px] md:text-[40px] font-semibold tracking-[-0.025em] leading-[1.1] mb-4">
              Agent commerce needs a wallet control layer.
            </h2>
            <p className="text-[16px] leading-relaxed text-white/75">
              The market is forming around autonomous workflows, protocol-native
              payments, and stablecoin settlement. Haven sits where those forces meet.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-px rounded-[12px] overflow-hidden bg-white/10 border border-white/10 backdrop-blur">
            {WHY_NOW.map((item) => (
              <div key={item.title} className="bg-white/[0.04] px-6 py-7">
                <h3 className="text-[16px] font-semibold tracking-tight text-white mb-2">
                  {item.title}
                </h3>
                <p className="text-[14px] leading-relaxed text-white/70">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <BriefingSection
        eyebrow="Why stablecoins"
        title="The money layer for agents looks nothing like a bank."
        lede="Two properties matter for agent payments: rules a machine can verify, and settlement at machine speed. Stablecoins give us both."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {STABLECOIN_REASONS.map((item) => (
            <Card key={item.title} className="p-7" hover={false}>
              <h3 className="text-[15px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                {item.title}
              </h3>
              <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">{item.body}</p>
            </Card>
          ))}
        </div>
      </BriefingSection>

      <BriefingSection
        eyebrow="Market wedge"
        title="Start with agent payment control. Expand into the operating layer for agent spend."
        lede="Haven's wedge is narrow enough to build: controlled payments for agents. The broader opportunity is the account, rules, and audit system behind agent commerce."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 items-start">
          <Card className="p-7 md:p-8" hover={false}>
            <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-4">
              Differentiation
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {DIFFERENTIATORS.map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-3 rounded-[8px] border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-3"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] shrink-0" />
                  <span className="text-[13px] font-medium text-[var(--v2-ink)]">{item}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-7 md:p-8" hover={false}>
            <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-4">
              Current signal
            </div>
            <div className="space-y-5">
              <InvestorSignal
                title="Working product surface"
                body="The core account, agent, rules, approval, and transaction surfaces are taking shape in the product."
              />
              <InvestorSignal
                title="Protocol-aligned roadmap"
                body="The roadmap is directly tied to x402, MPP, and stablecoin flows rather than a generic wallet narrative."
              />
              <InvestorSignal
                title="Early investor and user conversations"
                body="The category is resonating in live conversations, with the next step being a sharper briefing and focused demos."
              />
            </div>
          </Card>
        </div>
      </BriefingSection>

      <BriefingSection
        id="model"
        eyebrow="Business model"
        title="Monetize the control point, not just the transfer."
        lede="Haven can charge for the policy-aware payment layer agents depend on: authorization, execution, routing, receipts, and controls."
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {MODEL_CARDS.map((card) => (
            <Card key={card.title} className="p-7" hover={false}>
              <h3 className="text-[15px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                {card.title}
              </h3>
              <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">{card.body}</p>
            </Card>
          ))}
        </div>
      </BriefingSection>

      <section
        data-v2-dark-section
        className="relative overflow-hidden text-white"
        style={{
          background:
            'radial-gradient(ellipse 80% 80% at 50% 0%, rgba(236,72,153,0.35) 0%, transparent 55%), linear-gradient(180deg, #4f46e5 0%, #4338ca 100%)',
        }}
      >
        <div className="relative max-w-6xl mx-auto px-6 py-20 md:py-28 text-center">
          <h2 className="text-[34px] md:text-[48px] font-semibold tracking-[-0.025em] leading-[1.1] mb-4 max-w-[740px] mx-auto">
            Haven is building the account layer for agents that pay.
          </h2>
          <p className="text-[16px] text-white/80 mb-9 max-w-[600px] mx-auto">
            For a deeper conversation on the product, roadmap, and fundraising path,
            contact Daniel directly.
          </p>
          <div className="flex justify-center">
            <a
              href={CONTACT_DANIEL_HREF}
              className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors h-12 px-6 text-[15px] bg-white text-[var(--v2-ink)] hover:bg-white/95 shadow-[0_1px_2px_rgba(16,24,40,0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-brand)]"
            >
              Contact Daniel
              <ArrowIcon />
            </a>
          </div>
        </div>
      </section>

      <InvestorFooter />
    </main>
  )
}

function InvestorHeader() {
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-[var(--v2-border)]">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="#thesis" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-[var(--v2-ink)]">
          <HavenMark />
          <span>Haven</span>
          <span className="hidden sm:inline text-[13px] font-medium text-[var(--v2-ink-3)]">
            Investor briefing
          </span>
        </a>

        <nav className="hidden md:flex items-center gap-7 text-[14px] font-medium text-[var(--v2-ink)]">
          {NAV_ITEMS.map((item) => (
            <a key={item.href} href={item.href} className="hover:text-[var(--v2-brand)] transition-colors">
              {item.label}
            </a>
          ))}
        </nav>

        <InvestorButton href={CONTACT_DANIEL_HREF} variant="primary" size="sm">
          Contact Daniel
        </InvestorButton>
      </div>
    </header>
  )
}

function InvestorFooter() {
  return (
    <footer className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]">
      <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between text-[12px] text-[var(--v2-ink-3)]">
        <div className="flex items-center gap-2">
          <HavenMark className="h-4 w-4" />
          <span>Haven Labs</span>
        </div>
        <span>Unlisted investor briefing. No product access from this page.</span>
      </div>
    </footer>
  )
}

function BriefingSection({
  id,
  eyebrow,
  title,
  lede,
  children,
  className = '',
}: {
  id?: string
  eyebrow: string
  title: ReactNode
  lede?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} className={className}>
      <div className="max-w-6xl mx-auto px-6 py-20 md:py-24">
        <div className="mb-12 max-w-3xl">
          <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-3">
            {eyebrow}
          </div>
          <h2 className="text-[28px] md:text-[34px] font-semibold tracking-[-0.02em] leading-[1.15] text-[var(--v2-ink)] mb-4">
            {title}
          </h2>
          {lede && (
            <p className="text-[16px] leading-relaxed text-[var(--v2-ink-2)] max-w-[680px]">
              {lede}
            </p>
          )}
        </div>
        {children}
      </div>
    </section>
  )
}

function InvestorButton({
  href,
  children,
  variant,
  size = 'lg',
}: {
  href: string
  children: ReactNode
  variant: 'primary' | 'ghost'
  size?: 'sm' | 'lg'
}) {
  const sizeClass = size === 'sm' ? 'h-9 px-3.5 text-[13px]' : 'h-11 px-5 text-[15px]'
  const variantClass =
    variant === 'primary'
      ? 'bg-[var(--v2-brand)] text-white hover:bg-[var(--v2-brand-strong)] shadow-[var(--v2-shadow-button)]'
      : 'bg-white text-[var(--v2-ink)] border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)]'

  return (
    <a
      href={href}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] ${sizeClass} ${variantClass}`}
    >
      {children}
      <ArrowIcon />
    </a>
  )
}

function ArrowIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
      <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ControlSurfaceMock() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-6 -z-10 rounded-[24px] opacity-70 blur-2xl"
        style={{
          background:
            'radial-gradient(circle, rgba(79,70,229,0.22), transparent 62%)',
        }}
      />
      <div className="rounded-[14px] border border-[var(--v2-border)] bg-white shadow-[0_24px_48px_-24px_rgba(16,24,40,0.18),0_2px_6px_-2px_rgba(16,24,40,0.06)] overflow-hidden">
        <div className="flex items-center justify-between px-5 h-12 border-b border-[var(--v2-border)]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--v2-brand)]" />
            <span className="text-[12px] font-medium text-[var(--v2-ink-2)]">
              Haven control surface
            </span>
          </div>
          <span className="text-[11px] font-mono text-[var(--v2-ink-3)] v2-tabular">
            acct_base_01
          </span>
        </div>

        <div className="p-5 md:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
            <MiniMetric label="Available" value="$8,420" footer="USDC on Base" />
            <MiniMetric label="Agent spend" value="$312" footer="This cycle" />
            <MiniMetric label="Approvals" value="2" footer="Needs review" />
          </div>

          <div className="rounded-[10px] border border-[var(--v2-border)] overflow-hidden">
            <div className="px-4 py-3 bg-[var(--v2-surface)] border-b border-[var(--v2-border)] flex items-center justify-between gap-4">
              <div>
                <div className="text-[13px] font-semibold tracking-tight text-[var(--v2-ink)]">
                  Research agent
                </div>
                <div className="text-[11px] text-[var(--v2-ink-3)] font-mono mt-0.5">
                  agt_research_ops
                </div>
              </div>
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-[var(--v2-success-soft)] text-[var(--v2-success)]">
                Connected
              </span>
            </div>

            <div className="divide-y divide-[var(--v2-border)] bg-white">
              <SurfaceRow label="Budget" value="$500 / day" status="Active" tone="brand" />
              <SurfaceRow label="Reset window" value="Daily" status="Active" tone="brand" />
              <SurfaceRow label="Latest request" value="23.40 USDC" status="Approved" tone="success" />
            </div>
          </div>

          <div className="mt-5 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface-code)] p-4 text-white">
            <div className="flex items-center justify-between gap-4 mb-3">
              <span className="text-[12px] font-medium text-white/80">Payment intent</span>
              <span className="text-[11px] font-mono text-white/45">POST /payments</span>
            </div>
            <div className="space-y-2 font-mono text-[12px] leading-relaxed text-white/78">
              <div>{'{ token: "USDC", amount: "23.40",'}</div>
              <div>{'  protocol: "x402", agent: "research" }'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function MiniMetric({ label, value, footer }: { label: string; value: string; footer: string }) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
      <div className="text-[11px] text-[var(--v2-ink-3)]">{label}</div>
      <div className="mt-2 text-[24px] font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
        {value}
      </div>
      <div className="text-[12px] text-[var(--v2-ink-2)] mt-1">{footer}</div>
    </div>
  )
}

function SurfaceRow({
  label,
  value,
  status,
  tone,
}: {
  label: string
  value: string
  status: string
  tone: 'brand' | 'success'
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
      : 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[12px] text-[var(--v2-ink-3)]">{label}</div>
        <div className="text-[14px] font-medium text-[var(--v2-ink)] truncate">{value}</div>
      </div>
      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 ${toneClass}`}>
        {status}
      </span>
    </div>
  )
}

function RulesTrace() {
  const steps = [
    {
      step: '01',
      title: 'Agent requests payment',
      detail: 'Research agent asks to pay 23.40 USDC for a gated data pull.',
      tone: 'brand',
    },
    {
      step: '02',
      title: 'Rules checked',
      detail: 'Within the per‑currency budget and below the manual‑approval threshold.',
      tone: 'brand',
    },
    {
      step: '03',
      title: 'Payment settles',
      detail: 'The payment goes through from the user‑controlled wallet and proof returns to the agent.',
      tone: 'success',
    },
    {
      step: '04',
      title: 'Receipt recorded',
      detail: 'The user can review the request, rule decision, transaction, and receipt later.',
      tone: 'success',
    },
  ] as const

  return (
    <Card className="p-0 overflow-hidden" hover={false}>
      <div className="px-6 py-5 border-b border-[var(--v2-border)] flex items-center justify-between gap-4">
        <div>
          <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-1">
            Rules trace
          </div>
          <h3 className="text-[18px] font-semibold tracking-tight text-[var(--v2-ink)]">
            One payment, every decision visible.
          </h3>
        </div>
        <span className="hidden sm:inline-flex text-[11px] px-2 py-1 rounded-full bg-[var(--v2-success-soft)] text-[var(--v2-success)] font-medium">
          Settled
        </span>
      </div>
      <ol className="divide-y divide-[var(--v2-border)]">
        {steps.map((item) => (
          <li key={item.step} className="flex items-start gap-4 px-6 py-5">
            <span className="text-[12px] text-[var(--v2-ink-3)] v2-tabular w-8 pt-0.5">
              {item.step}
            </span>
            <span
              className={`w-1.5 h-1.5 rounded-full mt-2 shrink-0 ${
                item.tone === 'success' ? 'bg-[var(--v2-success)]' : 'bg-[var(--v2-brand)]'
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-[var(--v2-ink)]">{item.title}</div>
              <div className="text-[13px] leading-relaxed text-[var(--v2-ink-2)] mt-1">
                {item.detail}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="px-6 py-4 border-t border-[var(--v2-border)] bg-[var(--v2-surface)] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[12px]">
        <span className="text-[var(--v2-ink-2)]">Agent never receives unlimited authority over the wallet.</span>
        <span className="font-mono text-[var(--v2-ink-3)]">tx 0x7a9e...d8e9</span>
      </div>
    </Card>
  )
}

function InvestorSignal({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-2 w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] shrink-0" />
      <div>
        <h3 className="text-[14px] font-semibold tracking-tight text-[var(--v2-ink)]">
          {title}
        </h3>
        <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)] mt-1">{body}</p>
      </div>
    </div>
  )
}
