'use client'

import { RUNTIME_OPTIONS, type AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { Button } from '../ui/Button'
import { AgentRulesSummary } from '../haven'
import { InlineErrorNote, WarningCallout } from './SetupNotices'

/**
 * Step 3: confirm the agent rules before creating the setup prompt.
 *
 * #1411: no rhythm of its own — see DetailsStep's note. Root is a Fragment;
 * the shared `flex flex-col gap-5` wrapper in ConnectAgentModal owns the
 * 20px spacing between the summary card and the notices below it.
 *
 * A confirmation, not a second form: every row restates a CHOICE already
 * made on steps 1-2 (name, runtime, wallet, budget, passport), never
 * explains the protocol. The one policy fact worth restating here — that an
 * over-budget request waits for approval — is a single helper line under the
 * Budget row rather than its own row.
 */
export function ReviewStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  const runtimeLabel = RUNTIME_OPTIONS.find((option) => option.id === flow.runtime)?.label ?? flow.runtime

  return (
    <>
      <AgentRulesSummary
        title="Confirm agent rules"
        description={`Haven creates a pending setup; the agent creates its key locally and Haven receives only the public signing address. Nothing can spend until you approve the budget${flow.isDelegationAccount ? '' : ' with your wallet'} — the signature is the authority.`}
        density="compact"
        items={[
          { label: 'Agent name', value: flow.name, helper: flow.description.trim() || undefined },
          { label: 'Runtime', value: runtimeLabel },
          { label: 'Spend from', value: `${flow.walletName} on ${flow.walletNetworkName}` },
          {
            label: 'Budget',
            value: (
              <div className="space-y-1">
                {flow.allowances.map((allowance) => (
                  <div key={allowance.tokenSymbol}>
                    {allowance.amount} {allowance.tokenSymbol} {budgetPeriodLabel(allowance.resetTimeMin)}
                  </div>
                ))}
              </div>
            ),
            helper: 'Payments above this budget wait for your approval in Haven.',
          },
          { label: 'Agent Passport', value: flow.issuePassport ? 'Yes' : 'No' },
        ]}
      />

      {flow.createError && <InlineErrorNote>{flow.createError}</InlineErrorNote>}

      {flow.walletUnavailable && !flow.createError && (
        <WarningCallout
          title="Haven wallet unavailable"
          body="Create or select a Haven wallet before creating the setup prompt."
        />
      )}

      <div className="flex gap-3">
        <Button variant="ghost" onClick={() => flow.setStep('policy')} className="flex-1">
          Back
        </Button>
        <Button onClick={flow.handleCreateSetup} disabled={flow.creating || flow.walletUnavailable} className="flex-1">
          {flow.creating ? 'Creating setup...' : 'Create setup prompt'}
        </Button>
      </div>
    </>
  )
}
