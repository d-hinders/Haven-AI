import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'
import { Button } from '@/components/ui/Button'
import { Section } from '@/components/marketing/Section'
import { Card } from '@/components/ui/Card'
import { HeroBackdrop } from '@/components/marketing/HeroBackdrop'

const STEPS = [
  {
    step: '01',
    title: 'Create your Haven account',
    body: 'Sign up with your email. No credit card and no setup call needed.',
    visual: 'account',
  },
  {
    step: '02',
    title: 'Choose how you sign in',
    body: 'Use Face ID / Touch ID or connect your wallet. Either way, you stay in control of your account.',
    visual: 'wallet',
  },
  {
    step: '03',
    title: 'Set up your Haven wallet',
    body: 'We create your Haven wallet in the background. This is where you hold the funds your agents can spend.',
    visual: 'vault',
  },
  {
    step: '04',
    title: 'Add funds',
    body: 'Add USDC, EURe, or another supported token to start making payments.',
    visual: 'fund',
  },
  {
    step: '05',
    title: 'Set agent rules',
    body: 'Choose how much an agent can spend, who it can pay, and what it can pay for.',
    visual: 'credentials',
  },
  {
    step: '06',
    title: 'Connect your agent',
    body: 'Add your Haven credential to Claude, GPT, or your own agent. It can now make payments within the rules you set.',
    visual: 'agent',
  },
] as const

const PROMISES = [
  { value: 'You stay in control', label: 'Haven never moves money on its own' },
  { value: 'Instant revoke', label: 'Stop an agent in one click' },
  { value: 'Full audit log', label: 'Every payment, every check' },
]

// ─── Quiet, illustrative visuals (no glow, no emoji, no animation) ───

function VisualAccount() {
  return (
    <Card className="p-5">
      <div className="text-[11px] uppercase tracking-wider text-[var(--v2-ink-3)] mb-3">Account</div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[14px] font-medium text-[var(--v2-ink)]">daniel@haven.run</div>
          <div className="text-[12px] text-[var(--v2-ink-3)]">Created just now</div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--v2-success-soft)] text-[var(--v2-success)] text-[11px] font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-success)]" />
          Verified
        </span>
      </div>
    </Card>
  )
}

function VisualWallet() {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[var(--v2-ink-3)] mb-1">Sign-in method</div>
          <div className="text-[13px] font-mono text-[var(--v2-ink)]">0xA1f2…29c4</div>
        </div>
        <svg className="w-5 h-5 text-[var(--v2-ink-3)]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M3 8h10M9.5 4.5L13 8 9.5 11.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="flex-1 text-right">
          <div className="text-[11px] uppercase tracking-wider text-[var(--v2-ink-3)] mb-1">Haven account</div>
          <div className="text-[13px] font-mono text-[var(--v2-brand)]">connected</div>
        </div>
      </div>
    </Card>
  )
}

function VisualVault() {
  return (
    <Card className="p-5">
      <div className="text-[11px] uppercase tracking-wider text-[var(--v2-ink-3)] mb-3">Haven wallet ready</div>
      <div className="text-[13px] font-mono text-[var(--v2-ink)] mb-1">0x4F3e…3bcFc</div>
      <div className="text-[12px] text-[var(--v2-ink-3)] mb-4">Gnosis Chain · ready to fund</div>
      <div className="flex items-center gap-2 text-[12px] text-[var(--v2-success)]">
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.5 11.2L3.8 8.5l-1 1L6.5 13.2 14 5.7l-1-1z" />
        </svg>
        Haven cannot move funds without your approval
      </div>
    </Card>
  )
}

