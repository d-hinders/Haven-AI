'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input, MaxButton, PasteButton } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Row } from '@/components/ui/Row'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/Toast'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import {
  AgentActivityRow,
  AgentBudgetCard,
  AgentRulesSummary,
  ApprovalRequiredBanner,
  CredentialHandoffCard,
  DirectionMark,
  ExternalDetailsLink,
  RiskExplainer,
  TransactionActivityRow,
  TransactionMovement,
  WalletIdentityBlock,
} from '@/components/haven'

const sampleAddress = '0x8f4F0f6d712C5c5C9Bb02F4a5B5c0D7F462A6f4C'

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-[var(--v2-ink)]">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">{description}</p>
      </div>
      {children}
    </section>
  )
}

function LoadingCard() {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <Card hover={false} className="p-5">
        <Skeleton variant="text" className="h-4 w-28" />
        <Skeleton className="mt-5 h-8 w-40" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-12 rounded-[10px] bg-[var(--v2-surface)]" />
          <Skeleton className="h-12 rounded-[10px] bg-[var(--v2-surface)]" />
        </div>
        <span className="sr-only">Loading example content</span>
      </Card>
    </div>
  )
}

function MovementExample({ from, to }: { from: string; to: string }) {
  return <TransactionMovement from={from} to={to} />
}

/** Generic placeholder icon for demos — 1.5 stroke, currentColor. */
function DotIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <circle cx="12" cy="12" r="6" />
    </svg>
  )
}

