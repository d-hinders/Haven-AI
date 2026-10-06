import Link from 'next/link'
import { SiteSection, SITE_TYPE } from '../SiteSection'
import { Header } from '../Header'
import { Footer } from '../Footer'
import { BrandBandButton } from '@/components/marketing/BrandBandButton'
import { HeroCta } from './HeroCta'
import { AnimatedHeroFrame } from './AnimatedHeroFrame'
import { AnimatedAccountingFrame } from './AnimatedAccountingFrame'
import { AnimatedPasskeyMiniCard, AnimatedBudgetMiniCard, AnimatedConnectorTerminal } from './HowItWorksAnimated'
import { AnimatedRefusalReceipt } from './AnimatedRefusalReceipt'

/**
 * The redesigned home page's seven sections, in both themes (#3574), with the
 * mockup's motion on the four animated regions (#3575). The order follows a
 * buyer's questions rather than the pitch (owner decisions of 2026-10-06,
 * #3676; mockup V17, artifact version `1791276240-c0f5`): hero, how it works,
 * spending limits, accounting, developers, three questions, closing band. The
 * problem points moved to the top of How it works; why-now and Why Haven left
 * the page.
 *
 * Every animated region renders its settled state here unless its loop is
 * running: the controllers (`AnimatedHeroFrame`, `AnimatedPasskeyMiniCard`,
 * `AnimatedBudgetMiniCard`, `AnimatedConnectorTerminal`,
 * `AnimatedAccountingFrame`, `AnimatedRefusalReceipt`) pass no state under
 * reduced motion, out of view, or before their loop starts, so the settled
 * markup below — slice 2's, in `HeroAgentsFrame`, `StepMiniCards`,
 * `ConnectorTerminal`, `AccountingFrame`, `RefusalReceipt` — is what renders.
 * This file stays a server component; only the controllers are client
 * components. Headings and body copy follow the mockup except the epic's
 * decided deviations, each marked where it applies:
 *
 * - "Talk to the founders" is removed (decision 8), with no replacement.
 * - Step 3 names the clients the connector supports (decision 13), and its
 *   terminal is a short storytelling script that keeps the connector
 *   command's published prefix (#3644) — the mockup's bare one-liner exits
 *   with an argument error before anything runs
 *   (`packages/connect/src/args.ts:256`).
 * - Step 1's account wording replaces the mockup's account-kind phrase that
 *   `docs/product/copy-guidelines.md` bans; the sentence keeps its meaning.
 * - The spending-limits band says the budget message in plain words, with no
 *   chain or mechanism vocabulary (#3676 decision 3). That decision covers
 *   this band only; How it works keeps its own security section. The band's
 *   claim is scoped to payments from the user's account, as
 *   `docs/product/copy-guidelines.md` requires: a leaked key can still move a
 *   balance already in the agent's own wallet, which How it works discloses.
 */

/** 1 — Hero with product frame (navy; the header renders overlay over it). */
export function HomeHero() {
  return (
    <SiteSection
      ground="navy"
      id="hero"
      aria-labelledby="hero-heading"
      className="relative overflow-hidden pt-[132px] pb-16 md:pt-[148px] md:pb-24"
    >
      {/* The mockup's hero washes (site.css `.hero::before`) — fixed on the fixed navy. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 55% at 12% 8%, rgba(99,102,241,0.55) 0%, transparent 60%), radial-gradient(45% 50% at 78% 18%, rgba(139,92,246,0.42) 0%, transparent 60%), radial-gradient(50% 45% at 55% 100%, rgba(56,189,248,0.16) 0%, transparent 60%), linear-gradient(180deg, #141a4a 0%, #0e1230 70%)',
        }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.14]" style={{
        backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
        maskImage: 'radial-gradient(70% 60% at 30% 20%, #000 0%, transparent 75%)',
        WebkitMaskImage: 'radial-gradient(70% 60% at 30% 20%, #000 0%, transparent 75%)',
      }} />

      <div className="relative grid grid-cols-1 gap-11 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:gap-14">
        <div>
          <div className={SITE_TYPE.eyebrow}>Budgets for AI agents</div>
          <h1 id="hero-heading" className={SITE_TYPE.h1}>
            Give your agent a budget, not your credit card.
          </h1>
          <p className={`${SITE_TYPE.lede} mt-[22px]`}>Each agent gets its own budget. You keep custody.</p>

          <div className="mt-8 flex flex-wrap gap-3">
            <HeroCta href="/signup" variant="solid" trailingArrow>
              Create your account
            </HeroCta>
            <HeroCta href="/how-it-works" variant="ghost">
              See how it works
            </HeroCta>
          </div>

          {/*
            Addressed to agents, server-rendered, real page content (#2521).
            The exact sentence the legacy page ships; the new test beside
            `discovery-surfaces.test.ts` pins it on this page too.
          */}
          <p className="mt-6 max-w-[520px] text-[13px] text-[rgba(255,255,255,0.62)]">
            Haven gives an agent a budget instead of a wallet, enforced on-chain. If you are an AI
            agent reading this for your user, start at{' '}
            <a
              href="/llms.txt"
              className="underline underline-offset-2 text-[rgba(255,255,255,0.72)] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e1230]"
            >
              /llms.txt
            </a>
            .
          </p>
        </div>

        <div aria-hidden="true" className="min-w-0">
          <AnimatedHeroFrame />
        </div>
      </div>
    </SiteSection>
  )
}

