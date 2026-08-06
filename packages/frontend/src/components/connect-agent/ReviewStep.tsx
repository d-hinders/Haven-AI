'use client'

import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { Button } from '../ui/Button'
import { AgentRulesSummary } from '../haven'
import { InlineErrorNote, WarningCallout } from './SetupNotices'

/** Step 3: confirm the agent rules before creating the setup prompt. */
export function ReviewStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  return (
    <div className="v2-animate-step-rise space-y-5">
      <AgentRulesSummary
        title="Confirm agent rules"
        description={`Haven creates a pending setup; the agent creates its key locally and Haven receives only the public signing address. Nothing can spend until you approve the budget${flow.isDelegationAccount ? '' : ' with your wallet'} — the signature is the authority.`}
        density="compact"
        items={[
          { label: 'Who can spend', value: flow.name, helper: flow.description.trim() || undefined },
          { label: 'From wallet', value: `${flow.walletName} on ${flow.walletNetworkName}` },
          {
            label: 'Agent budget',
            value: (
              <div className="space-y-1">
                {flow.allowances.map((allowance) => (
                  <div key={allowance.tokenSymbol}>
                    {allowance.amount} {allowance.tokenSymbol} {budgetPeriodLabel(allowance.resetTimeMin)}
                  </div>
                ))}
              </div>
            ),
          },
          {
            label: 'Approve actions',
            value: 'Payments above budget',
            helper: 'Haven will ask you before requests above the remaining budget move money.',
          },
          {
            label: 'Agent Passport',
            value: flow.issuePassport ? 'Issue on approval' : 'Not requested',
            helper: flow.issuePassport
              ? 'A signed, revocable record that this agent was issued by Haven — governance, not spend authority.'
              : 'You can issue one later from the agent page.',
          },
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
    </div>
  )
}
