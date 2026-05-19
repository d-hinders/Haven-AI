import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'
import { Button } from '@/components/ui/Button'
import { Section } from '@/components/marketing/Section'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { HeroBackdrop } from '@/components/marketing/HeroBackdrop'
import { ProtocolPlayground } from '@/components/marketing/ProtocolPlayground'

const PROTOCOL_LINES = [
  { step: '01', title: 'Intent → authorization', detail: 'Haven checks against your agent rules.' },
  { step: '02', title: 'Present → pay', detail: 'Stablecoin transfer or scoped fiat credential.' },
  { step: '03', title: 'Capture → fulfil', detail: 'Merchant confirms, fulfils, Haven logs.' },
]

const TIMELINE = [
  { step: '01', label: 'Agent drafted payment intent', detail: 'Insightly Pro · 29.00 USDC → 0x4F3e…3bcFc', tone: 'neutral' },
  { step: '02', label: 'Agent forwarded intent to Haven', detail: 'POST /mpp/authorize · sk_agent_a1b9…7e', tone: 'brand' },
  { step: '03', label: 'Rules checked', detail: 'Per‑payment limit · network allowlist · allowance', tone: 'brand' },
  { step: '04', label: 'Rules cleared — Haven signed the transfer', detail: 'sign_hash 0x6c1f4e93…2c6d9b3a', tone: 'brand' },
  { step: '05', label: 'Allowance transfer submitted to Base', detail: 'Safe → ERC‑20 via AllowanceModule', tone: 'brand' },
  { step: '06', label: 'Confirmed in block 14,892,103', detail: 'tx 0x4d8a3b1d…b6c7e2f8 · gas 41,228', tone: 'success' },
  { step: '07', label: 'Merchant verified receipt — access granted', detail: '200 OK · Insightly Pro — 1 month', tone: 'success' },
] as const

const TONE_DOT: Record<string, string> = {
  neutral: 'bg-[var(--v2-ink-3)]',
  warning: 'bg-[var(--v2-warning)]',
  brand: 'bg-[var(--v2-brand)]',
  success: 'bg-[var(--v2-success)]',
}

const RAILS = [
  { name: 'Stablecoin', detail: 'USDC on Base, Gnosis. Settled on‑chain from your Haven account.', status: 'Live today' },
  { name: 'Cards & wallets', detail: 'Visa, Mastercard, Apple Pay, Google Pay via Stripe SPT.', status: 'Coming soon' },
  { name: 'BNPL', detail: 'Buy now, pay later flows via Stripe Shared Payment Tokens.', status: 'Coming soon' },
]

