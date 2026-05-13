'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input, MaxButton, PasteButton } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
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

export default function DesignSystemPage() {
  const [modalOpen, setModalOpen] = useState(false)
  const [sampleAmount, setSampleAmount] = useState('')
  const { toast } = useToast()

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <PageHeader
        eyebrow="Internal reference"
        title="Haven design system"
        subtitle="Use this page before changing product UX. It shows the primitives and Haven-specific patterns Codex should compose instead of inventing new visual treatments."
        actions={
          <Button variant="ghost" size="sm" onClick={() => toast.info('Use shared primitives before adding a new pattern.')}>
            Show toast
          </Button>
        }
      />

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

        <Card hover={false} elevation="raised" className="p-5">
          <p className="text-xs font-medium text-[var(--v2-ink-3)]">Raised card example</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
            $4,280.35
          </p>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
            Reserve raised elevation for page-anchor surfaces such as a balance hero or account total.
          </p>
        </Card>
      </Section>

      <Section
        title="First-run setup"
        description="Dashboard setup guidance should stay sparse: one next step, one primary action, and no full dashboard density until the user dismisses setup."
      >
        <div className="max-w-3xl">
          <DashboardOnboardingGuide
            stage="fund"
            onReceiveFunds={() => undefined}
            onAddAgent={() => undefined}
            onDismiss={() => undefined}
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
            amount="250 USDC"
            resetPeriod="per day"
            status="Ready to review"
          >
            <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Requests above the remaining daily budget will wait for your approval.
            </p>
          </AgentBudgetCard>

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
            amount="250 USDC"
            resetPeriod="per day"
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
                  directionClass: 'border-[var(--v2-success)]/20 bg-[var(--v2-success-soft)] text-[var(--v2-success)]',
                  direction: 'in',
                },
                {
                  title: 'x402 payment by Research assistant',
                  from: 'Operating wallet',
                  to: 'API provider',
                  initiator: 'Research assistant',
                  date: '1h ago',
                  amount: '-12.00 USDC',
                  amountClass: 'text-[var(--v2-ink)]',
                  directionClass: 'border-[var(--v2-border)] bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]',
                  direction: 'out',
                },
              ].map((row) => (
                <tr key={row.title}>
                  <td className="px-4 py-4 align-middle">
                    <span
                      aria-hidden="true"
                      className={`flex h-9 w-9 items-center justify-center rounded-[10px] border ${row.directionClass}`}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        {row.direction === 'in' ? (
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m0 0l-5-5m5 5l5-5" />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-5 5m5-5l5 5" />
                        )}
                      </svg>
                    </span>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <p className="text-sm font-semibold text-[var(--v2-ink)]">{row.title}</p>
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
              amount="75 EURe"
              resetPeriod="total budget"
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
