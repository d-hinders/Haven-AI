'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/ui/StatusBadge'
import {
  AgentBudgetCard,
  AgentRulesSummary,
  ApprovalRequiredBanner,
  CredentialHandoffCard,
  RiskExplainer,
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

function TransactionActivityRow({
  title,
  description,
  amount,
  status,
}: {
  title: string
  description: string
  amount: string
  status: 'Settled' | 'Needs approval' | 'Failed'
}) {
  const tone = status === 'Settled' ? 'success' : status === 'Needs approval' ? 'warning' : 'danger'

  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--v2-border)] px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{title}</p>
          <StatusBadge tone={tone}>{status}</StatusBadge>
        </div>
        <p className="mt-1 truncate text-xs text-[var(--v2-ink-2)]">{description}</p>
      </div>
      <p className="flex-shrink-0 text-sm font-semibold text-[var(--v2-ink)] v2-tabular">{amount}</p>
    </div>
  )
}

function LoadingCard() {
  return (
    <Card hover={false} className="p-5">
      <div className="h-4 w-28 rounded bg-[var(--v2-surface-2)] animate-pulse" />
      <div className="mt-5 h-8 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="h-12 rounded-[10px] bg-[var(--v2-surface)] animate-pulse" />
        <div className="h-12 rounded-[10px] bg-[var(--v2-surface)] animate-pulse" />
      </div>
    </Card>
  )
}

export default function DesignSystemPage() {
  const [modalOpen, setModalOpen] = useState(false)

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <div className="border-b border-[var(--v2-border)] pb-6">
        <p className="text-xs font-medium text-[var(--v2-brand)]">Internal reference</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">
          Haven design system
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
          Use this page before changing product UX. It shows the primitives and Haven-specific
          patterns Codex should compose instead of inventing new visual treatments.
        </p>
      </div>

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
              <StatusBadge tone="success">Settled</StatusBadge>
              <StatusBadge tone="warning">Needs approval</StatusBadge>
              <StatusBadge tone="danger">Failed</StatusBadge>
              <StatusBadge tone="brand">Connected</StatusBadge>
              <StatusBadge>Draft</StatusBadge>
            </div>
          </Card>

          <Card hover={false} className="p-5">
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Inputs and modal</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-[var(--v2-ink-3)]">
                Agent name
                <Input className="mt-1" defaultValue="Research assistant" />
              </label>
              <label className="block text-xs font-medium text-[var(--v2-ink-3)]">
                Budget period
                <Select className="mt-1" defaultValue="day">
                  <option value="day">Per day</option>
                  <option value="week">Per week</option>
                  <option value="month">Per month</option>
                </Select>
              </label>
            </div>
            <Button className="mt-4" variant="ghost" onClick={() => setModalOpen(true)}>
              Open modal
            </Button>
          </Card>
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
        description="Use a neutral card for the post-setup file. The full credential file should be the default because it includes the context an agent needs."
      >
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <CredentialHandoffCard
            title="Save the credential file"
            description="The file includes the Haven credential, agent budget, account context, and SDK quickstart."
            primaryAction={<Button className="w-full">Download file</Button>}
            secondaryAction={<Button className="w-full" variant="ghost">Copy file</Button>}
            note="This credential is shown once. Save the file before closing."
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
            <TransactionActivityRow
              title="Paid API provider"
              description="Research assistant used the Operating wallet"
              amount="-12.00 USDC"
              status="Settled"
            />
            <TransactionActivityRow
              title="Cloud inference request"
              description="Above the remaining daily budget"
              amount="-320.00 USDC"
              status="Needs approval"
            />
            <TransactionActivityRow
              title="Rejected vendor payment"
              description="The request was blocked by your agent rules"
              amount="-80.00 USDC"
              status="Failed"
            />
          </Card>
        </div>
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
          <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] p-5">
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">We could not load this wallet</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Check your network connection, then try again. Existing agent budgets are unchanged.
            </p>
            <Button className="mt-4" size="sm" variant="ghost">
              Try again
            </Button>
          </div>
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
