import { BrandBandButton } from '@/components/marketing/BrandBandButton'
import { Header } from '../Header'
import { Footer } from '../Footer'
import { SiteSection, SITE_TYPE } from '../SiteSection'
import {
  PaymentFlow,
  SideCard,
  SiteCopy,
  SiteCtaRow,
  SiteHero,
  SiteLede,
  SiteSplit,
  type FlowStep,
} from '../blocks'

/**
 * The redesigned protocols sub-page, `/how-it-works/protocols` (#3576, epic
 * #3572), built from `docs/product/site-mockup/protocols.html`. It replaces
 * the three `/protocols*` pages, which slice 7 (#3579) deletes and redirects
 * here; until then it exists only where `isNewSiteVisible()` is on.
 *
 * One payment flow and two protocol cards, no interactive playground (epic
 * decision 3). Where the mockup's copy disagreed with the code it was
 * corrected, and the PR lists each correction with its source:
 *
 *  - the agent signs EIP-712 typed data, never a bare hash, so the mockup's
 *    "sign_hash 0x8b2f…" is not shown (`CLAUDE.md` § Payment Flow);
 *  - under the preferred ERC-7710 scheme the merchant redeems the delegation
 *    chain, so the flow claims neither "Haven relays" nor "gas sponsored by
 *    Haven" for every payment;
 *  - MPP is next, never live (epic decision 4), and its settlement is not
 *    described beyond that.
 */

/**
 * The preferred ERC-7710 path, and labelled so: the merchant redeems the
 * delegation chain, and the chain checks the budget, on the agent's retry.
 * The EIP-3009 bridge meters the budget at its funding leg instead, before the
 * retry (`modules/x402/delegation-authorize.ts`); the paragraph beside the
 * flow names it.
 */
const X402_STEPS: ReadonlyArray<FlowStep> = [
  { tone: 'neutral', title: 'Agent requests premium research data', detail: 'GET api.research.example/query?q=…' },
  { tone: 'warning', title: 'Server responds 402 Payment Required', detail: '0.05 USDC on Base → 0x4F3e…3bcFc' },
  { tone: 'brand', title: 'Agent forwards the challenge to Haven', detail: 'POST /x402/authorize' },
  { tone: 'brand', title: 'Budget checked', detail: 'within period budget · recipient allowed' },
  { tone: 'brand', title: 'Agent signs the payment locally', detail: 'EIP-712 typed data · the key never leaves it' },
  { tone: 'brand', title: 'Agent retries with the signed payment', detail: 'PAYMENT-SIGNATURE header' },
  {
    tone: 'success',
    title: 'Merchant settles from your account on Base, data delivered',
    detail: 'tx 0x7a9e…d8e9 · budget enforced on-chain · 200 OK',
  },
]

const ACTORS = ['Agent', 'Merchant', 'Haven', 'On-chain budget'] as const

const COMPARISON: ReadonlyArray<readonly [string, string, string]> = [
  ['Who starts the payment', 'The merchant, with a 402 challenge', 'The agent, with a payment intent'],
  ['Typical purchase', 'Per-request API calls, data, compute, paywalled content', 'Subscriptions, one-off orders, checkout flows'],
  ['Settlement', 'USDC on Base, from your account', 'Not yet supported at Haven'],
  ['Status at Haven', 'Live on Base', 'Next'],
  ['Your budget, receipt and books', 'Unchanged', 'Unchanged'],
]

