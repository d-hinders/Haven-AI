'use client'

import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { AgentBudgetCard } from '../haven'

/** Step 2: wallet choice, agent budget drafting, and the passport opt-in. */
export function PolicyStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  return (
    <div className="v2-animate-step-rise space-y-4">
      {flow.hasMultipleSafes && (
        <div>
          <label htmlFor="connect2-safe" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
            Spend from
          </label>
          <Select
            id="connect2-safe"
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
      {flow.allowances.length > 0 && (
        <AgentBudgetCard
          agentName={flow.name || 'New agent'}
          budgets={flow.budgetRows}
          status="Budget draft"
          density="compact"
          onRemoveBudget={flow.handleRemoveBudget}
        />
      )}

      {flow.availableTokens.length > 0 ? (
        <div className="space-y-3 rounded-[10px] border border-dashed border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">Add agent budget</p>
            <p className="text-xs text-[var(--v2-ink-3)]">One per token</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Select value={flow.addToken} onChange={(event) => flow.handleAddTokenChange(event.target.value)}>
              {flow.availableTokens.map((token) => (
                <option key={token.symbol} value={token.symbol}>
                  {token.symbol}
                </option>
              ))}
            </Select>
            <Input
              type="text"
              inputMode="decimal"
              value={flow.addAmount}
              onChange={(event) => flow.handleAddAmountChange(event.target.value)}
              placeholder="Amount"
              invalid={Boolean(flow.addAmountMessage)}
              helperText={flow.addAmountMessage || undefined}
              className="v2-tabular"
            />
            <Select value={flow.addReset} onChange={(event) => flow.setAddReset(Number(event.target.value))}>
              {flow.resetPeriodOptions.map((period) => (
                <option key={period.value} value={period.value}>
                  {period.label}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={flow.handleAddAllowance}
            disabled={!flow.addAmount || !flow.addAmountValidation?.ok || !flow.addTokenOption}
            className="w-full"
          >
            Add budget
          </Button>
        </div>
      ) : flow.budgetSlotsFull ? (
        <p className="rounded-[10px] bg-[var(--v2-surface)] px-3 py-2 text-xs text-[var(--v2-ink-2)]">
          Setup takes one budget, approved with a single signature. You can add more from
          the agent&apos;s page once it is running.
        </p>
      ) : flow.allowances.length > 0 ? (
        <p className="rounded-[10px] bg-[var(--v2-surface)] px-3 py-2 text-xs text-[var(--v2-ink-2)]">
          All supported tokens for {flow.walletNetworkName} already have budgets.
        </p>
      ) : null}

      {flow.allowances.length === 0 && (
        <p className="py-4 text-center text-xs text-[var(--v2-ink-3)]">
          Add at least one agent budget to continue
        </p>
      )}

      <label className="flex items-start gap-2 py-1 text-xs leading-relaxed text-[var(--v2-ink-3)]">
        <input
          type="checkbox"
          checked={flow.issuePassport}
          onChange={(event) => flow.setIssuePassport(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          Optional: issue an Agent Passport — a signed record that this agent was issued
          by Haven, bound to this wallet, and revocable at any time. Haven covers the
          small on-chain fee to issue it.
        </span>
      </label>

      <div className="flex gap-3">
        <Button variant="ghost" onClick={() => flow.setStep('details')} className="flex-1">
          Back
        </Button>
        <Button
          onClick={() => flow.setStep('review')}
          disabled={flow.allowances.length === 0 || (flow.hasMultipleSafes && !flow.selectedSafeId)}
          className="flex-1"
        >
          Review agent rules
        </Button>
      </div>
    </div>
  )
}