/** 2 — How it works: three steps with settled-state minis (tint ground). */
export function HomeHowItWorks() {
  return (
    <SiteSection id="how" aria-labelledby="how-heading" ground="tint">
      <div className={SITE_TYPE.eyebrow}>How it works</div>
      <h2 id="how-heading" className={`${SITE_TYPE.h2} max-w-[24ch]`}>
        Three steps. Your agent pays for what it needs, within a budget you set.
      </h2>

      {/*
        From md each step is a four-row subgrid of this grid (#3630): label,
        heading, paragraph and card rows line up across the three columns, so
        the three cards share one height and top edge however the text wraps.
        Each card fills its row; card 1 centres its content and card 2 keeps
        its action row (control or confirmation) at the bottom, as the mockup does.
      */}
      <div className="mt-12 grid grid-cols-1 gap-7 md:grid-cols-3 md:grid-rows-[auto_auto_auto_1fr] md:gap-y-0">
        <div className="flex min-w-0 flex-col md:row-span-4 md:grid md:grid-rows-subgrid">
          <span className={`text-[12px] text-[var(--v2-brand)] ${SITE_TYPE.mono}`}>Step 1</span>
          <h3 className={`${SITE_TYPE.h3} mb-2 mt-3.5`}>Create your account with a passkey</h3>
          <p className="text-[15px] text-[var(--v2-ink-2)]">
            One Face ID prompt creates an account only you control. No seed phrase, no credit card.
          </p>
          <div aria-hidden="true" className="mt-2 flex min-w-0 flex-1 flex-col">
            <AnimatedPasskeyMiniCard />
          </div>
        </div>

        <div className="flex min-w-0 flex-col md:row-span-4 md:grid md:grid-rows-subgrid">
          <span className={`text-[12px] text-[var(--v2-brand)] ${SITE_TYPE.mono}`}>Step 2</span>
          <h3 className={`${SITE_TYPE.h3} mb-2 mt-3.5`}>Give each agent a budget</h3>
          <p className="text-[15px] text-[var(--v2-ink-2)]">
            An amount and a period per agent. It refills itself and can be revoked at any time.
          </p>
          <div aria-hidden="true" className="mt-2 flex min-w-0 flex-1 flex-col">
            <AnimatedBudgetMiniCard />
          </div>
        </div>

        <div className="flex min-w-0 flex-col md:row-span-4 md:grid md:grid-rows-subgrid">
          <span className={`text-[12px] text-[var(--v2-brand)] ${SITE_TYPE.mono}`}>Step 3</span>
          <h3 className={`${SITE_TYPE.h3} mb-2 mt-3.5`}>Connect any agent</h3>
          <p className="text-[15px] text-[var(--v2-ink-2)]">
            One command wires in Claude, Codex, Cursor or any other agent harness.
          </p>
          <div className="mt-2 flex min-w-0 flex-1 flex-col">
            <AnimatedConnectorTerminal />
          </div>
        </div>
      </div>
    </SiteSection>
  )
}

/**
 * 3 — Spending limits band (navy): the budget message in plain words, receipt
 * right (mockup V17, artifact version `1791276240-c0f5`, `index.html:155-179`).
 */
