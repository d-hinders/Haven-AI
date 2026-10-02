import { Button } from '@haven_ai/ui/Button'
import { BrandBandButton } from '@/components/marketing/BrandBandButton'
import { TrailingArrow } from '@/components/marketing/TrailingArrow'
import { Header } from '../Header'
import { Footer } from '../Footer'
import { SiteSection, SITE_TYPE } from '../SiteSection'
import { FrameControl, ProductFrame } from '../ProductFrame'
import {
  AgentBudgetRow,
  CodePrompt,
  FramePill,
  NavyCard,
  PaymentFlow,
  SideCard,
  SiteCode,
  SiteCopy,
  SiteCtaRow,
  SiteHero,
  SiteLede,
  SiteSplit,
  SiteTextLink,
  type FlowStep,
} from '../blocks'

/**
 * The redesigned How it works page (#3576, epic #3572), built from
 * `docs/product/site-mockup/how-it-works.html` and rendered by
 * `app/how-it-works/page.tsx` when `isNewSiteVisible()` is on.
 *
 * Copy follows the mockup except where a claim had to be corrected against
 * the code; each correction and its source is listed in the PR. The mockup's
 * "Read the developer guide" (`/developers`) lands with that page in #3577,
 * per the epic's rule that an entry ships with its destination. The frames
 * are pictures of the product, so their text is fixture data and their
 * controls are non-interactive (`ProductFrame`'s body is `inert`).
 */

/**
 * The one payment walked through in section 4. Scheme-neutral on purpose:
 * under the preferred ERC-7710 scheme the merchant redeems the delegation
 * chain itself, so "Haven relays" and "gas sponsored by Haven" are not true
 * of every payment, and neither is said here. Settlement — and the on-chain
 * budget check with it — happens when the agent RETRIES with the signed
 * payment, in both schemes, so it comes after the retry, not before.
 */
const PAYMENT_STEPS: ReadonlyArray<FlowStep> = [
  { tone: 'neutral', title: 'The agent requests a paid resource', detail: 'GET api.research.example/query' },
  { tone: 'warning', title: 'The merchant asks for payment', detail: '402 Payment Required · 0.05 USDC on Base' },
  { tone: 'brand', title: "Haven checks it against the agent's budget", detail: '214.00 used of 250.00 · recipient allowed' },
  { tone: 'brand', title: 'The agent signs on its own machine', detail: 'the key never leaves it' },
  { tone: 'brand', title: 'The agent retries with the signed payment', detail: 'the merchant takes it from here' },
  {
    tone: 'success',
    title: 'Settled from your account to the merchant',
    detail: 'budget enforced on-chain · over budget reverts, nothing moves',
  },
  { tone: 'success', title: 'The agent gets the resource', detail: '200 OK · research.json' },
]

const SECURITY_CARDS: ReadonlyArray<{ title: string; body: string; link?: { label: string; href: string } }> = [
  { title: 'Funds stay in your account', body: 'Haven never holds funds, or a key that could move them.' },
  {
    title: 'Limits are enforced on-chain',
    body: 'An over-budget payment reverts at execution. It is not a rule in our database.',
  },
  {
    title: 'Nothing for an agent to leak',
    body: "An agent's credential cannot spend past its budget. If it is exposed, rotate it: the agent keeps its history and the old credential stops working.",
  },
  {
    title: 'An exit that needs no Haven',
    body: 'Inspect and revoke every budget with only your wallet and a public RPC.',
    link: { label: 'Open the exit page', href: '/exit' },
  },
  {
    title: 'Recovery you control',
    body: 'A backup passkey replaces a lost one. Every signer change is signed by you, never by Haven.',
  },
]

const CARD_LINK =
  'inline-flex items-center gap-1.5 rounded-[4px] font-medium text-[#a5b4fc] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161b3f]'

