import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'
import { Section } from '@/components/marketing/Section'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { isDemoPageVisible } from '@/lib/demo-gate'

/**
 * `/demo` — the investor demo page (#3477).
 *
 * A server component (like `/onboarding`'s layout) so it can both export
 * static `robots` metadata AND call `notFound()` before rendering anything —
 * neither is available from a client component.
 *
 * Semi-private: not advertised — the team hands the link to invited
 * investors. It is deliberately absent from `PUBLIC_SURFACES`, `robots.txt`,
 * `SiteHeader`, `SiteFooter`, `llms.txt` and `for-agents.md` — see
 * `src/app/demo/__tests__/not-listed.test.ts`, which pins that absence with
 * explicit assertions rather than the count-only "lists nothing else" guard
 * in `discovery-surfaces.test.ts`.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

// The production/faucet gate (`isDemoPageVisible`) is read at REQUEST time,
// not build time — without this, Next prerenders the page once at build,
// bakes in whatever the build-time env said (production, on CI), and every
// later request gets that frozen 404 regardless of `HAVEN_DEMO_PAGE_VISIBLE`.
// Same reasoning as `/releases` (`src/app/releases/page.tsx`), which reads
// its own per-request signal (the reachable backend) the same way.
export const dynamic = 'force-dynamic'

const WHY_IT_MATTERS = {
  passkey: 'A passkey, not a seed phrase — nothing to write down, lose, or phish.',
  nonCustodial: 'Haven never holds your funds. Your account holds them, and they move only within limits you sign.',
  onChain: "Spending limits are enforced on-chain, by your account — not by a promise in Haven's database.",
  agentNative: 'Built for an agent to read and act on directly, not just for a human to click through.',
} as const

function StepCard({
  number,
  title,
  whyItMatters,
  children,
}: {
  number: number
  title: string
  whyItMatters: string
  children: React.ReactNode
}) {
  return (
    <Card className="p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand-soft)] text-sm font-semibold text-[var(--v2-brand)]">
          {number}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] font-semibold text-[var(--v2-ink)]">{title}</h3>
          <div className="mt-2 space-y-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">{children}</div>
          <p className="mt-3 text-xs text-[var(--v2-ink-3)]">Why it matters: {whyItMatters}</p>
        </div>
      </div>
    </Card>
  )
}

export default function DemoPage() {
  if (!isDemoPageVisible()) notFound()

  return (
    <div className="min-h-screen bg-[var(--v2-bg)]">
      <SiteHeader />
      <main>
        <Section
          eyebrow="Investor demo — Base Sepolia testnet"
          title="See a Haven agent pay, in about 10 minutes"
          lede="This walkthrough uses test funds only — not real money — on a preview build. You'll create a Haven account, fund it from a public faucet, connect an AI agent, watch it pay for something small, and then watch Haven refuse a payment that goes over the agent's budget."
        >
          <div className="mb-10 space-y-4">
            <Card className="border-brand/30 bg-[var(--v2-brand-soft)] p-4" hover={false}>
              <p className="text-sm font-medium text-[var(--v2-ink)]">
                Test funds only — not real money. This is a preview build on the Base Sepolia test network.
              </p>
            </Card>
            <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
              This demo works best on a laptop — signing up, funding your account and connecting an agent all go
              faster with a full keyboard and a code editor or terminal open side by side.
            </p>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">Before you start</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--v2-ink-2)]">
                <li>A passkey-capable device (Face ID, Touch ID, Windows Hello, or a device PIN).</li>
                <li>One AI agent harness — Claude Code, Codex, or Hermes.</li>
                <li>About 10 minutes.</li>
              </ul>
            </Card>
          </div>

          <div className="space-y-4">
            <StepCard number={1} title="Create your account" whyItMatters={WHY_IT_MATTERS.passkey}>
              <p>
                Go to <a href="/signup" className="font-medium text-[var(--v2-brand)] hover:underline">Sign up</a> and
                create your Haven account with your name, email and a password. You'll set up your passkey right
                after, during onboarding — the same entry point every Haven signup uses. Keep{' '}
                <strong>Base Sepolia</strong> selected under <strong>Network</strong> when onboarding creates your
                account — this demo needs the test network.
              </p>
            </StepCard>

            <StepCard number={2} title="Fund it with test USDC" whyItMatters={WHY_IT_MATTERS.nonCustodial}>
              <p>
                From your dashboard, choose <strong>Add funds</strong>. Copy the{' '}
                <strong>Account address (Base Sepolia)</strong> shown there, then use the{' '}
                <strong>Get test funds</strong> card below it — &ldquo;Get free Base Sepolia USDC from Circle's
                faucet&rdquo; — and click <strong>Open Circle's faucet</strong>. Pick USDC and Base Sepolia there,
                then paste in the address you copied.
              </p>
              <p>
                Don't see that card, or want to open the faucet directly? Go to{' '}
                <a
                  href="https://faucet.circle.com"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-[var(--v2-brand)] hover:underline"
                >
                  faucet.circle.com
                </a>{' '}
                and select Base Sepolia explicitly (not Ethereum Sepolia) before requesting funds. You don't need
                any ETH either way — Haven sponsors the gas.
              </p>
            </StepCard>

            <StepCard number={3} title="Connect an agent" whyItMatters={WHY_IT_MATTERS.agentNative}>
              <p>
                From <strong>Agents</strong>, start the connect flow. At its budget step, set{' '}
                <strong>0.05 USDC, Daily</strong> — well under the 1 USDC send you'll try in step 7, so that step is
                refused rather than going through. Then paste the setup prompt the flow gives you into Claude Code,
                Codex, or Hermes.
              </p>
            </StepCard>

            <StepCard number={4} title="Approve its budget with your passkey" whyItMatters={WHY_IT_MATTERS.onChain}>
              <p>
                Approve it with your passkey. Nothing can be spent until you do. Don't add a recipient pin on the
                agent's page afterward: an unpinned budget is what lets the agent pay a marketplace merchant in
                step 6.
              </p>
            </StepCard>

            <StepCard number={5} title="Check that it's connected" whyItMatters={WHY_IT_MATTERS.agentNative}>
              <p>
                Follow the restart instruction your agent's connect flow showed for your harness, then ask your
                agent: <em>&ldquo;What's my Haven budget?&rdquo;</em> An answer with your remaining budget confirms
                the Haven tools are loaded.
              </p>
            </StepCard>

            <StepCard number={6} title="Buy a joke" whyItMatters={WHY_IT_MATTERS.agentNative}>
              <p>
                Ask your agent to buy a joke from Ampersend on Base Sepolia. The offer — &ldquo;Ampersend —
                joke (Base Sepolia)&rdquo; — costs 0.001 USDC and is well inside the 0.05 USDC budget you approved.
              </p>
            </StepCard>

            <StepCard number={7} title="Try to overspend" whyItMatters={WHY_IT_MATTERS.onChain}>
              <p>
                Ask your agent to send 1 USDC to a harmless address —{' '}
                <code className="break-all rounded bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-xs">
                  0x0A5B4da361AfBc5109030010c3f1d0b64b60ba6C
                </code>{' '}
                (Haven's own address) works well. This only demonstrates a refusal while your agent's remaining
                budget is under 1 USDC — which it is, right after step 6.
              </p>
              <p>
                Haven refuses it before any money moves: checked against the rules in your account, it's over the
                agent's budget, so nothing is submitted. Those rules live on-chain in your account, not in Haven's
                database, so Haven can't move your funds outside the limits you approve. There's no approval queue
                to clear and nothing to undo.
              </p>
              <p>
                An agent that already knows its remaining budget (from step 5's check) may decline to even try this
                step — that's the guardrail working too, not a skipped step.
              </p>
            </StepCard>

            <StepCard number={8} title="What you just saw" whyItMatters={WHY_IT_MATTERS.nonCustodial}>
              <p>
                Your agent paid for something small, from a budget you signed and it could not exceed, and Haven
                refused a payment over that budget before it could move any money — enforced on-chain, agent-native
                from the first step. Questions? Ask the team.
              </p>
            </StepCard>
          </div>

          <Card className="mt-10 p-4">
            <p className="text-sm text-[var(--v2-ink-2)]">
              Handing this link to an agent instead of walking it yourself? Point it at{' '}
              <a href="/demo.md" className="font-medium text-[var(--v2-brand)] hover:underline">
                /demo.md
              </a>{' '}
              — the same walk, written for a model to read.
            </p>
          </Card>

          <div className="mt-10">
            <Button href="/" variant="ghost">
              Back to Haven
            </Button>
          </div>
        </Section>
      </main>
      <SiteFooter />
    </div>
  )
}