function VisualFund() {
  const balances = [
    { sym: 'USDC', amt: '1,250.00', label: 'US Dollar Coin' },
    { sym: 'EURe', amt: '480.00', label: 'Monerium EUR' },
  ]
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-[var(--v2-border)] flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wider text-[var(--v2-ink-3)]">Balance</span>
        <span className="text-[20px] font-semibold text-[var(--v2-ink)] v2-tabular">$1,730.00</span>
      </div>
      <ul className="divide-y divide-[var(--v2-border)]">
        {balances.map((b) => (
          <li key={b.sym} className="flex items-center justify-between px-5 py-3">
            <div>
              <div className="text-[13px] font-medium text-[var(--v2-ink)]">{b.sym}</div>
              <div className="text-[11px] text-[var(--v2-ink-3)]">{b.label}</div>
            </div>
            <div className="text-[13px] text-[var(--v2-ink)] v2-tabular">{b.amt}</div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function VisualCredentials() {
  const rules: [string, string][] = [
    ['Daily limit', '500 USDC'],
    ['Per transaction', '50 USDC'],
    ['Allowed assets', 'USDC, EURe'],
  ]
  return (
    <Card className="p-5">
      <div className="text-[11px] uppercase tracking-wider text-[var(--v2-ink-3)] mb-3">Agent rules</div>
      <dl className="divide-y divide-[var(--v2-border)]">
        {rules.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between py-2 first:pt-0 last:pb-0 text-[13px]">
            <dt className="text-[var(--v2-ink-2)]">{k}</dt>
            <dd className="text-[var(--v2-ink)] font-medium v2-tabular">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 pt-4 border-t border-[var(--v2-border)] flex items-center justify-between">
        <code className="text-[12px] font-mono text-[var(--v2-ink-2)]">sk_live_••••9aF2</code>
        <button className="text-[12px] font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]">Copy</button>
      </div>
    </Card>
  )
}

function VisualAgent() {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-[var(--v2-ink-3)]">Receipt</div>
          <div className="text-[13px] text-[var(--v2-ink)] v2-tabular mt-1">api.research.example</div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--v2-success-soft)] text-[var(--v2-success)] text-[11px] font-medium">
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 11.2L3.8 8.5l-1 1L6.5 13.2 14 5.7l-1-1z" /></svg>
          Settled
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[24px] font-semibold text-[var(--v2-ink)] v2-tabular">2.50</span>
        <span className="text-[13px] text-[var(--v2-ink-2)]">USDC</span>
      </div>
      <div className="text-[12px] text-[var(--v2-ink-3)] mt-3 font-mono truncate">tx 0x7a9e…d8e9 · block 14,892,103</div>
    </Card>
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

export default function HowItWorks() {
  return (
    <>
      <SiteHeader />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <HeroBackdrop variant="soft" />
        <div className="max-w-6xl mx-auto px-6 pt-20 md:pt-24 pb-12 relative">
        <div className="inline-flex items-center gap-2 mb-6 px-2.5 py-1 rounded-full border border-[var(--v2-border)] bg-white/80 backdrop-blur text-[12px] text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] animate-pulse" />
          Get started in minutes
        </div>
        <h1 className="text-[44px] md:text-[60px] font-semibold tracking-[-0.03em] leading-[1.04] text-[var(--v2-ink)] mb-5 max-w-[720px]">
          Empower your agent with{' '}
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage:
                'linear-gradient(110deg, #4f46e5 0%, #7c3aed 45%, #ec4899 100%)',
            }}
          >
            payment functionality
          </span>
          .
        </h1>
        <p className="text-[17px] md:text-[18px] leading-relaxed text-[var(--v2-ink-2)] max-w-[560px] mb-8">
          Your agent pays for things on its own — and you stay in control of every dollar.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button href="/signup" size="lg" trailingIcon>Get early access</Button>
          <Button href="/protocols/x402" variant="ghost" size="lg">See the protocols</Button>
        </div>
        </div>
      </section>

      {/* Steps */}
      <section className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]">
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
          <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-3">
            The six steps
          </div>
          <h2 className="text-[28px] md:text-[34px] font-semibold tracking-[-0.02em] leading-[1.15] text-[var(--v2-ink)] mb-10 max-w-[600px]">
            From zero to a paying agent.
          </h2>

          <ol className="space-y-5">
            {STEPS.map((s, i) => {
              const Visual = VISUALS[s.visual]
              const reverse = i % 2 === 1
              return (
                <li key={s.step}>
                  <Card className="p-7 md:p-10">
                    <div className={`grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center ${reverse ? 'md:[&>*:first-child]:order-2' : ''}`}>
                      <div>
                        <div className="text-[12px] font-medium text-[var(--v2-brand)] mb-3 v2-tabular">
                          Step {s.step}
                        </div>
                        <h3 className="text-[22px] md:text-[26px] font-semibold tracking-[-0.02em] leading-[1.2] text-[var(--v2-ink)] mb-3">
                          {s.title}
                        </h3>
                        <p className="text-[15px] leading-relaxed text-[var(--v2-ink-2)] max-w-[460px]">
                          {s.body}
                        </p>
                      </div>
                      <div>
                        <Visual />
                      </div>
                    </div>
                  </Card>
                </li>
              )
            })}
          </ol>
        </div>
      </section>

      {/* Promises */}
      <Section eyebrow="What you get" title="Three durable guarantees.">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {PROMISES.map((p) => (
            <Card key={p.value} className="p-7">
              <div className="text-[20px] font-semibold tracking-tight text-[var(--v2-ink)] mb-1">
                {p.value}
              </div>
              <div className="text-[14px] text-[var(--v2-ink-2)]">{p.label}</div>
            </Card>
          ))}
        </div>
      </Section>

      {/* CTA */}
      <section className="border-t border-[var(--v2-border)]">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-24 text-center">
          <h2 className="text-[28px] md:text-[36px] font-semibold tracking-[-0.025em] leading-[1.1] text-[var(--v2-ink)] mb-3 max-w-[600px] mx-auto">
            Ready to set up your first agent?
          </h2>
          <p className="text-[15px] text-[var(--v2-ink-2)] mb-8">
            No credit card. No setup call. Live in minutes.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button href="/signup" size="lg" trailingIcon>Get early access</Button>
            <Button href="/protocols/x402" variant="ghost" size="lg">See the protocols</Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}