export function HomeSpendingLimits() {
  const facts = [
    {
      title: 'Your money stays yours',
      body: 'Funds stay in an account only you control. Haven never holds them.',
    },
    {
      title: 'The limit holds even if Haven doesn’t',
      body: 'The budget is enforced by your account itself, not by a setting we could change or lose.',
    },
    {
      title: 'Change it whenever you like',
      body: 'Raise, lower or revoke a budget at any time, or pause the agent. If an agent’s credential leaks, it still cannot spend your account past its budget.',
    },
  ]
  return (
    <SiteSection id="enforce" aria-labelledby="enforce-heading" ground="navy">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
        <div>
          <div className={SITE_TYPE.eyebrow}>Spending limits</div>
          <h2 id="enforce-heading" className={SITE_TYPE.h2}>
            An agent can only spend what its budget allows.
          </h2>
          <p className={`${SITE_TYPE.lede} mt-[18px]`}>
            Every payment from your account is checked against the agent’s budget before anything
            is paid. Over the limit, it is refused: nothing is charged, and nothing waits for your
            approval.
          </p>
          <div className="mt-9 grid gap-[22px]">
            {facts.map((fact) => (
              <div key={fact.title} className="grid grid-cols-[22px_1fr] gap-3.5">
                <span
                  aria-hidden
                  className="grid h-[22px] w-[22px] place-items-center rounded-full border border-[rgba(255,255,255,0.12)] text-[12px] text-[#a5b4fc]"
                >
                  ✓
                </span>
                <div>
                  <h3 className="mb-1 text-[16px] font-semibold tracking-[-0.01em] leading-[1.3] text-white [font-family:var(--font-site-display)]">
                    {fact.title}
                  </h3>
                  <p className="text-[15px] text-[rgba(255,255,255,0.72)]">{fact.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div aria-hidden="true">
          <AnimatedRefusalReceipt />
        </div>
      </div>
    </SiteSection>
  )
}

/** 4 — Accounting (white): feed frame left, copy right. */
export function HomeAccounting() {
  return (
    <SiteSection id="accounting" aria-labelledby="accounting-heading">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div aria-hidden="true" className="min-w-0">
          <AnimatedAccountingFrame />
        </div>
        <div>
          <div className={SITE_TYPE.eyebrow}>Accounting</div>
          <h2 id="accounting-heading" className={SITE_TYPE.h2}>
            Every payment appears in your bookkeeping tool.
          </h2>
          <p className={`${SITE_TYPE.lede} mt-[18px]`}>
            Each purchase lands in your accounting tool as a draft supplier invoice with the
            evidence attached. Fortnox today, more connectors coming.
          </p>
        </div>
      </div>
    </SiteSection>
  )
}

/** 5 — Developers band (navy): the developer surface and a real 402 flow. */
export function HomeDevelopers() {
  const entries = [
    {
      code: 'hosted MCP',
      body: 'Keyless hosted tools plus a local signer. The key never leaves the agent’s machine.',
    },
    {
      code: 'x402',
      body: 'Quote, pay and resume HTTP 402 paywalls, whichever settlement scheme the merchant speaks.',
    },
    {
      code: '/llms.txt',
      body: 'Written for agents. An agent can set Haven up for its user from it.',
    },
  ]
  return (
    <SiteSection id="dev" aria-labelledby="dev-heading" ground="navy">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
        <div>
          <div className={SITE_TYPE.eyebrow}>For developers and agents</div>
          <h2 id="dev-heading" className={SITE_TYPE.h2}>
            Bring your own agent. Bring your own harness.
          </h2>
          <p className={`${SITE_TYPE.lede} mt-[18px]`}>
            MCP-native, works with any harness, and pays any standard x402 merchant today.
          </p>
          <div className="mt-8 grid gap-[18px]">
            {entries.map((entry) => (
              <div key={entry.code} className="grid grid-cols-[auto_1fr] items-start gap-3.5">
                <code
                  className={`whitespace-nowrap rounded-md bg-[rgba(255,255,255,0.1)] px-[7px] py-0.5 text-[12.5px] text-[#c7d2fe] ${SITE_TYPE.mono}`}
                >
                  {entry.code}
                </code>
                <p className="text-[15px] text-[rgba(255,255,255,0.72)]">{entry.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Storytelling, not a transcript: every line stays within 28
            characters so the block fits a 320px phone without a sideways
            scroller (owner, #3579). `pre-wrap` is the backstop if a fallback
            mono face runs wider. */}
        <div
          className={`min-w-0 rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] text-[13px] leading-[1.7] text-[#e6e9ff] ${SITE_TYPE.mono}`}
          style={{ padding: '18px 20px' }}
        >
          <pre className="whitespace-pre-wrap break-words">
            <span className="text-[rgba(230,233,255,0.5)]"># An agent hits a paywall</span>
            {'\n'}GET api.example/v1/enrich{'\n'}
            <span className="text-[rgba(230,233,255,0.5)]">← 402 · pay 0.30 USDC</span>
            {'\n\n'}
            <span className="text-[rgba(230,233,255,0.5)]">
              {'# Haven checks the budget,\n# the agent signs locally'}
            </span>
            {'\n'}
            <span className="text-[#a5b4fc]">haven_quote_x402</span>
            {'\n  → within budget\n'}
            <span className="text-[#a5b4fc]">haven_sign_x402</span>
            {'\n  → signed on its machine\n'}
            <span className="text-[#a5b4fc]">haven_pay_x402</span>
            {'\n  → settled on Base\n\n'}
            <span className="text-[rgba(230,233,255,0.5)]">← 200 OK</span>
            {'\n'}
            <span className="text-[rgba(230,233,255,0.5)]">
              {'# Receipt: agent, purchase,\n# policy, on-chain proof'}
            </span>
          </pre>
        </div>
      </div>
    </SiteSection>
  )
}

/**
 * 6 — Three questions (white, with the mockup's hairline top border): mockup
 * V17, artifact version `1791276240-c0f5`, `index.html:231-241`; the cards
 * stack to one column at and below 900px, as `.faq-grid` does.
 */
export function HomeQuestions() {
  const questions = [
    {
      q: 'Do you hold my money?',
      a: 'No. Funds stay in an account only you control. Haven prepares payments within the budgets you set and cannot move money on its own.',
    },
    {
      q: 'Which agents work with Haven?',
      a: 'Any agent that can run a command: Claude, Codex, Cursor or any other agent harness. One command connects it, and you approve its budget with your passkey.',
    },
    {
      q: 'What can an agent pay for?',
      a: 'Anything sold over x402 today: APIs, data, compute, paywalled content. Every purchase gets a receipt and lands in your bookkeeping tool.',
    },
  ]
  return (
    <SiteSection id="faq" aria-labelledby="faq-heading" className="border-t border-[var(--v2-border)]">
      <div className={SITE_TYPE.eyebrow}>Three questions</div>
      <h2 id="faq-heading" className={SITE_TYPE.h2}>
        The things people ask before they sign up.
      </h2>
      <div className="mt-11 grid grid-cols-1 gap-5 min-[901px]:grid-cols-3">
        {questions.map((item) => (
          <div
            key={item.q}
            className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-6 shadow-card"
          >
            <h3 className={`${SITE_TYPE.h3} mb-2.5`}>{item.q}</h3>
            <p className="text-[15px] text-[var(--v2-ink-2)]">{item.a}</p>
          </div>
        ))}
      </div>
    </SiteSection>
  )
}

/**
 * 7 — Closing band (indigo). "Talk to the founders" is removed (decision 8):
 * one CTA remains, and the facts line carries the positioning sentences.
 */
export function HomeClosing() {
  return (
    <SiteSection id="close" aria-labelledby="closing-heading" ground="indigo" className="text-center">
      <h2 id="closing-heading" className={`${SITE_TYPE.h2} mx-auto max-w-[20ch]`}>
        Give your agent a budget.
      </h2>
      <p className={`${SITE_TYPE.lede} mx-auto mt-[18px] text-center`}>
        One passkey, one budget, one command. Nothing spends without your signature.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <BrandBandButton href="/signup" trailingArrow>
          Create your account
        </BrandBandButton>
      </div>
      <div className="mt-9 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[13px] text-[rgba(255,255,255,0.7)]">
        <span className="before:mr-2 before:inline-block before:h-1.5 before:w-1.5 before:rounded-full before:bg-[rgba(255,255,255,0.4)] before:align-[1px]">
          Built in Stockholm
        </span>
        <span className="before:mr-2 before:inline-block before:h-1.5 before:w-1.5 before:rounded-full before:bg-[rgba(255,255,255,0.4)] before:align-[1px]">
          Non-custodial software, not a payment processor
        </span>
      </div>
    </SiteSection>
  )
}

/**
 * The assembled new home, in the mockup's V17 order (#3676). Exported for the page's gate
 * branch and for the tests that assert over the rendered page.
 */
export function NewSiteHome() {
  return (
    <>
      {/* The mockup's home header is overlay: transparent over the navy hero. */}
      <Header overlay />
      <main>
        <HomeHero />
        <HomeHowItWorks />
        <HomeSpendingLimits />
        <HomeAccounting />
        <HomeDevelopers />
        <HomeQuestions />
        <HomeClosing />
      </main>
      <Footer />
    </>
  )
}