export default function DesignSystemPage() {
  const [modalOpen, setModalOpen] = useState(false)
  const [sampleAmount, setSampleAmount] = useState('')
  const { toast } = useToast()

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <PageHeader
        eyebrow="Internal reference"
        title="Haven design system"
        subtitle="The source of truth for Haven UI. Compose what's here before inventing new visual treatments — and add a new entry here in the same PR if you do."
        actions={
          <Button variant="ghost" size="sm" onClick={() => toast.info('Use shared primitives before adding a new pattern.')}>
            Show toast
          </Button>
        }
      />

      <Section
        title="How to use this page"
        description="Treat this as the contract for what a Haven screen looks and feels like. The workflow keeps the design language tight as the product grows."
      >
        <Card hover={false} className="p-5">
          <ol className="space-y-3 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            <li>
              <span className="font-medium text-[var(--v2-ink)]">1. Look here first.</span> Before building a
              new screen or polishing an existing one, scan this page for the primitive, pattern, or domain
              component that fits. Most needs are covered.
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">2. Compose, don&apos;t reinvent.</span> Build
              your surface from <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">@/components/ui</code>
              {' '}and <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">@/components/haven</code>{' '}
              exports. If you find yourself duplicating markup that already exists, refactor toward the
              shared primitive.
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">3. Add new entries in the same PR.</span> If
              the system genuinely lacks what you need — a new colour token, a new primitive, a new pattern
              — add it here alongside the implementation. Reviewers gate this: a PR that introduces a new
              UI shape without updating this page should be sent back.
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">4. Mind the copy conventions.</span> See the
              Copy section near the bottom for the user-facing language rules (we say <em>account</em>, not
              <em> Safe</em>; sentence case for modal titles, etc.).
            </li>
          </ol>
        </Card>
      </Section>

      <Section
        title="Colour tokens"
        description="Semantic colours, defined in `globals.css` as CSS custom properties. Always reference via `var(--v2-…)` — never hardcode hex. Each base colour ships a `-soft` variant for fills."
      >
        <Card hover={false} className="p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                name: '--v2-brand',
                soft: '--v2-brand-soft',
                use: 'Primary actions, links, brand identity.',
                swatch: 'border-[var(--v2-brand)]/30 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]',
              },
              {
                name: '--v2-success',
                soft: '--v2-success-soft',
                use: 'Incoming payments, completed states, positive money movement.',
                swatch: 'border-[var(--v2-success)]/30 bg-[var(--v2-success-soft)] text-[var(--v2-success)]',
              },
              {
                name: '--v2-debit',
                soft: '--v2-debit-soft',
                use: 'Outgoing payments, sent money. Sibling to success — never use for warnings.',
                swatch: 'border-[var(--v2-debit)]/30 bg-[var(--v2-debit-soft)] text-[var(--v2-debit)]',
              },
              {
                name: '--v2-warning',
                soft: '--v2-warning-soft',
                use: 'Needs attention, paused states, soft caution. Not for irreversible actions.',
                swatch: 'border-[var(--v2-warning)]/30 bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]',
              },
              {
                name: '--v2-danger',
                soft: '--v2-danger-soft',
                use: 'Errors, failures, destructive confirmations (revoke / delete).',
                swatch: 'border-[var(--v2-danger)]/30 bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]',
              },
              {
                name: '--v2-ink / -2 / -3',
                soft: '—',
                use: 'Text hierarchy. -ink is primary, -ink-2 secondary, -ink-3 quietest.',
                swatch: 'border-[var(--v2-border)] bg-white text-[var(--v2-ink)]',
              },
            ].map((token) => (
              <div
                key={token.name}
                className="flex gap-3 rounded-[10px] border border-[var(--v2-border)] bg-white p-3"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] border ${token.swatch}`}
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
                    <circle cx="12" cy="12" r="6" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <p className="font-mono text-xs font-medium text-[var(--v2-ink)]">{token.name}</p>
                  <p className="font-mono text-[11px] text-[var(--v2-ink-3)]">{token.soft}</p>
                  <p className="mt-1 text-xs leading-snug text-[var(--v2-ink-2)]">{token.use}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            <span className="font-medium text-[var(--v2-ink-2)]">Money colour rule:</span>{' '}
            <span className="text-[var(--v2-success)]">incoming = success green</span>,{' '}
            <span className="text-[var(--v2-debit)]">outgoing = debit sky</span>,{' '}
            <span className="text-[var(--v2-danger)]">failed = danger red</span>. The direction icon carries
            the colour. Outgoing amount text stays neutral ink so the row reads calm — only the icon
            carries the signal.
          </p>
        </Card>
      </Section>

      <Section
        title="Primitives"
        description="Core controls use the v2 token system from globals.css and the shared UI components."
      >
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <Card hover={false} className="p-5">
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Buttons and badges</h3>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button>Primary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="tertiary">Tertiary</Button>
              <Button variant="danger">Danger</Button>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <StatusBadge tone="success">Received</StatusBadge>
              <StatusBadge tone="warning">Needs approval</StatusBadge>
              <StatusBadge tone="danger">Failed</StatusBadge>
              <StatusBadge tone="brand">Connected</StatusBadge>
              <StatusBadge>Draft</StatusBadge>
            </div>
          </Card>

          <Card hover={false} className="p-5">
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Inputs, feedback, and modal</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-[var(--v2-ink-3)]">
                Amount
                <Input
                  className="mt-1 v2-tabular"
                  placeholder="0.00"
                  value={sampleAmount}
                  onChange={(event) => setSampleAmount(event.target.value)}
                  rightAction={<MaxButton onClick={() => setSampleAmount('250.00')} />}
                  helperText="Use Max when the full balance should be sent."
                />
              </label>
              <label className="block text-xs font-medium text-[var(--v2-ink-3)]">
                Recipient address
                <Input
                  className="mt-1 font-mono"
                  defaultValue=""
                  placeholder="0x..."
                  rightAction={<PasteButton onPaste={() => toast.success('Address pasted')} />}
                  invalid
                  helperText="Paste a valid wallet address."
                />
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Tooltip label={sampleAddress} mono>
                <button
                  type="button"
                  className="rounded font-mono text-xs text-[var(--v2-ink-2)] underline decoration-[var(--v2-border-strong)] underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
                >
                  0x8f4F...a6f4
                </button>
              </Tooltip>
              <Button variant="ghost" size="sm" onClick={() => setModalOpen(true)}>
                Open modal
              </Button>
              <Button size="sm" onClick={() => toast.success('Address copied')}>
                Copy feedback
              </Button>
            </div>
          </Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <Card hover={false} className="p-5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">Flat (default)</p>
            <p className="mt-2 text-sm font-semibold text-[var(--v2-ink)]">Standard card</p>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              The default. One page can have many flat cards. Hover lift on interactive variants.
            </p>
          </Card>

          <Card hover={false} elevation="anchor" className="p-5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--v2-brand)]">Anchor</p>
            <p className="mt-2 text-sm font-semibold text-[var(--v2-ink)]">Secondary focal point</p>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              Use for the second-most-important surface on a page (pending approvals, agent status). Cooler off-white background, brand-tinted hairline.
            </p>
          </Card>

          <Card hover={false} elevation="raised" className="p-5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">Raised</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
              $4,280.35
            </p>
            <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
              The single page hero (balance, total). Hover lift suppressed — it's already prominent.
            </p>
          </Card>
        </div>
      </Section>

      <Section
        title="Card.Section — nested content without grey-on-white"
        description="When you need to group content inside a card, use Card.Section instead of a grey inner wrapper. Renders a hairline top border that bleeds to the card's edges — the canonical way to subsection a card. Avoid nesting a second `<Card>` (or a grey-on-white inner box) inside a card whenever Card.Section will do."
      >
        <Card hover={false} className="p-5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Operating wallet</h3>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Base · 0x8f4F…6f4C</p>
          </div>
          <Card.Section className="mt-5 pt-5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">Holdings</p>
            <dl className="mt-2 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-[var(--v2-ink-2)]">USDC</dt>
              <dd className="text-right v2-tabular text-[var(--v2-ink)]">4,280.35</dd>
              <dt className="text-[var(--v2-ink-2)]">ETH</dt>
              <dd className="text-right v2-tabular text-[var(--v2-ink)]">0.482</dd>
            </dl>
          </Card.Section>
          <Card.Section className="mt-5 pt-5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">Approvers</p>
            <p className="mt-2 text-sm text-[var(--v2-ink-2)]">2 of 3 approvers required</p>
          </Card.Section>
        </Card>
        <p className="text-xs text-[var(--v2-ink-3)]">
          Reserve <code className="font-mono">inset</code> only for code blocks or quote-style content — the default hairline style is the standard.
        </p>
      </Section>

      <Section
        title="Row — the canonical list item"
        description="One primitive for every list row in the app. Slots: leading icon (with optional tinted circle), title, subtitle, trailing. Hover and focus styles are baked in for interactive variants. Density toggles between comfortable lists and compact panels."
      >
        <Card hover={false} className="overflow-hidden">
          <Row
            leading={<DotIcon />}
            leadingTone="brand"
            title="Operating wallet"
            subtitle="Base · 0x8f4F…6f4C"
            trailing={<StatusBadge tone="brand">Default</StatusBadge>}
            href="#"
          />
          <Row
            leading={<DotIcon />}
            leadingTone="success"
            title="Trip wallet"
            subtitle="Base · 0x31bc…8d04"
            trailing={<span className="v2-tabular text-sm font-semibold text-[var(--v2-ink)]">75.00 EURe</span>}
            href="#"
          />
          <Row
            leading={<DotIcon />}
            leadingTone="warning"
            title="Research assistant"
            subtitle="Needs approval · 2 pending"
            trailing={<StatusBadge tone="warning">Review</StatusBadge>}
            accent
            href="#"
          />
        </Card>
        <Card hover={false} className="overflow-hidden">
          <Row
            density="compact"
            leading={<DotIcon />}
            title="Compact row"
            subtitle="Tighter padding for dense panels"
            trailing={<span className="text-xs text-[var(--v2-ink-3)]">12m ago</span>}
          />
          <Row
            density="compact"
            leading={<DotIcon />}
            title="Static row"
            subtitle="No href / onClick — renders as a div, no hover"
          />
        </Card>
      </Section>

      <Section
        title="Dropdown menu (kebab)"
        description="Overflow menu used for account-, agent-, or row-level settings that shouldn't compete with the page's primary CTAs. The trigger is usually a `⋮` icon button (10×10 / h-10 to match Button md). Items support a `tone='danger'` for destructive actions and a `<DropdownMenuSeparator />` between groups."
      >
        <Card hover={false} className="p-5">
          <div className="flex flex-wrap items-center gap-6">
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account options"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <circle cx="12" cy="5" r="1.25" />
                  <circle cx="12" cy="12" r="1.25" />
                  <circle cx="12" cy="19" r="1.25" />
                </svg>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => toast.info('Edit agent')}>Edit agent</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => toast.info('Update budget')}>Update budget</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => toast.info('Payment credentials')}>
                  Payment credentials
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => toast.error('Remove (demo only)')}>
                  Remove agent
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="max-w-md text-xs leading-relaxed text-[var(--v2-ink-3)]">
              Used on `/agents/[id]` and `/accounts/[id]` page headers. Click-outside + Escape dismiss,
              arrow-key roving focus, ARIA roles wired. Use sparingly — visible CTAs are still preferred
              when there are only one or two actions.
            </p>
          </div>
        </Card>
      </Section>

      <Section
        title="Direction marks (in / out / pending)"
        description="One shared `<DirectionMark>` for every transaction row in the app. Incoming uses success green, outgoing uses debit sky, pending uses neutral grey. Density `compact` (32px) for dashboard rows, `comfortable` (36px, default) for the dedicated transactions table."
      >
        <Card hover={false} className="p-5">
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex flex-col items-center gap-1">
              <DirectionMark direction="in" />
              <p className="text-xs text-[var(--v2-ink-3)]">in · comfortable</p>
            </div>
            <div className="flex flex-col items-center gap-1">
              <DirectionMark direction="out" />
              <p className="text-xs text-[var(--v2-ink-3)]">out · comfortable</p>
            </div>
            <div className="flex flex-col items-center gap-1">
              <DirectionMark direction="neutral" />
              <p className="text-xs text-[var(--v2-ink-3)]">pending · comfortable</p>
            </div>
            <div className="ml-4 flex flex-col items-center gap-1">
              <DirectionMark direction="in" density="compact" />
              <p className="text-xs text-[var(--v2-ink-3)]">in · compact</p>
            </div>
            <div className="flex flex-col items-center gap-1">
              <DirectionMark direction="out" density="compact" />
              <p className="text-xs text-[var(--v2-ink-3)]">out · compact</p>
            </div>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            Don&apos;t reinline this markup. If you need a new direction state, add it to{' '}
            <code className="rounded bg-[var(--v2-surface)] px-1">DirectionMark</code> and document it here.
          </p>
        </Card>
      </Section>

      <Section
        title="Empty states"
        description="Pick a tone that matches the meaning (brand for default, warning for attention, success after a completed flow). The leading icon sits in a soft tinted circle with a faint halo — gives the surface a focal point without illustration overhead."
      >
        <div className="grid gap-5 lg:grid-cols-3">
          <EmptyState
            icon={<DotIcon />}
            tone="brand"
            title="No agents yet"
            body="Create an agent to give it a budget and rules. Haven asks for approval when it tries to spend more."
            action={<Button size="sm">Create agent</Button>}
          />
          <EmptyState
            icon={<DotIcon />}
            tone="warning"
            title="One agent needs attention"
            body="A scheduled payment is above its remaining budget. Approve or reject it before it expires."
            action={<Button size="sm" variant="ghost">Open approvals</Button>}
          />
          <EmptyState
            icon={<DotIcon />}
            tone="success"
            title="You're all caught up"
            body="No pending approvals. Agents will keep working within their budgets."
          />
        </div>
      </Section>

      <Section
        title="First-run setup"
        description="A three-step checklist anchors a new user. Each step's status is computed independently from real state — agents and funds can be completed in any order. The active step gets the primary CTA; later steps lock until their prerequisite lands. When all three are done, the guide collapses to a Setup complete banner."
      >
        <div className="max-w-3xl space-y-4">
          {/* Active: fund step open, agent + payment steps still pending. */}
          <DashboardOnboardingGuide
            hasFunds={false}
            hasAgents={false}
            hasFirstAgentPayment={false}
            onReceiveFunds={() => undefined}
            onAddAgent={() => undefined}
            onShowAgentUsage={() => undefined}
            onDismiss={() => undefined}
            onDismissComplete={() => undefined}
            inProgressDismissed={false}
            completeDismissed={false}
          />
          {/* All three done — the celebration banner. */}
          <DashboardOnboardingGuide
            hasFunds
            hasAgents
            hasFirstAgentPayment
            onReceiveFunds={() => undefined}
            onAddAgent={() => undefined}
            onShowAgentUsage={() => undefined}
            onDismiss={() => undefined}
            onDismissComplete={() => undefined}
            inProgressDismissed={false}
            completeDismissed={false}
          />
        </div>
      </Section>

      <Section
        title="Agent budget flow"
        description="These examples anchor the first Haven-domain component layer. They explain what the agent can spend without exposing implementation details."
      >
        <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
          <AgentBudgetCard
            agentName="Research assistant"
            walletName="Operating wallet"
            budgets={[{ tokenSymbol: 'USDC', amount: '250', period: 'per day' }]}
            status="Ready to review"
          >
            <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Requests above the remaining daily budget will wait for your approval.
            </p>
          </AgentBudgetCard>

          <AgentBudgetCard
            agentName="Travel planner"
            walletName="Trip wallet"
            budgets={[
              { tokenSymbol: 'USDC', amount: '1', period: 'per day' },
              { tokenSymbol: 'ETH', amount: '1', period: 'per day' },
            ]}
            status="Budget draft"
            onRemoveBudget={() => {}}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
          <AgentRulesSummary
            items={[
              {
                label: 'Who can spend',
                value: 'Research assistant',
                helper: 'This agent can request payments using its Haven credential.',
              },
              {
                label: 'From wallet',
                value: 'Operating wallet',
                helper: 'Payments come from this Haven wallet only.',
              },
              {
                label: 'Budget',
                value: '250 USDC per day',
                helper: 'Haven asks for approval when a request is above the remaining budget.',
              },
            ]}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <ApprovalRequiredBanner tone="neutral">
            Agents can still initiate payments above the remaining budget, but you approve them manually before any money moves.
          </ApprovalRequiredBanner>
          <RiskExplainer
            items={[
              'The agent can make payments automatically while it stays within the budget.',
              'You can pause or revoke the agent from its detail page.',
              'Haven asks for approval before requests above the remaining budget are paid.',
            ]}
          />
        </div>
      </Section>

      <Section
        title="Credential handoff"
        description="Use an action-required card for post-setup credentials. The full credential file should be the default because it includes the context an agent needs."
      >
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <CredentialHandoffCard
            title="Save the credential file"
            description="Download or copy this file before closing. Your agent needs it to make payments within the rules you set."
            primaryAction={<Button className="w-full">Download file</Button>}
            secondaryAction={<Button className="w-full" variant="ghost">Copy file</Button>}
            note="This credential is shown once. Haven cannot show it again after the window closes."
          />
          <AgentBudgetCard
            agentName="Research assistant"
            walletName="Operating wallet"
            budgets={[{ tokenSymbol: 'USDC', amount: '250', period: 'per day' }]}
            status="Connected"
            statusTone="success"
            density="compact"
          />
        </div>
      </Section>

      <Section
        title="Approvals and pending actions"
        description="Approval requests lead with the money, show who asked, and make the wallet-to-recipient path readable before the user approves or rejects."
      >
        <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <Card hover={false} className="overflow-hidden border-[var(--v2-warning)]/25">
            <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="warning">Needs approval</StatusBadge>
                  <StatusBadge>x402 payment</StatusBadge>
                </div>
                <span className="text-xs text-[var(--v2-ink-3)]">Expires in 1 hour</span>
              </div>
            </div>
            <div className="space-y-5 p-5">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.9fr)]">
                <div>
                  <p className="text-xs font-medium text-[var(--v2-ink-3)]">Payment request</p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
                    48.00 USDC
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-[var(--v2-ink-2)]">
                    Research assistant asked to send this payment. Nothing moves until you approve it.
                  </p>
                </div>
                <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                  <TransactionMovement from="Operating wallet" to="api.vendor.com" />
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-[11px] font-medium text-[var(--v2-ink-3)]">Agent</dt>
                      <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Research assistant</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-medium text-[var(--v2-ink-3)]">Network</dt>
                      <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Base</dd>
                    </div>
                  </dl>
                </div>
              </div>
              <ApprovalRequiredBanner title="Approval required" tone="neutral" density="compact">
                This payment is above the remaining agent budget.
              </ApprovalRequiredBanner>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" size="sm">Reject</Button>
                <Button size="sm">Approve payment</Button>
              </div>
            </div>
          </Card>

          <div className="space-y-4">
            <ApprovalRequiredBanner title="Approved, not sent yet" tone="neutral" density="compact">
              This request was approved but still needs to be completed before the payment is sent.
            </ApprovalRequiredBanner>
            <EmptyState
              title="No payments need approval"
              body="When an agent asks to spend above its budget, the request will appear here before any money moves."
            />
          </div>
        </div>
      </Section>

      <Section
        title="Manual payment review"
        description="Manual sends use the same money-first review structure as approvals: amount first, then the wallet-to-recipient path and approval context."
      >
        <Card hover={false} className="max-w-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[var(--v2-ink-3)]">You are sending</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
                125.00 USDC
              </p>
            </div>
            <StatusBadge>Ready to send</StatusBadge>
          </div>
          <div className="mt-5 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <TransactionMovement from="Operating wallet" to="Acme Services" />
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-[11px] font-medium text-[var(--v2-ink-3)]">Haven wallet</dt>
                <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Operating wallet</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-[var(--v2-ink-3)]">Recipient</dt>
                <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Acme Services</dd>
                <dd className="mt-0.5 font-mono text-[11px] text-[var(--v2-ink-3)]">0x7a58...91c2</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-[var(--v2-ink-3)]">Network</dt>
                <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Base</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-[var(--v2-ink-3)]">Approve with</dt>
                <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Device approval</dd>
              </div>
            </dl>
          </div>
          <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
            Network fees are paid by Haven (ETH).
          </p>
          <div className="mt-5 flex gap-3">
            <Button variant="ghost" className="flex-1">Back</Button>
            <Button className="flex-1">Approve and send</Button>
          </div>
        </Card>
      </Section>

      <Section
        title="Contacts and recipients"
        description="Recipient surfaces show names first, keep wallet addresses subordinate, and preserve direct address entry for one-off payments."
      >
        <Card hover={false} className="max-w-xl overflow-hidden p-0">
          <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Saved recipients</h3>
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Use names for people and services you pay often. Confirm the network in Send.</p>
              </div>
              <Button size="sm" className="flex-shrink-0 whitespace-nowrap">
                Add contact
              </Button>
            </div>
          </div>
          {[
            ['Acme Services', '0x7a58...91c2'],
            ['Research API', '0x31bc...8d04'],
          ].map(([name, address]) => (
            <div key={name} className="flex items-center gap-3 border-b border-[var(--v2-border)] px-5 py-3 last:border-b-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--v2-brand)]/20 bg-[var(--v2-brand-soft)]">
                <span className="text-xs font-semibold text-[var(--v2-brand)]">{name.slice(0, 2).toUpperCase()}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{name}</p>
                <p className="mt-0.5 font-mono text-xs text-[var(--v2-ink-3)]">{address}</p>
              </div>
              <StatusBadge tone="neutral">Recipient</StatusBadge>
            </div>
          ))}
        </Card>
      </Section>

      <Section
        title="Receive funds"
        description="Manual funding surfaces must make the Haven wallet, network, supported tokens, and copy action obvious before the user sends anything on-chain."
      >
        <Card hover={false} className="max-w-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--v2-ink)]">Operating wallet</p>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Base</p>
            </div>
            <StatusBadge>On-chain receive</StatusBadge>
          </div>
          <div className="mt-5 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Haven wallet address</p>
            <p className="mt-2 break-all font-mono text-sm text-[var(--v2-ink)]">{sampleAddress}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm">Copy address</Button>
              <Button variant="ghost" size="sm">Show QR code</Button>
              <Button variant="ghost" size="sm" href="#" target="_blank" rel="noopener noreferrer">
                View on explorer
              </Button>
            </div>
          </div>
          <div className="mt-4 rounded-[10px] border border-[var(--v2-border)] bg-white p-4">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Supported on Base</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {['ETH', 'USDC'].map((token) => (
                <span
                  key={token}
                  className="rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface)] px-2.5 py-1 text-xs font-medium text-[var(--v2-ink-2)]"
                >
                  {token}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <p className="text-sm font-semibold text-[var(--v2-ink)]">Before you send</p>
            <p className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
              Use the Base network, send only supported tokens, and wait for the on-chain transfer to confirm.
            </p>
          </div>
        </Card>
      </Section>

      <Section
        title="Wallet and activity"
        description="Wallet identity and activity rows should make account context readable without making raw addresses the primary object."
      >
        <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
          <WalletIdentityBlock
            name="Operating wallet"
            network="Gnosis Chain"
            address={sampleAddress}
            balance="$4,280.35 available"
          />

          <Card hover={false} className="overflow-hidden">
            <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Recent agent activity</h3>
            </div>
            <AgentActivityRow
              title="x402 payment"
              description={<MovementExample from="Research assistant" to="API provider" />}
              amount="-12.00 USDC"
              status="Sent"
              statusTone="neutral"
            />
            <AgentActivityRow
              title="Approval request"
              description={<MovementExample from="Research assistant" to="Cloud vendor" />}
              amount="-320.00 USDC"
              status="Needs approval"
              statusTone="warning"
            />
            <AgentActivityRow
              title="Payment rejected"
              description={<MovementExample from="Research assistant" to="Unknown vendor" />}
              amount="-80.00 USDC"
              amountTone="danger"
              status="Failed"
              statusTone="danger"
            />
          </Card>
        </div>
      </Section>

      <Section
        title="Transaction history"
        description="The full transaction route uses a semantic sortable table. Compact TransactionActivityRow remains for dashboard, account, and agent previews."
      >
        <Card hover={false} className="overflow-hidden">
          <table className="w-full border-separate border-spacing-0">
            <thead className="hidden md:table-header-group">
              <tr>
                <th className="w-10 border-b border-[var(--v2-border)] bg-[var(--v2-bg)] px-4 py-3" scope="col">
                  <span className="sr-only">Direction</span>
                </th>
                <th className="border-b border-[var(--v2-border)] bg-[var(--v2-bg)] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]" scope="col">
                  Activity
                </th>
                <th className="border-b border-[var(--v2-border)] bg-[var(--v2-bg)] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]" scope="col">
                  Initiator
                </th>
                <th className="border-b border-[var(--v2-border)] bg-[var(--v2-bg)] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]" scope="col">
                  From / To
                </th>
                <th className="border-b border-[var(--v2-border)] bg-[var(--v2-bg)] px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]" scope="col" aria-sort="descending">
                  <button
                    type="button"
                    aria-label="Sort by Date, currently descending"
                    className="inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
                  >
                    Date
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </th>
                <th className="border-b border-[var(--v2-border)] bg-[var(--v2-bg)] px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wide text-[var(--v2-ink-3)]" scope="col" aria-sort="none">
                  <button
                    type="button"
                    aria-label="Sort by Amount, currently unsorted"
                    className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
                  >
                    Amount
                  </button>
                </th>
                <th className="w-8 border-b border-[var(--v2-border)] bg-[var(--v2-bg)] px-4 py-3" scope="col">
                  <span className="sr-only">External details</span>
                </th>
              </tr>
            </thead>
            <tbody className="[&>tr>td]:border-b [&>tr>td]:border-[var(--v2-border)] [&>tr:last-child>td]:border-b-0">
              {[
                {
                  title: 'Received payment',
                  from: 'Acme Operations',
                  to: 'Operating wallet',
                  initiator: 'You',
                  date: '12m ago',
                  amount: '+500.00 USDC',
                  amountClass: 'text-[var(--v2-success)]',
                  direction: 'in' as const,
                  failed: false,
                },
                {
                  title: 'x402 payment by Research assistant',
                  from: 'Operating wallet',
                  to: 'API provider',
                  initiator: 'Research assistant',
                  date: '1h ago',
                  amount: '-12.00 USDC',
                  amountClass: 'text-[var(--v2-ink)]',
                  direction: 'out' as const,
                  failed: false,
                },
                {
                  title: 'Failed payment by Research assistant',
                  from: 'Operating wallet',
                  to: 'unknown.vendor',
                  initiator: 'Research assistant',
                  date: '2h ago',
                  amount: '-25.00 USDC',
                  amountClass: 'text-[var(--v2-danger)]',
                  direction: 'out' as const,
                  failed: true,
                },
              ].map((row) => (
                <tr key={row.title}>
                  <td className="px-4 py-4 align-middle">
                    <DirectionMark direction={row.direction} />
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-[var(--v2-ink)]">{row.title}</p>
                      {row.failed ? <StatusBadge tone="danger">Failed</StatusBadge> : null}
                    </div>
                    <div className="mt-1 md:hidden">
                      <TransactionMovement from={row.from} to={row.to} />
                    </div>
                  </td>
                  <td className="hidden px-4 py-4 align-middle text-sm text-[var(--v2-ink-2)] md:table-cell">
                    {row.initiator}
                  </td>
                  <td className="hidden px-4 py-4 align-middle md:table-cell">
                    <TransactionMovement from={row.from} to={row.to} />
                  </td>
                  <td className="hidden px-4 py-4 align-middle text-sm text-[var(--v2-ink-3)] md:table-cell">
                    {row.date}
                  </td>
                  <td className="px-4 py-4 align-middle text-right">
                    <p className={`text-sm font-semibold v2-tabular ${row.amountClass}`}>{row.amount}</p>
                    <p className="mt-1 text-xs text-[var(--v2-ink-3)] md:hidden">{row.date}</p>
                  </td>
                  <td className="px-4 py-4 align-middle text-right">
                    <ExternalDetailsLink href="#" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>

      <Section
        title="Card with action footer (manage pattern)"
        description="When a card has both content and contextual actions, use `AgentRulesSummary`'s `footer` slot (or any card with a `border-t` action row) instead of a separate aside card. Keeps related actions adjacent to the data they affect and avoids empty right-rail real estate."
      >
        <AgentRulesSummary
          title="Agent budget"
          description="What this agent can spend, where the money comes from, and how you stay in control."
          items={[
            {
              label: 'Who can spend',
              value: 'Research assistant',
              helper: 'Connected via Haven credential.',
            },
            {
              label: 'From account',
              value: 'Operating wallet on Gnosis Chain',
              helper: 'Payments come from this Haven account only.',
            },
            {
              label: 'Budget',
              value: '250 USDC per day',
              helper: 'Payments within budget can run automatically. Larger payments need your manual approval.',
            },
          ]}
          footer={
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-[var(--v2-ink-3)]">
                Pause the agent or revoke its budget if you need to stop access.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm">
                  Update budget
                </Button>
                <Button variant="ghost" size="sm">
                  Pause agent
                </Button>
                <Button variant="danger" size="sm">
                  Revoke agent budget
                </Button>
              </div>
            </div>
          }
        />
      </Section>

      <Section
        title="Wallet-gate captions"
        description="When an action is gated on a connected / correctly-networked wallet, render a quiet info-icon caption above the (disabled) primary button — NEVER a yellow alert block beside or instead of the button. The yellow background reads as interactive. Helpers live in `OnchainActionGate` / `NetworkGate` and apply everywhere automatically."
      >
        <Card hover={false} className="p-5">
          <div className="space-y-4">
            <div>
              <p
                role="status"
                className="mb-2 flex items-start gap-2 text-xs text-[var(--v2-ink-3)]"
              >
                <svg
                  aria-hidden="true"
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v5" strokeLinecap="round" />
                  <circle cx="12" cy="8" r="0.6" fill="currentColor" />
                </svg>
                <span>Connect a wallet to update this agent budget.</span>
              </p>
              <div className="flex gap-3">
                <Button variant="ghost" className="flex-1">Back</Button>
                <Button disabled className="flex-1">Update budget</Button>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
              <span className="font-medium text-[var(--v2-ink-2)]">Pattern:</span> caption above, disabled
              primary button below. For a network-mismatch the same caption sits above a ghost{' '}
              <code className="rounded bg-[var(--v2-surface)] px-1">Switch wallet to {'{chain}'}</code>{' '}
              button (white background, brand focus ring) instead of the primary action.
            </p>
          </div>
        </Card>
      </Section>

      <Section
        title="Copy conventions"
        description="The words we use are part of the design system. Follow these rules so the product reads as one voice."
      >
        <Card hover={false} className="p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Account, not Safe</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Users see <span className="font-medium">account</span>. The Safe contract abstraction stays
                in code (<code className="text-[11px]">safeId</code>,{' '}
                <code className="text-[11px]">UserSafe</code>, etc.). The word <em>Safe</em> should not
                appear in any rendered string.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Sentence case</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Modal titles, section headings, button labels — all sentence case. <em>"Edit agent"</em>,
                not <em>"Edit Agent"</em>. <em>"Update budget"</em>, not <em>"Update Budget"</em>.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Money is calm</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Amount text stays neutral ink — even for outgoing payments. The direction icon carries the
                colour signal (green / sky / red). Don&apos;t tint amounts unless they failed.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Action verbs match the noun</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Pause the <em>agent</em>, not <em>requests</em>. Revoke the <em>budget</em>, not{' '}
                <em>access</em>. The label should describe the user&apos;s mental model, not the
                implementation detail.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Confirm destructive actions</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Anything that can&apos;t be reversed (revoke, remove account, remove token budget, delete
                agent) opens a <code className="text-[11px]">ConfirmDialog</code> with a clear destructive
                button label. Reversible actions (pause / resume) don&apos;t need confirmation.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Quiet for hints, loud for failures</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Wallet gates, summary captions, "loaded results" — caption-grey. Errors and failed states
                — danger red. Don&apos;t mix the two.
              </p>
            </div>
          </div>
        </Card>
      </Section>

      <Section
        title="Info modals (InfoStep + InfoNote)"
        description="Multi-step explainer modals (Contacts info, Using your agent) use the paged InfoModal primitive. Inside each page, compose with `InfoStep` for numbered explanations and `InfoNote` for footnotes / tinted asides — both export from `@/components/InfoModal`."
      >
        <Card hover={false} className="p-5">
          <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
            Open <code className="rounded bg-[var(--v2-surface)] px-1">UsingYourAgentInfo</code> or{' '}
            <code className="rounded bg-[var(--v2-surface)] px-1">ContactsInfo</code> from the dashboard to
            see them in flight. Helpers in <code className="rounded bg-[var(--v2-surface)] px-1">InfoModal.tsx</code>:
          </p>
          <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
            <li>
              <code className="rounded bg-[var(--v2-surface)] px-1">&lt;InfoStep number={1} title="..."&gt;</code>{' '}
              — numbered brand-soft circle + 14px title + 13px body. Use 1–3 per page.
            </li>
            <li>
              <code className="rounded bg-[var(--v2-surface)] px-1">&lt;InfoNote label="..."&gt;</code>{' '}
              — tinted footnote box for caveats / "where do I find this?" asides.
            </li>
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            <span className="font-medium text-[var(--v2-ink-2)]">Don&apos;t inline 11px helper text</span> —
            grep the codebase: if you see <code className="text-[11px]">text-[10px]</code> or{' '}
            <code className="text-[11px]">text-[11px]</code> inside a modal, it&apos;s probably a missed
            migration. Bump to <code className="text-[11px]">text-xs</code> or compose with the helpers.
          </p>
        </Card>
      </Section>

      <Section
        title="States"
        description="Important Haven screens need stable loading, empty, and error states because AI-generated UX often only covers the happy path."
      >
        <div className="grid gap-5 lg:grid-cols-3">
          <LoadingCard />
          <EmptyState
            title="No agent budgets yet"
            body="Create a budget to let an agent make payments within rules you control."
            action={<Button size="sm">Create agent budget</Button>}
          />
          <EmptyState
            title="We could not load this wallet"
            body="Check your network connection, then try again. Existing agent budgets are unchanged."
            action={<Button size="sm" variant="ghost">Try again</Button>}
          />
        </div>
      </Section>

      <Section
        title="Mobile density"
        description="Cards should stack cleanly and keep the money and approval boundary visible on narrow screens."
      >
        <div className="max-w-sm rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
          <div className="space-y-3">
            <AgentBudgetCard
              agentName="Travel planner"
              walletName="Trip wallet"
              budgets={[{ tokenSymbol: 'EURe', amount: '75', period: 'total budget' }]}
              status="Connected"
              statusTone="success"
            />
            <ApprovalRequiredBanner title="You stay in control" tone="neutral">
              Anything above 75 EURe waits for your manual approval before it is paid.
            </ApprovalRequiredBanner>
          </div>
        </div>
      </Section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Review agent rules"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setModalOpen(false)}>Save rules</Button>
          </>
        }
      >
        Confirm the agent budget before connecting your agent. Requests above the remaining
        budget will wait for approval.
      </Modal>
    </div>
  )
}
