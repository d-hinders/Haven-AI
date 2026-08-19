'use client'

import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'

/**
 * Step 2: wallet choice, the agent's single USDC budget, and the passport
 * opt-in. #1377 B: one budget by design — USDC is a fixed chip (no token
 * select) and a valid amount alone enables Continue. #1381: the inputs ARE
 * the draft — nothing mounts below them mid-typing (the old live draft card
 * caused a content shift on the first keystroke), and the Review step is
 * where the budget is restated before anything is signed. Additional tokens
 * for legacy multi-token accounts are added later from the agent's page.
 *
 * #1411: no rhythm of its own — see DetailsStep's note. Root is a Fragment;
 * the shared `flex flex-col gap-5` wrapper in ConnectAgentModal owns the
 * 20px field-to-field spacing.
 */
export function PolicyStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  return (
    <>
      {flow.hasMultipleSafes && (
        <div>
          <label htmlFor="connect-agent-safe" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
            Spend from
          </label>
          <Select
            id="connect-agent-safe"
            value={flow.selectedSafeId ?? ''}
            onChange={(event) => flow.setSelectedSafeId(event.target.value)}
          >
            {flow.selectableSafes.map((safe) => (
              <option key={safe.id} value={safe.id}>
                {safe.name}
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
          />
          <Select
            aria-label="Budget reset period"
            value={flow.addReset}
            onChange={(event) => flow.setAddReset(Number(event.target.value))}
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
          explainer. */}
      {/* ink-2, NOT ink-3: the Checkbox primitive renders helperText at ink-3
          by design, so the label must sit one tier darker for the built-in
          label/helper hierarchy to read — an on-chain attestation is a
          decision, not a footnote (design review, #1411). */}
      <Checkbox
        checked={flow.issuePassport}
        onChange={(event) => flow.setIssuePassport(event.target.checked)}
        className="py-1 text-xs text-[var(--v2-ink-2)]"
        label="Issue an Agent Passport — a signed, revocable record that Haven issued this agent."
        helperText="Optional. Haven covers the small on-chain fee."
      />

      <div className="flex gap-3">
        <Button variant="ghost" onClick={() => flow.setStep('details')} className="flex-1">
          Back
        </Button>
        <Button
          onClick={() => flow.setStep('review')}
          disabled={flow.allowances.length === 0 || (flow.hasMultipleSafes && !flow.selectedSafeId)}
          className="flex-1"
        >
          Review agent budget
        </Button>
      </div>
    </>
  )
}
