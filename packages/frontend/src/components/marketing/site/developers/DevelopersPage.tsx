import Link from 'next/link'
import { Header } from '../Header'
import { Footer } from '../Footer'
import { SiteSection, SITE_TYPE } from '../SiteSection'
import { CodePrompt, SiteCode, SiteCopy, SiteCtaRow, SiteHero, SiteLede, SiteSplit } from '../blocks'
import { BrandBandButton } from '@/components/marketing/BrandBandButton'
import {
  ARCHITECTURE,
  CLI_TERMINAL,
  PACKAGE_DESCRIPTIONS,
  QUICKSTART_TERMINAL,
  REFERENCE_FILES,
  X402_TERMINAL,
  packageNames,
} from './fixtures'

/**
 * The redesigned For developers page (#3577, epic #3572), built from
 * `docs/product/site-mockup/developers.html` and rendered by
 * `app/developers/page.tsx`.
 *
 * Copy follows the mockup except where the code corrected it, each marked at
 * its fixture: the connector command carries its required `--api` flag (the
 * mockup's bare form exits with an argument error), and the CLI `login` line
 * is the runbook's `<packages.cli.one_liner>` template rather than a tag
 * appended to the package name (`channel` already holds the full spec; the
 * #3430 defect class). Package names come from the manifest's static half,
 * which needs no fetch, so the page stays static and its baseline does not
 * move with releases — versions live on `/releases`, which the section links.
 *
 * Claims, with their sources (the PR carries the full list): the connector
 * refuses to run without `--setup` and `--api` (`packages/connect/src/args.ts`);
 * the hosted x402 tools are `haven_quote_x402` and `haven_pay_x402`
 * (`packages/mcp-server/src/tools/plain-http-x402.ts`) and `haven_sign_x402`
 * signs on the local signer (`packages/sdk/src/types.ts`); the CLI never
 * signs — every budget change hands the owner a link to sign with their
 * passkey (`public/for-agents.md` § Budget changes later).
 */

/** The quickstart section's terminal, mockup `.code` at `developers.html:48-58`. */
function QuickstartTerminal() {
  return (
    <SiteCode>
      <span className="text-[rgba(230,233,255,0.5)]">{QUICKSTART_TERMINAL.comment}</span>
      {'\n'}
      <CodePrompt />
      {QUICKSTART_TERMINAL.command}
      {'\n\n'}
      <span className="text-[rgba(230,233,255,0.5)]">
        {'# the connector writes owner-only files, never to the repo'}
      </span>
      {'\n'}
      {QUICKSTART_TERMINAL.files.map(([path, note]) => (
        <span key={path} className="block">
          {path}
          {'  '}
          <span className="text-[rgba(230,233,255,0.5)]">{`# ${note}`}</span>
        </span>
      ))}
      {'\n\n'}
      <span className="text-[rgba(230,233,255,0.5)]">{QUICKSTART_TERMINAL.tailComment}</span>
      {'\n'}
      {QUICKSTART_TERMINAL.probe}
    </SiteCode>
  )
}

/** The 402 walk-through terminal, mockup `developers.html:107-113`. */
function X402Terminal() {
  return (
    <SiteCode>
      {X402_TERMINAL.head}
      {'\n'}
      <span className="text-[rgba(230,233,255,0.5)]">{X402_TERMINAL.status}</span>
      {'\n\n'}
      {X402_TERMINAL.calls.map(([tool, result]) => (
        <span key={tool} className="block">
          {tool}
          {'  '}
          <span className="text-[rgba(230,233,255,0.6)]">{result}</span>
        </span>
      ))}
      {'\n\n'}
      <span className="text-[rgba(230,233,255,0.5)]">{X402_TERMINAL.tail}</span>
    </SiteCode>
  )
}

/** The CLI terminal, mockup `developers.html:126-131` in the runbook's forms. */
function CliTerminal() {
  return (
    <SiteCode>
      <span className="text-[rgba(230,233,255,0.5)]">{CLI_TERMINAL.comment}</span>
      {CLI_TERMINAL.commands.map((command) => (
        <span key={command} className="block">
          <CodePrompt />
          {command}
        </span>
      ))}
    </SiteCode>
  )
}

/** The quickstart's three steps (mockup `.steplist`). */
const STEPS = [
  {
    n: '01',
    title: 'Create an account and an agent',
    body: 'One passkey prompt, then an agent with a budget. It hands back the connector command.',
  },
  {
    n: '02',
    title: 'Run the connector',
    body: 'It installs the MCP runtime and generates the signing key locally. Approve the budget with your passkey.',
  },
  {
    n: '03',
    title: 'Verify, then pay',
    body: 'Call haven_get_agent. When spend_authority_readiness reads ready, the agent has the authority to pay; a funds_cover_remaining false on an allowances row is a heads-up the agent will mention, not a refusal.',
  },
] as const

