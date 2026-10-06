import { Header } from '../Header'
import { Footer } from '../Footer'
import { SiteSection, SITE_TYPE } from '../SiteSection'
import { CodePrompt, SiteCode, SiteCopy, SiteCtaRow, SiteHero, SiteLede } from '../blocks'
import { BrandBandButton } from '@/components/marketing/BrandBandButton'

/**
 * The redesigned For agents page (#3577, epic #3572), built from
 * `docs/product/site-mockup/for-agents.html` and rendered by
 * `app/for-agents/page.tsx`.
 *
 * It is the human-readable face of the runbook at `/for-agents.md`, which is
 * byte-pinned to the SDK constant (`for-agents-runbook.test.ts`) and cannot
 * be edited to fit this page — so every command below is taken verbatim from
 * the runbook, and `for-agents-commands.test.ts` fails the page the day a
 * command drifts from it. The headline is epic decision 14: the mockup's
 * "not a wallet" became the decided "not a credit card"; the body keeps the
 * runbook's wording, including "not their wallet". Navigation links are
 * deliberately simple `<a>`s, not `next/link`: they point at served files
 * and routes the test-idiom of this page checks as plain hrefs.
 *
 * Claims, with their sources (the PR carries the full list): every command
 * and every readiness value is quoted from `public/for-agents.md` (pinned by
 * the sibling test); the signup link is the runbook's own hand-off shape
 * (its § Hand-off scripts, guarded by `discovery-surfaces.test.ts`); the
 * machine-readable files section lists what `public/llms.txt` and the
 * manifest's `docs` block serve.
 */

/** The runbook's connector command form (its § What you run), verbatim. */
const CONNECTOR_COMMAND =
  'npx -y @haven_ai/connect@<channel> --setup EXAMPLE-SETUP-TOKEN-NOT-REAL --api <api-url> --ack-local-tools'

/** The runbook's --doctor form (its § How to verify), verbatim. */
const DOCTOR_COMMAND = 'npx -y @haven_ai/connect@<channel> --doctor'

/** The sequence's six steps, each tagged with its actor (runbook § The sequence). */
const SEQUENCE: ReadonlyArray<{ who: 'human' | 'you'; lead: string; body: string }> = [
  { who: 'human', lead: 'Create the account', body: 'with a passkey on their own device. Never ask for their password.' },
  {
    who: 'human',
    lead: 'Fund it.',
    body: 'USDC only, no ETH. Confirm the address and the chain before you message your user.',
  },
  { who: 'human', lead: 'Create the agent and set its budget', body: ', then paste you the setup prompt.' },
  { who: 'you', lead: 'Run the connector command', body: ' from that prompt. Your key is made locally.' },
  { who: 'human', lead: 'Approve the budget', body: ' with their passkey. Nothing can be spent until they do.' },
  { who: 'you', lead: 'Verify, then pay.', body: '' },
]

/** The readiness values (runbook § How to verify), each verbatim. */
const READINESS = [
  ['ready', 'a budget is live; you can pay.'],
  ['needs_approval', 'nobody approved yet. Ask your user again; there is no queue.'],
  ['revoked', 'the credential is not active; ask your user to create a new agent.'],
] as const

/** Start-here files (mockup `for-agents.html:47-51`), all real served paths. */
const START_FILES = [
  {
    href: '/for-agents.md',
    label: '/for-agents.md',
    body: 'Your user has no Haven account yet: the sequence, which steps are the human’s, and what to say at each hand-off.',
  },
  {
    href: '/402.md',
    label: '/402.md',
    body: 'Your request came back 402 Payment Required: what it means and how you pay it with a budget.',
  },
  {
    href: '/.well-known/haven.json',
    label: '/.well-known/haven.json',
    body: 'This deployment as JSON: environment, chains served, the connector channel, the API and its spec.',
  },
] as const

/** Packages and machine-readable files (mockup `for-agents.html:101-110`). */
const AGENT_FILES = [
  {
    href: '/developers#packages',
    label: '@haven_ai/connect',
    body: 'One-command connector; installs the MCP runtime, generates your key locally.',
  },
  {
    href: '/developers#packages',
    label: '@haven_ai/cli',
    body: 'Terminal-native management: a scoped session that can set up agents but never sign.',
  },
  {
    href: '/developers#packages',
    label: '@haven_ai/sdk',
    body: 'TypeScript SDK for direct integration.',
  },
  {
    href: '/llms-full.txt',
    label: '/llms-full.txt',
    body: 'Product model, payment flow and integration surface in one file.',
  },
  {
    href: '/api/openapi.json',
    label: '/api/openapi.json',
    body: 'The API spec.',
  },
  {
    href: '/exit',
    label: '/exit',
    body: 'Your user’s independent exit: inspect and revoke every budget without Haven.',
  },
] as const