export default function MPP() {
  return (
    <>
      <SiteHeader />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <HeroBackdrop variant="soft" />
        <div className="relative max-w-6xl mx-auto px-6 pt-20 md:pt-24 pb-10">
        <div className="inline-flex items-center gap-2 mb-6 px-2.5 py-1 rounded-full border border-[var(--v2-border)] bg-white/80 backdrop-blur text-[12px] text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
          How Stripe MPP works
        </div>
        <h1 className="text-[44px] md:text-[60px] font-semibold tracking-[-0.03em] leading-[1.04] text-[var(--v2-ink)] mb-5 max-w-[720px]">
          Watch an AI agent{' '}
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage:
                'linear-gradient(110deg, #4f46e5 0%, #7c3aed 45%, #ec4899 100%)',
            }}
          >
            check out in stablecoins
          </span>
          .
        </h1>
        <p className="text-[17px] leading-relaxed text-[var(--v2-ink-2)] max-w-[640px]">
          An agent subscribes to a SaaS tool. Haven checks the payment against your agent rules and
          settles in USDC straight from your Haven account — no card details in agent memory, no
          unrestricted credentials, full audit trail.
        </p>
        </div>
      </section>

      {/* What is MPP */}
      <section className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]">
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
          <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-3">
            The standard
          </div>
          <h2 className="text-[28px] md:text-[34px] font-semibold tracking-[-0.02em] leading-[1.15] text-[var(--v2-ink)] mb-10 max-w-[680px]">
            What is MPP?
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-8 items-start">
            <div className="space-y-5 text-[16px] leading-relaxed text-[var(--v2-ink-2)] max-w-[640px]">
              <p>
                <span className="text-[var(--v2-ink)] font-medium">Stripe MPP</span> — the Machine
                Payments Protocol — is an open standard for agent‑initiated payments across rails.
                It supports direct on‑chain crypto payments as well as fiat methods such as cards,
                wallets, and BNPL through Stripe <span className="font-mono text-[var(--v2-ink)]">Shared Payment Tokens</span>.
              </p>
              <p>
                Where x402 focuses on programmatic HTTP 402 payment flows, MPP extends the same
                machine‑payment idea into broader agent commerce — one‑off purchases,
                subscriptions, and other payments an agent and a merchant need to coordinate.
              </p>
              <p>
                Haven supports the stablecoin path: agents settle USDC directly to merchants from
                your Haven account, gated by the same rules, approval, and audit model that wraps x402.
                SPT‑backed fiat rails are on the roadmap.
              </p>
            </div>
            <Card className="p-6">
              <div className="text-[12px] font-medium tracking-tight text-[var(--v2-ink-3)] mb-4 uppercase">
                The protocol in 3 lines
              </div>
              <ol className="space-y-4">
                {PROTOCOL_LINES.map((p) => (
                  <li key={p.step} className="flex items-start gap-3">
                    <span className="text-[12px] font-mono text-[var(--v2-brand)] v2-tabular pt-0.5">{p.step}</span>
                    <div>
                      <div className="text-[14px] font-medium text-[var(--v2-ink)]">{p.title}</div>
                      <div className="text-[13px] text-[var(--v2-ink-2)]">{p.detail}</div>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-5 pt-4 border-t border-[var(--v2-border)] text-[12px] text-[var(--v2-ink-3)] leading-relaxed">
                Haven supports the <span className="text-[var(--v2-brand)] font-medium">stablecoin</span> path today.
                SPT‑backed fiat rails coming next.
              </div>
            </Card>
          </div>
        </div>
      </section>

      {/* Flow diagram */}
      <Section eyebrow="The flow" title="One MPP payment, four actors.">
        <ProtocolPlayground kind="mpp" />
      </Section>

      {/* Rails table */}
      <Section
        eyebrow="The rails"
        title="One rules layer. Stablecoins today, fiat next."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <Card className="p-0 overflow-hidden">
          <ul className="divide-y divide-[var(--v2-border)]">
            {RAILS.map((r) => (
              <li key={r.name} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-3 md:gap-6 items-center px-6 py-5">
                <div className="text-[15px] font-semibold text-[var(--v2-ink)]">{r.name}</div>
                <div className="text-[14px] text-[var(--v2-ink-2)]">{r.detail}</div>
                <span
                  className={`justify-self-start md:justify-self-end inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                    r.status === 'Live today'
                      ? 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
                      : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]'
                  }`}
                >
                  {r.status === 'Live today' && <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-success)]" />}
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </Section>

      {/* Code sample */}
      <Section eyebrow="In code" title="One intent. Haven returns a settled receipt.">
        <CodeBlock filename="mpp-client.ts" language="ts">{`const receipt = await haven.mpp.authorize({
  agent: 'agt_ops',
  merchant: 'insightly',
  intent: {
    sku: 'pro_monthly',
    amount: '29.00',
    asset: 'USDC',
  },
})

// receipt.tx_hash, receipt.block_number, receipt.proof`}</CodeBlock>
      </Section>

      {/* Timeline */}
      <Section
        eyebrow="Execution trace"
        title="What actually happened."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <Card className="p-0 overflow-hidden">
          <ol className="divide-y divide-[var(--v2-border)]">
            {TIMELINE.map((ev) => (
              <li key={ev.step} className="flex items-start gap-4 px-6 py-4">
                <span className="text-[12px] text-[var(--v2-ink-3)] v2-tabular w-8 pt-0.5">{ev.step}</span>
                <span className={`w-1.5 h-1.5 rounded-full mt-2 shrink-0 ${TONE_DOT[ev.tone]}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-[var(--v2-ink)]">{ev.label}</div>
                  <div className="text-[12px] text-[var(--v2-ink-3)] mt-0.5 truncate font-mono">{ev.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </Section>

      {/* CTA */}
      <section className="border-t border-[var(--v2-border)]">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-24 text-center">
          <h2 className="text-[28px] md:text-[36px] font-semibold tracking-[-0.025em] leading-[1.1] text-[var(--v2-ink)] mb-3 max-w-[680px] mx-auto">
            One rules layer. Open standards. Stablecoin settlement.
          </h2>
          <p className="text-[15px] text-[var(--v2-ink-2)] mb-8">
            Same rules model as x402. No card numbers in agent memory.
          </p>
          <Button href="/signup" size="lg" trailingIcon>Get early access</Button>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}
