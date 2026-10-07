'use client'

import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { accountWithChainLabel } from '@/lib/account-label'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { InlineErrorNote, WarningCallout } from './SetupNotices'

/**
 * Step 2: wallet choice, the agent's single USDC budget, and the passport
 * opt-in. #1377 B: one budget by design — USDC is a fixed chip (no token
 * select) and a valid amount alone enables Continue. #1381: the inputs ARE
 * the draft — nothing mounts below them mid-typing, so the confirmation the
 * old Review step carried is a single summary LINE, always mounted with
 * reserved height, under the fields (#3688). Additional tokens for legacy
 * multi-token accounts are added later from the agent's page.
 *
 * #1411: no rhythm of its own — see DetailsStep's note. Root is a Fragment;
 * the shared `flex flex-col gap-5` wrapper in ConnectAgentModal owns the
 * 20px field-to-field spacing.
 */
export function PolicyStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  return (
    <>
      {flow.hasMultipleAccounts && (
        <div>
          <label htmlFor="connect-agent-safe" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
            Spend from
          </label>
          <Select
            id="connect-agent-safe"
            value={flow.selectedAccountId ?? ''}
            onChange={(event) => flow.setSelectedAccountId(event.target.value)}
            disabled={flow.creating}
          >
            {flow.selectableAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {accountWithChainLabel(account)}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div>
        <p className="mb-1.5 text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">Agent budget</p>
        <div className="grid grid-cols-3 gap-2">
          <div
            aria-label="Budget token"
            className="flex items-center justify-center rounded-[10px] bg-[var(--v2-surface-2)] px-3 text-sm font-medium text-[var(--v2-ink-2)]"
          >
            {flow.budgetToken?.symbol ?? 'USDC'}
          </div>
          <Input
            id="connect-agent-budget-amount"
            type="text"
            inputMode="decimal"
            value={flow.addAmount}
            onChange={(event) => flow.handleAddAmountChange(event.target.value)}
            placeholder="Amount"
            invalid={Boolean(flow.addAmountMessage)}
            helperText={flow.addAmountMessage || undefined}
            className="v2-tabular"
            disabled={flow.creating}
          />
          <Select
            aria-label="Budget reset period"
            value={flow.addReset}
            onChange={(event) => flow.setAddReset(Number(event.target.value))}
            disabled={flow.creating}
          >
            {flow.resetPeriodOptions.map((period) => (
              <option key={period.value} value={period.value}>
                {period.label}
              </option>
            ))}
          </Select>
        </div>
        <p className="mt-1.5 text-xs text-[var(--v2-ink-3)]">
          Setup grants one {flow.budgetToken?.symbol ?? 'USDC'} budget, approved
          with a single signature. More tokens can be added from the
          agent&apos;s page once it is running.
        </p>
      </div>

      {/* #1411: the Agent Passport opt-in keeps Checkbox weight — it mints an
          on-chain attestation, a real decision, not a footnote — but the copy
          tightens to one outcome-first sentence plus one short helper line,
          matching every other helper in the flow instead of a three-line
          explainer. */
      /* ink-2, NOT ink-3: the Checkbox primitive renders helperText at ink-3
          by design, so the label must sit one tier darker for the built-in
          label/helper hierarchy to read — an on-chain attestation is a
          decision, not a footnote (design review, #1411). */}
      <Checkbox
        checked={flow.issuePassport}
        onChange={(event) => flow.setIssuePassport(event.target.checked)}
        className="py-1 text-xs text-[var(--v2-ink-2)]"
        label="Issue an Agent Passport — a signed, revocable record that Haven issued this agent."
        helperText="Optional. Haven covers the small on-chain fee."
        disabled={flow.creating}
      />

      {/* #3688: the confirmation the deleted ReviewStep carried, as one
          always-mounted summary line — #1381 forbids anything mounting below
          the inputs mid-typing, so the box reserves its height even when
          empty and the TEXT swaps in place instead. Built from
          `flow.allowances` — the exact entries the create request sends —
          not the in-progress amount string. Plain text, not an
          AgentRulesSummary. */}
      <div className="min-h-10 text-xs leading-relaxed text-[var(--v2-ink-3)]">
        {flow.allowances.length === 0 ? (
          <p>Set a budget to see what you are approving.</p>
        ) : (
          flow.allowances.map((allowance) => (
            <p key={allowance.tokenSymbol}>
              {allowance.amount} {allowance.tokenSymbol} {budgetPeriodLabel(allowance.resetTimeMin)} from{' '}
              {flow.walletName} on {flow.walletNetworkName}. Nothing can spend until you approve this budget, and
              payments above it are declined on-chain.
            </p>
          ))
        )}
      </div>

      {flow.createError && <InlineErrorNote>{flow.createError}</InlineErrorNote>}

      {flow.walletUnavailable && !flow.createError && (
        <WarningCallout
          title="Haven wallet unavailable"
          body="Create or select a Haven wallet before creating the setup prompt."
        />
      )}

      <div className="flex gap-3">
        <Button variant="ghost" onClick={() => flow.setStep('details')} className="flex-1" disabled={flow.creating}>
          Back
        </Button>
        <Button
          onClick={flow.handleCreateSetup}
          disabled={
            flow.creating ||
            flow.walletUnavailable ||
            flow.allowances.length === 0 ||
            (flow.hasMultipleAccounts && !flow.selectedAccountId)
          }
          className="flex-1"
        >
          {flow.creating ? 'Creating setup...' : 'Create setup prompt'}
        </Button>
      </div>
    </>
  )
}