export function DevelopersPage() {
  const packages = packageNames()
  return (
    <>
      <Header overlay />
      <main>
        {/* Hero (mockup `.hero.hero-compact`). */}
        <SiteHero
          eyebrow="For developers"
          titleId="developers-heading"
          title="Bring your own agent. Bring your own harness."
          lede="MCP-native, works with any harness. One command connects an agent, a local signer holds the only key, the budget is enforced on-chain."
        />

        {/* Quickstart: three steps + the connector terminal (mockup `.split`). */}
        <SiteSection aria-labelledby="quickstart-heading">
          <SiteSplit>
            <div>
              <SiteCopy eyebrow="Quickstart" titleId="quickstart-heading" title="Three steps to a paying agent." />
              <ol className="mt-[26px] grid gap-3.5">
                {STEPS.map((step) => (
                  <li key={step.n} className="grid grid-cols-[24px_1fr] gap-3 text-[15px] text-[var(--site-ink-2,var(--v2-ink-2))]">
                    <span className={`${SITE_TYPE.mono} pt-[3px] text-[12px] text-[var(--v2-brand)]`}>{step.n}</span>
                    <span>
                      <b className="block mb-0.5 font-semibold text-[var(--site-ink,var(--v2-ink))]">{step.title}</b>
                      {step.body}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <QuickstartTerminal />
          </SiteSplit>
        </SiteSection>

        {/* Architecture (mockup `.tint` + `.arch`). */}
        <SiteSection ground="tint" aria-labelledby="architecture-heading">
          <SiteCopy
            eyebrow="Architecture"
            titleId="architecture-heading"
            title="Keyless where it is hosted. Keyed where it runs."
          />
          <SiteLede>Three parts, and no single one of them can spend.</SiteLede>
          <div className="mt-7 grid grid-cols-1 items-center gap-3 min-[900px]:grid-cols-[1fr_auto_1fr_auto_1fr]">
            {ARCHITECTURE.map((part, index) => (
              // The arrow between boxes, rotated on phones (mockup `.arch`).
              // React writes the key on the fragment's inner elements, so the
              // box and its arrow are one keyed pair.
              <div key={part.tag} className="contents">
                {index > 0 && (
                  <span
                    aria-hidden="true"
                    className="rotate-90 justify-self-center text-[18px] text-[var(--v2-ink-3)] min-[900px]:rotate-0"
                  >
                    →
                  </span>
                )}
                <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-[18px] shadow-card">
                  <span className={`${SITE_TYPE.mono} mb-2 inline-block text-[11px] text-[var(--v2-brand)]`}>
                    {part.tag}
                  </span>
                  <h3 className={`${SITE_TYPE.h3} mb-1.5`}>{part.title}</h3>
                  <p className="text-[13.5px] text-[var(--v2-ink-2)]">{part.body}</p>
                </div>
              </div>
            ))}
          </div>
        </SiteSection>

        {/* Quote, sign, pay (mockup `.split` + `.code`). */}
        <SiteSection aria-labelledby="paywall-heading">
          <SiteSplit>
            <div>
              <SiteCopy eyebrow="Paying a 402" titleId="paywall-heading" title="Quote, sign, pay." />
              <SiteLede>
                Three tool calls settle a paywall. Every payment returns a receipt: agent, item, policy, proof. An
                interrupted payment can be resumed, never paid twice.
              </SiteLede>
            </div>
            <X402Terminal />
          </SiteSplit>
        </SiteSection>

        {/* Packages (mockup `.tint` + `.pkg-table`), the `#packages` anchor. */}
        <SiteSection ground="tint" id="packages" aria-labelledby="packages-heading">
          <SiteCopy eyebrow="Packages" titleId="packages-heading" title="Five packages on npm." />
          <div className="mt-8 overflow-hidden rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)]">
            <div className="overflow-x-auto">
              <table data-package-table className="w-full border-collapse text-left text-[14px]">
                <thead>
                  <tr className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] text-[12px] uppercase tracking-[0.06em] text-[var(--v2-ink-3)]">
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Package
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      What it is
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Use it when
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {packages.map((name) => {
                    const key = name.replace('@haven_ai/', '') as keyof typeof PACKAGE_DESCRIPTIONS
                    const copy = PACKAGE_DESCRIPTIONS[key]
                    return (
                      <tr key={name} className="border-b border-[var(--v2-border)] last:border-b-0">
                        <td className={`${SITE_TYPE.mono} px-4 py-3.5 align-top text-[13px] font-medium text-[var(--v2-ink)]`}>
                          {name}
                        </td>
                        <td className="max-w-[34ch] px-4 py-3.5 align-top text-[var(--v2-ink-2)]">{copy.what}</td>
                        <td className="max-w-[28ch] px-4 py-3.5 align-top text-[var(--v2-ink-2)]">{copy.when}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-4 text-[13.5px] text-[var(--v2-ink-2)]">
            Versions and update commands:{' '}
            <Link
              href="/releases"
              className="rounded-[4px] font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]"
            >
              /releases
            </Link>
            .
          </p>
          <div className="mt-6">
            <CliTerminal />
          </div>
        </SiteSection>

        {/* Machine-readable files (mockup `.files`). */}
        <SiteSection aria-labelledby="reference-heading">
          <SiteCopy eyebrow="Reference" titleId="reference-heading" title="Machine-readable, on the host you use." />
          <ul className="mt-[22px] grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            {REFERENCE_FILES.map((file) => (
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
        </SiteSection>

        {/* Closing band (mockup `.close`). */}
        <SiteSection
          ground="indigo"
          aria-labelledby="closing-heading"
          className="text-center [&_h2]:mx-auto [&_h2]:max-w-[20ch]"
        >
          <h2 id="closing-heading" className={`${SITE_TYPE.h2} mx-auto max-w-[20ch] text-white`}>
            Give your agent a budget.
          </h2>
          <p className="mx-auto mt-[18px] max-w-[56ch] text-[18px] leading-[1.6] text-[rgba(255,255,255,0.82)]">
            One budget, one command. Your agent pays within it and nowhere else.
          </p>
          <SiteCtaRow center>
            <BrandBandButton href="/signup" trailingArrow>
              Create your account
            </BrandBandButton>
            <BrandBandButton href="/for-agents" variant="translucent">
              Read it as an agent
            </BrandBandButton>
          </SiteCtaRow>
        </SiteSection>
      </main>
      <Footer />
    </>
  )
}
