import Link from 'next/link'
import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Section } from '@/components/marketing/Section'
import { HeroBackdrop } from '@/components/marketing/HeroBackdrop'

const PROTOCOLS = [
  {
    rail: 'HTTP paywalls',
    name: 'x402',
    title: 'x402 — pay-per-request HTTP',
    body:
      'A server returns 402, the agent asks Haven to pay, and the request is retried with proof. Haven checks the payment against your agent rules before anything settles.',
    href: '/protocols/x402',
    cta: 'See the x402 flow',
  },
  {
    rail: 'Stablecoin checkout',
    name: 'MPP',
    title: 'Stripe MPP — agent-initiated payments',
    body:
      "Stripe's Machine Payments Protocol gives agents a standard way to pay merchants. Haven implements the stablecoin path today under the same agent rules layer.",
    href: '/protocols/mpp',
    cta: 'See the MPP flow',
  },
] as const

export default function ProtocolsPage() {
  return (
    <>
      <SiteHeader />

      <section className="relative overflow-hidden">
        <HeroBackdrop variant="soft" />
        <div className="relative max-w-6xl mx-auto px-6 pt-20 md:pt-28 pb-16 md:pb-20">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 mb-6 px-2.5 py-1 rounded-full border border-[var(--v2-border)] bg-white/80 backdrop-blur text-[12px] text-[var(--v2-ink-2)] shadow-[var(--v2-shadow-card)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] animate-pulse" />
              Protocol native
            </div>

            <h1 className="text-[44px] md:text-[60px] font-semibold tracking-[-0.03em] leading-[1.04] text-[var(--v2-ink)] mb-6">
              One set of rules.
              <br />
              Multiple payment rails.
            </h1>

            <p className="text-[17px] md:text-[18px] leading-relaxed text-[var(--v2-ink-2)] max-w-[620px]">
              Haven speaks the open standards agents need for commerce: x402 for pay-per-request flows and MPP for broader merchant payments. Stablecoins today, fiat rails next.
            </p>
          </div>
        </div>
      </section>

      <Section
        eyebrow="Supported protocols"
        title="Two flows, one Haven account."
        lede="Agents can pay across standards without raw keys, shared cards, or one-off payment logic."
        className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)]"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {PROTOCOLS.map((protocol) => (
            <Card
              key={protocol.name}
              hover={false}
              className="p-7 hover:border-[var(--v2-brand)]/40 hover:shadow-[0_12px_32px_-16px_rgba(79,70,229,0.30)] transition-all group"
            >
              <Link href={protocol.href} className="block">
                <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-4">
                  {protocol.rail}
                </div>
                <h2 className="text-[20px] font-semibold tracking-tight text-[var(--v2-ink)] mb-3">
                  {protocol.title}
                </h2>
                <p className="text-[15px] leading-relaxed text-[var(--v2-ink-2)] mb-6">
                  {protocol.body}
                </p>
                <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--v2-brand)] group-hover:gap-2 transition-all">
                  {protocol.cta}
                  <span aria-hidden>→</span>
                </span>
              </Link>
            </Card>
          ))}
        </div>
      </Section>

      <section
        data-v2-dark-section
        className="relative overflow-hidden text-white"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 20% 0%, rgba(124,58,237,0.55) 0%, transparent 60%), radial-gradient(ellipse 70% 70% at 100% 100%, rgba(236,72,153,0.45) 0%, transparent 55%), linear-gradient(180deg, #1e1b4b 0%, #2e2a78 100%)',
        }}
      >
        <div className="relative max-w-6xl mx-auto px-6 py-16 md:py-20 flex flex-col md:flex-row md:items-center md:justify-between gap-8">
          <div>
            <div className="text-[12px] font-medium tracking-tight text-fuchsia-200 mb-3">
              <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-300 inline-block mr-2" />
              Build with Haven
            </div>
            <h2 className="text-[28px] md:text-[40px] font-semibold tracking-[-0.025em] leading-[1.1]">
              Give agents payment rails they can actually use.
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button href="/signup" size="lg" trailingIcon>Get early access</Button>
            <Button href="/how-it-works" variant="ghost" size="lg">How it works</Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}
