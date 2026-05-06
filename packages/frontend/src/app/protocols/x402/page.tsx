import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'
import { Button } from '@/components/ui/Button'
import { Section } from '@/components/marketing/Section'
import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { HeroBackdrop } from '@/components/marketing/HeroBackdrop'
import { ProtocolPlayground } from '@/components/marketing/ProtocolPlayground'

const PROTOCOL_LINES = [
  { step: '01', title: 'Request → 402', detail: 'Server asks for payment.' },
  { step: '02', title: 'Pay → proof', detail: 'Client signs and settles on‑chain.' },
  { step: '03', title: 'Retry → 200', detail: 'Server returns the resource.' },
]

const TIMELINE = [
  { step: '01', label: 'Agent requested premium research data', detail: 'GET api.research.example/query?q=…', tone: 'neutral' },
  { step: '02', label: 'Server responded 402 Payment Required', detail: '0.05 USDC on Base → 0x4F3e…3bcFc', tone: 'warning' },
  { step: '03', label: 'Agent forwarded challenge to Haven', detail: 'POST /x402/authorize · sk_agent_d4c8…9f', tone: 'brand' },
  { step: '04', label: 'Rules checked', detail: 'Per‑payment limit · network allowlist · allowance', tone: 'brand' },
  { step: '05', label: 'Rules cleared — Haven signed the transfer', detail: 'sign_hash 0x8b2f4e93…2c6d4e8f', tone: 'brand' },
  { step: '06', label: 'Allowance transfer submitted to Base', detail: 'Safe → ERC‑20 via AllowanceModule', tone: 'brand' },
  { step: '07', label: 'Confirmed in block 14,892,103', detail: 'tx 0x7a9e3b1d…b6c7d8e9 · gas 41,228', tone: 'success' },
  { step: '08', label: 'Agent retried with proof — data delivered', detail: '200 OK · research.json', tone: 'success' },
] as const

const TONE_DOT: Record<string, string> = {
  neutral: 'bg-[var(--v2-ink-3)]',
  warning: 'bg-[var(--v2-warning)]',
  brand: 'bg-[var(--v2-brand)]',
  success: 'bg-[var(--v2-success)]',
}

export default function X402() {
  return (
    <>
      <SiteHeader />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <HeroBackdrop variant="soft" />
        <div className="relative max-w-6xl mx-auto px-6 pt-20 md:pt-24 pb-10">
        <div className="inline-flex items-center gap-2 mb-6 px-2.5 py-1 rounded-full border border-[var(--v2-border)] bg-white/80 backdrop-blur text-[12px] text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
          How x402 works
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
            pay the internet
          </span>
          .
        </h1>
        <p className="text-[17px] leading-relaxed text-[var(--v2-ink-2)] max-w-[640px]">
          An agent hits a paywall. Just seconds later it has the data — no card, no human, no key.
          One HTTP 402 becomes a settled transaction on Base.
        </p>
        </div>
      </section>

      {/* What is x402 */}
      <section className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]">
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
          <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-3">
            The standard
          </div>
          <h2 className="text-[28px] md:text-[34px] font-semibold tracking-[-0.02em] leading-[1.15] text-[var(--v2-ink)] mb-10 max-w-[680px]">
            What is x402?
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-8 items-start">
            <div className="space-y-5 text-[16px] leading-relaxed text-[var(--v2-ink-2)] max-w-[640px]">
              <p>
                <span className="text-[var(--v2-ink)] font-medium">x402</span> is an open payment standard
                built on top of the long‑dormant <span className="font-mono text-[var(--v2-ink)]">HTTP 402 Payment Required</span> status
                code. Originally proposed by Coinbase, it lets any web service charge for a single request — no account, no API key,
                no card on file. The client pays a small amount in stablecoin, attaches the proof, and the server unlocks the resource.
              </p>
              <p>
                That's the unlock for agentic workflows. Agents discover and use tools the same way humans browse the web: one request
                at a time, often across services they've never seen before. With x402, an agent can pay per call for an API, a piece of
                data, or a unit of compute — programmatically, without a human in the checkout loop.
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
            </Card>
          </div>
        </div>
      </section>

      {/* Flow diagram */}
      <Section eyebrow="The flow" title="One x402 payment, four actors.">
        <ProtocolPlayground kind="x402" />
      </Section>

      {/* Code sample */}
      <Section
        eyebrow="In code"
        title="One call to authorize. Haven does the rest."
        lede="Forward the 402 challenge. Haven checks the rules, signs from the Safe, and returns the proof you attach to the retry."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <CodeBlock filename="x402-client.ts" language="ts">{`const challenge = await fetch(url).then(r => r.json())

const proof = await haven.x402.authorize({
  agent: 'agt_research',
  challenge,
})

const data = await fetch(url, {
  headers: { 'X-PAYMENT': proof.token },
}).then(r => r.json())`}</CodeBlock>
      </Section>

      {/* Timeline */}
      <Section eyebrow="Execution trace" title="What actually happened.">
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
          <h2 className="text-[28px] md:text-[36px] font-semibold tracking-[-0.025em] leading-[1.1] text-[var(--v2-ink)] mb-3 max-w-[640px] mx-auto">
            Build an agent that pays its own way.
          </h2>
          <p className="text-[15px] text-[var(--v2-ink-2)] mb-8">
            Rules, approvals, and receipts included. Keys optional.
          </p>
          <Button href="/signup" size="lg" trailingIcon>Get early access</Button>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}