export function ProtocolsPage() {
  return (
    <>
      <Header overlay />
      <main>
        <SiteHero
          titleId="protocols-hero-title"
          crumb={{ label: 'How it works', href: '/how-it-works', current: 'Protocols' }}
          eyebrow="Protocols"
          title="Two protocols. One budget. Same receipt."
          lede="Haven sits on the buy side of both: it lets your agent pay within a budget. x402 is live. Stripe's MPP is next."
        />

        <SiteSection aria-labelledby="protocols-flow">
          <SiteSplit>
            <SiteCopy eyebrow="The flow" title="One payment, four actors." titleId="protocols-flow">
              <SiteLede>
                A price is named, Haven checks it against the budget, the agent signs locally and retries, the merchant
                settles from your account while the chain enforces the budget, and the merchant delivers.
              </SiteLede>
              <ul aria-label="Actors" className="mt-4 flex flex-wrap gap-2">
                {ACTORS.map((actor) => (
                  <li
                    key={actor}
                    className="rounded-full border border-[var(--v2-border)] bg-[var(--v2-bg)] px-2.5 py-1 text-[12px] text-[var(--v2-ink-2)]"
                  >
                    {actor}
                  </li>
                ))}
              </ul>
              <p className="mt-6 max-w-[56ch] text-[14px] text-[var(--v2-ink-2)]">
                Haven prefers the ERC-7710 scheme, where the merchant redeems a one-payment delegation drawn from your
                agent&apos;s budget. Where a merchant does not support it, an agent with an open budget pays through an
                EIP-3009 bridge instead; an agent pinned to one recipient pays by ERC-7710 only.
                Either way the money moves from your account and the budget is enforced on-chain.
              </p>
            </SiteCopy>
            <PaymentFlow label={'x402 payment flow · ERC\u20117710'} amount="0.05 USDC · Base" steps={X402_STEPS} />
          </SiteSplit>
        </SiteSection>

        <SiteSection ground="tint" aria-labelledby="protocols-sides">
          <p className={SITE_TYPE.eyebrow}>Side by side</p>
          <h2 id="protocols-sides" className={SITE_TYPE.h2}>
            What each protocol is, and what changes for you.
          </h2>
          <div className="mt-11 grid grid-cols-1 gap-5 min-[820px]:grid-cols-2">
            <SideCard kicker="x402 · live" title="Pay-per-request over HTTP">
              An open standard for paying over HTTP. A server answers with 402 and a price; the client pays and
              retries with proof. x402 merchants on Base that take USDC work with Haven today.
            </SideCard>
            <SideCard kicker="Stripe MPP · next" title="Agent-initiated commerce">
              Stripe&apos;s Machine Payments Protocol covers purchases an agent and a merchant coordinate:
              subscriptions, orders, checkout. Haven support is next.
            </SideCard>
          </div>
          {/*
            The comparison. From 640px it is the mockup's table, without the
            mockup's forced 640px minimum, so its three short columns wrap and
            nothing scrolls. Below 640px a scrolling table hid the MPP column
            behind clipped text (design review, #3576), so phones get the same
            rows stacked: each aspect, then x402, then Stripe MPP. Only one of
            the two is displayed at a time, so a screen reader meets it once.
          */}
          <div className="mt-11 hidden overflow-hidden rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)] sm:block">
            <table className="w-full border-collapse text-left text-[14.5px]">
              <caption className="sr-only">x402 and Stripe MPP compared</caption>
              <thead>
                <tr className="bg-[var(--v2-table-header-bg)] text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--v2-table-header-ink)]">
                  <th scope="col" className="w-[26%] px-5 py-4">
                    <span className="sr-only">Aspect</span>
                  </th>
                  <th scope="col" className="px-5 py-4">
                    x402
                  </th>
                  <th scope="col" className="px-5 py-4">
                    Stripe MPP
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map(([aspect, x402, mpp]) => (
                  <tr key={aspect} className="border-t border-[var(--v2-border)] align-top">
                    <th scope="row" className="px-5 py-4 font-medium text-[var(--v2-ink-2)]">
                      {aspect}
                    </th>
                    <td className="px-5 py-4 text-[var(--v2-ink)]">{x402}</td>
                    <td className="px-5 py-4 text-[var(--v2-ink)]">{mpp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul
            aria-label="x402 and Stripe MPP compared"
            data-comparison-stacked=""
            className="mt-11 overflow-hidden rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)] sm:hidden"
          >
            {COMPARISON.map(([aspect, x402, mpp]) => (
              <li key={aspect} className="border-t border-[var(--v2-border)] px-5 py-4 first:border-t-0">
                <p className="text-[13px] font-medium text-[var(--v2-ink-2)]">{aspect}</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[14.5px]">
                  <dt className="text-[12px] font-semibold uppercase tracking-[0.06em] leading-[1.9] text-[var(--v2-ink-3)]">
                    x402
                  </dt>
                  <dd className="text-[var(--v2-ink)]">{x402}</dd>
                  <dt className="text-[12px] font-semibold uppercase tracking-[0.06em] leading-[1.9] text-[var(--v2-ink-3)]">
                    Stripe MPP
                  </dt>
                  <dd className="text-[var(--v2-ink)]">{mpp}</dd>
                </dl>
              </li>
            ))}
          </ul>
          <p className="mt-[22px] text-[14px] text-[var(--v2-ink-2)]">
            <b className="text-[var(--v2-ink)]">Rails, not rivals.</b> Haven is buy side only: it refuses, caps and
            accounts for a payment, whichever rail carries it.
          </p>
        </SiteSection>

        <SiteSection ground="indigo" className="text-center" aria-labelledby="protocols-close">
          <h2 id="protocols-close" className={`${SITE_TYPE.h2} mx-auto max-w-[20ch]`}>
            Build an agent that pays its own way.
          </h2>
          <p className={`${SITE_TYPE.lede} mx-auto mt-[18px]`}>Budgets, refusals and receipts included.</p>
          <SiteCtaRow center>
            <BrandBandButton href="/signup" trailingArrow>
              Create your account
            </BrandBandButton>
            {/* The mockup's ghost CTA (protocols.html:96), landed with its
                destination in #3577. */}
            <BrandBandButton href="/developers" variant="translucent">
              For developers
            </BrandBandButton>
          </SiteCtaRow>
        </SiteSection>
      </main>
      <Footer />
    </>
  )
}