/** The actor chip on a sequence step (mockup `.who` / `.who-h` / `.who-a`). */
function WhoChip({ who }: { who: 'human' | 'you' }) {
  const human = who === 'human'
  return (
    <span
      aria-hidden="true"
      className={`${SITE_TYPE.mono} mr-1.5 inline-block rounded-[5px] px-[7px] py-[2px] align-[1px] text-[11px] tracking-[0.06em] ${
        human
          ? 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
          : 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
      }`}
    >
      {human ? 'HUMAN' : 'YOU'}
    </span>
  )
}

export function ForAgentsPage() {
  return (
    <>
      <Header overlay />
      <main>
        {/* Hero (mockup `.hero.hero-compact`), headline = epic decision 14. */}
        <SiteHero
          eyebrow="For agents"
          titleId="for-agents-heading"
          title="You are an AI agent. Here is how to pay with a budget, not a credit card."
          lede={
            <>
              This page mirrors{' '}
              <a
                href="/llms.txt"
                className={`${SITE_TYPE.mono} rounded-[5px] bg-[rgba(255,255,255,0.12)] px-1.5 py-0.5 text-[14px] text-white underline decoration-white/40 underline-offset-2 transition-colors hover:text-white hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e1230]`}
              >
                /llms.txt
              </a>{' '}
              and{' '}
              <a
                href="/for-agents.md"
                className={`${SITE_TYPE.mono} rounded-[5px] bg-[rgba(255,255,255,0.12)] px-1.5 py-0.5 text-[14px] text-white underline decoration-white/40 underline-offset-2 transition-colors hover:text-white hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e1230]`}
              >
                /for-agents.md
              </a>
              , the canonical runbook. Those files are canonical.
            </>
          }
        />

        <SiteSection aria-labelledby="for-agents-doc-heading">
          <div className="max-w-[76ch]">
            {/* What Haven is — the runbook's own three sentences, kept verbatim. */}
            <SiteCopy
              eyebrow="What Haven is"
              titleId="for-agents-doc-heading"
              title="What Haven is, in three sentences"
            />
            <p className="mt-[14px] text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
              Your user gives you a <b className="font-semibold text-[var(--v2-ink)]">budget on their own account</b> —
              not their wallet, and not a key to their funds. The budget is a delegation they sign, enforced on-chain: a
              payment over it, to the wrong recipient, or past its expiry is refused at execution time, not by a
              dashboard promise. Haven constructs and relays the payments; you get an agent credential and a signing key
              made on your machine, and your user can revoke the budget without you and without Haven.
            </p>

            {/* Start here (mockup `.files`). */}
            <h2 className={`${SITE_TYPE.h2} mt-14 mb-3.5 text-[26px]`}>Start here</h2>
            <ul className="mt-3.5 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
              {START_FILES.map((file) => (
                <li key={file.href}>
                  <a
                    href={file.href}
                    className="block rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3.5 shadow-card transition-colors hover:border-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]"
                  >
                    <code className={`${SITE_TYPE.mono} mb-1 block text-[13px] text-[var(--v2-brand)]`}>
                      {file.label}
                    </code>
                    <span className="block text-[13px] text-[var(--v2-ink-2)]">{file.body}</span>
                  </a>
                </li>
              ))}
            </ul>

            {/* The sequence (mockup `.doc ol` + `.who` chips). */}
            <h2 className={`${SITE_TYPE.h2} mt-14 mb-3.5 text-[26px]`}>The sequence</h2>
            <p className="mt-2.5 text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
              Four steps are the human&apos;s, two are yours.
            </p>
            <p className="mt-2.5 text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
              Your user has no Haven account yet? Send them{' '}
              <a
                href="/signup?next=/agents&via=agent"
                className="rounded-[4px] font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]"
              >
                /signup?next=/agents&amp;via=agent
              </a>{' '}
              — the runbook&apos;s own hand-off link.
            </p>
            <ol className="mt-2.5 grid list-decimal gap-2 pl-[22px]">
              {SEQUENCE.map((step) => (
                <li key={step.lead} className="text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
                  <WhoChip who={step.who} />
                  <b className="font-semibold text-[var(--v2-ink)]">{step.lead}</b>
                  {step.body}
                </li>
              ))}
            </ol>

            {/* What you run — the runbook's connector command, verbatim. */}
            <h2 className={`${SITE_TYPE.h2} mt-14 mb-3.5 text-[26px]`}>What you run</h2>
            <p className="mt-2.5 text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
              Run the version in your prompt, not this one: the token is one-time and the channel is your
              deployment&apos;s.
            </p>
            <SiteCode className="my-3.5">
              <CodePrompt />
              {CONNECTOR_COMMAND}
            </SiteCode>
            <ul className="mt-2.5 grid list-disc gap-2 pl-[22px]">
              <li className="text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
                Append <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>--json</code> when
                you run it yourself: a machine-readable result, and it returns instead of blocking on the approval.
              </li>
              <li className="text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
                On{' '}
                <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>approval.required: true</code>
                , relay the approval link the outcome gave you, or none at all. Never assemble one.
              </li>
              <li className="text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
                Only three changes are permitted:{' '}
                <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>--json</code>, one retry with{' '}
                <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>--runtime &lt;name&gt;</code>{' '}
                if the harness was not detected, and one re-run with{' '}
                <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>--name</code> or{' '}
                <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>--replace</code> after a wiring collision — whichever your user chose.
              </li>
              <li className="text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
                Never print private keys, API keys, credential files or config secrets in chat or logs.
              </li>
            </ul>

            {/* How to verify (mockup `for-agents.html:80-90`). */}
            <h2 className={`${SITE_TYPE.h2} mt-14 mb-3.5 text-[26px]`}>How to verify</h2>
            <p className="mt-2.5 text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
              Call{' '}
              <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>haven_get_agent</code>.
              It returns <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>spend_authority_readiness</code>:
            </p>
            <ul className="mt-2.5 grid list-disc gap-2 pl-[22px]">
              {READINESS.map(([value, body]) => (
                <li key={value} className="text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
                  <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>
                    {value}
                  </code>
                  : {body}
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
              Check your local signer separately with{' '}
              <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>
                {DOCTOR_COMMAND}
              </code>
              .
            </p>

            {/* The budget hand-off script (mockup `for-agents.html:92-94`). */}
            <h2 className={`${SITE_TYPE.h2} mt-14 mb-3.5 text-[26px]`}>A hand-off script, for the budget step</h2>
            <blockquote className="my-3.5 rounded-r-[8px] border-l-[3px] border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] px-4 py-3 text-[15px] text-[var(--v2-ink-2)]">
              On{' '}
              <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>
                &lt;host&gt;/agents
              </code>
              , create an agent for me and set a budget, say 25 USDC per day. That is the limit I cannot exceed. It
              hands back a setup prompt: paste it to me and I run it here.
            </blockquote>
            <p className="mt-2.5 text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
              One script per hand-off is in{' '}
              <a
                href="/for-agents.md"
                className="rounded-[4px] font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]"
              >
                /for-agents.md
              </a>
              , the canonical runbook.
            </p>

            {/* If you cannot open a browser (mockup `for-agents.html:96-98`). */}
            <h2 className={`${SITE_TYPE.h2} mt-14 mb-3.5 text-[26px]`}>If you cannot open a browser</h2>
            <p className="mt-2.5 text-[16px] leading-[1.65] text-[var(--v2-ink-2)]">
              Nothing here needs you to. Hand your user the links, then poll{' '}
              <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>haven_get_agent</code>{' '}
              until it reads{' '}
              <code className={`${SITE_TYPE.mono} rounded-[5px] bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[13.5px] text-[var(--v2-ink)]`}>ready</code>.
              Do not route around the sign-in wall.
            </p>

            {/* Packages and machine-readable files (mockup `.files`). */}
            <h2 className={`${SITE_TYPE.h2} mt-14 mb-3.5 text-[26px]`}>Packages and machine-readable files</h2>
            <ul className="mt-3.5 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
              {AGENT_FILES.map((file) => (
                <li key={file.label}>
                  <a
                    href={file.href}
                    className="block rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3.5 shadow-card transition-colors hover:border-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]"
                  >
                    <code className={`${SITE_TYPE.mono} mb-1 block text-[13px] text-[var(--v2-brand)]`}>
                      {file.label}
                    </code>
                    <span className="block text-[13px] text-[var(--v2-ink-2)]">{file.body}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </SiteSection>

        {/* Closing band (mockup `.close`). */}
        <SiteSection
          ground="indigo"
          aria-labelledby="for-agents-closing-heading"
          className="text-center [&_h2]:mx-auto [&_h2]:max-w-[24ch]"
        >
          <h2 id="for-agents-closing-heading" className={`${SITE_TYPE.h2} mx-auto max-w-[24ch] text-white`}>
            Your user creates the account. You do the rest.
          </h2>
          <p className="mx-auto mt-[18px] max-w-[56ch] text-[18px] leading-[1.6] text-[rgba(255,255,255,0.82)]">
            Hand them the link, run the connector, verify, pay.
          </p>
          <SiteCtaRow center>
            <BrandBandButton href="/for-agents.md" trailingArrow>
              Open /for-agents.md
            </BrandBandButton>
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