export function HowItWorksPage() {
  return (
    <>
      <Header overlay />
      <main>
        <SiteHero
          titleId="how-hero-title"
          eyebrow="How it works"
          title="From an empty account to an agent that pays for what it needs."
          lede="Five steps. None of them hands anyone your keys."
        />

        <SiteSection aria-labelledby="how-account">
          <SiteSplit>
            <SiteCopy eyebrow="1 · Your account" title="An account only you control." titleId="how-account">
              <SiteLede>
                One Face ID prompt creates a Haven account you own outright. No seed phrase, no credit card. Add USDC
                when your agents need it, and a backup passkey when you like.
              </SiteLede>
            </SiteCopy>
            <ProductFrame env="Operations" screen="Dashboard" className="w-full max-w-[420px] min-[900px]:justify-self-end">
              <div className="text-[12.5px] text-[var(--v2-ink-3)]">Total balance</div>
              <div className="my-1 [font-family:var(--font-site-display)] text-[34px] font-semibold tabular-nums tracking-[-0.02em]">
                $1,250.00
              </div>
              <div className="text-[12.5px] text-[var(--v2-success)]">+$25.00 today</div>
              <div className="mt-3.5 flex gap-2">
                <FrameControl variant="primary">Receive</FrameControl>
                <FrameControl>Add funds</FrameControl>
              </div>
              <div className="mt-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3 text-[12.5px] text-[var(--v2-ink-2)]">
                <b className="text-[var(--v2-ink)]">Add a backup soon.</b> Right now this account has one way to
                approve. Add a backup passkey or a wallet so a lost device never means a lost account.
              </div>
            </ProductFrame>
          </SiteSplit>
        </SiteSection>

        <SiteSection ground="tint" aria-labelledby="how-budgets">
          <SiteSplit>
            <ProductFrame env="Operations" screen="Agents" className="order-2 w-full max-w-[420px] min-[900px]:order-1">
              <AgentBudgetRow
                name="Atlas"
                role="Research agent"
                used="214.00"
                total="250.00"
                meta="Monthly budget · resets 11 Jul · any recipient"
              />
              <AgentBudgetRow
                name="Iris"
                role="Data-feed agent"
                used="5.00"
                total="500.00"
                meta="Monthly budget · resets 11 Jul · pinned to Klara Data AB"
              />
              <div className="mt-3.5 flex justify-end gap-2">
                <FrameControl>Pause</FrameControl>
                <FrameControl>Revoke</FrameControl>
              </div>
            </ProductFrame>
            <div className="order-1 min-[900px]:order-2">
              <SiteCopy
                eyebrow="2 · Budgets"
                title="A budget per agent, not a card for all of them."
                titleId="how-budgets"
              >
                <SiteLede>
                  An amount and a period per agent, optionally pinned to one recipient. You sign it once, it refills
                  itself, and you can pause or revoke it at any time.
                </SiteLede>
              </SiteCopy>
            </div>
          </SiteSplit>
        </SiteSection>

        <SiteSection aria-labelledby="how-connect">
          <SiteSplit>
            <SiteCopy eyebrow="3 · Connecting an agent" title="One command wires any agent in." titleId="how-connect">
              <SiteLede>
                Paste the setup prompt to Claude, Codex, Cursor or any other agent harness. The agent&apos;s key is made
                on its own machine, Haven never sees it, and you approve the budget with your passkey.
              </SiteLede>
            </SiteCopy>
            <ProductFrame env="Set up with your AI agent" screen="Copy" className="w-full">
              <SiteCode className="-m-4 !text-[12px]">
                {`I have a Haven account and I am signed in. Please set up Haven so you can pay for things within a budget I approve.

Start by reading /for-agents.md — it is written for you and explains which steps are mine.

Then run:
`}
                <CodePrompt />
                {`npx -y @haven_ai/connect@<channel> \\
    --setup hv_setup_… \\
    --api <api-url> --ack-local-tools`}
              </SiteCode>
            </ProductFrame>
          </SiteSplit>
        </SiteSection>

        <SiteSection ground="tint" aria-labelledby="how-pays">
          <SiteSplit>
            <div className="order-2 min-[900px]:order-1">
              <PaymentFlow label="One payment, start to finish" amount="0.05 USDC" steps={PAYMENT_STEPS} />
            </div>
            <div className="order-1 min-[900px]:order-2">
              <SiteCopy
                eyebrow="4 · When it pays"
                title="Seconds from paywall to result. No human in the loop."
                titleId="how-pays"
              >
                <SiteLede>
                  Haven checks the price against the budget before the agent signs. The agent signs locally, and the
                  chain enforces the budget when the payment settles: an over-budget payment reverts, and nothing moves.
                </SiteLede>
                <p className="mt-3.5 text-[18px]">
                  <SiteTextLink href="/how-it-works/protocols">How the protocols fit</SiteTextLink>
                </p>
              </SiteCopy>
            </div>
          </SiteSplit>
        </SiteSection>

        <SiteSection aria-labelledby="how-receipts">
          <SiteSplit>
            <SiteCopy
              eyebrow="5 · The receipt and the books"
              title="Every payment explains itself."
              titleId="how-receipts"
            >
              <SiteLede>
                Every payment carries a receipt: which agent, what it bought, which budget allowed it, the on-chain
                proof. Connect your bookkeeping tool and it appears there as a draft invoice with the evidence
                attached.
              </SiteLede>
            </SiteCopy>
            <ProductFrame env="Operations" screen="Accounting" className="w-full">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pb-3 text-[13.5px] font-semibold">
                <FramePill>Connected</FramePill>
                <span>Feeding Fortnox · Ada Lovelace AB</span>
                <small className="basis-full font-normal text-[var(--v2-ink-3)]">Last push 2 minutes ago</small>
              </div>
              {[
                ['pay_01…3Y5A', 'Fortnox invoice 1042 · payment evidence and merchant receipt attached'],
                ['pay_01…9K1D', 'Fortnox invoice 1041 · payment evidence attached'],
              ].map(([id, detail]) => (
                <div
                  key={id}
                  className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-[var(--v2-border)] py-3 text-[13px]"
                >
                  <div>
                    <div className={`${SITE_TYPE.mono} font-semibold`}>{id}</div>
                    <div className="mt-0.5 text-[12px] text-[var(--v2-ink-3)]">{detail}</div>
                  </div>
                  <FramePill>Synced</FramePill>
                </div>
              ))}
            </ProductFrame>
          </SiteSplit>
        </SiteSection>

        <SiteSection ground="navy" id="security" aria-labelledby="how-security">
          <p className={SITE_TYPE.eyebrow}>Security</p>
          <h2 id="how-security" className={SITE_TYPE.h2}>
            Built so that Haven cannot be the weak point.
          </h2>
          <p className={`${SITE_TYPE.lede} mt-[18px]`}>
            Haven is non-custodial software, not a custodian or a payment processor. Even a fully compromised Haven
            cannot move your money.
          </p>
          <div className="mt-11 grid grid-cols-1 gap-5 min-[900px]:grid-cols-3">
            {SECURITY_CARDS.map((card) => (
              <NavyCard key={card.title} title={card.title}>
                {card.body}
                {card.link && (
                  <>
                    {' '}
                    <a href={card.link.href} className={CARD_LINK}>
                      {card.link.label}
                      <TrailingArrow />
                    </a>
                  </>
                )}
              </NavyCard>
            ))}
            <NavyCard title="Read the model">
              The full security model is public.{' '}
              <a href="/docs/security-model.md" className={CARD_LINK}>
                Security model
                <TrailingArrow />
              </a>
            </NavyCard>
          </div>
        </SiteSection>

        <SiteSection aria-labelledby="how-protocols">
          <SiteSplit>
            <SiteCopy eyebrow="Protocols" title="x402 today. MPP next. One budget either way." titleId="how-protocols">
              <SiteLede>Your budget, receipt and books do not change when the rail underneath does.</SiteLede>
              <SiteCtaRow>
                <Button href="/how-it-works/protocols" size="lg" trailingIcon>
                  Compare the protocols
                </Button>
              </SiteCtaRow>
            </SiteCopy>
            <div className="grid grid-cols-1 gap-5 min-[820px]:grid-cols-2">
              <SideCard kicker="x402" title="Pay-per-request HTTP">
                A server answers 402, the agent pays, the request is retried with proof. Live.
              </SideCard>
              <SideCard kicker="Stripe MPP" title="Agent-initiated checkout">
                Subscriptions and purchases between an agent and a merchant. Next.
              </SideCard>
            </div>
          </SiteSplit>
        </SiteSection>

        <SiteSection ground="indigo" className="text-center" aria-labelledby="how-close">
          <h2 id="how-close" className={`${SITE_TYPE.h2} mx-auto max-w-[20ch]`}>
            Set up your first agent.
          </h2>
          <p className={`${SITE_TYPE.lede} mx-auto mt-[18px]`}>One passkey, one budget, one command.</p>
          <SiteCtaRow center>
            <BrandBandButton href="/signup" trailingArrow>
              Create your account
            </BrandBandButton>
          </SiteCtaRow>
        </SiteSection>
      </main>
      <Footer />
    </>
  )
}

