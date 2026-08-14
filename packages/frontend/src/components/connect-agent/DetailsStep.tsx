'use client'

import { ChevronRight } from 'lucide-react'
import { RUNTIME_OPTIONS, type AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { Textarea } from '../ui/Textarea'

/**
 * Step 1: agent name, description, and runtime.
 *
 * #1411: no rhythm of its own — the vertical gap between fields comes from
 * the shared `flex flex-col gap-5` wrapper ConnectAgentModal renders around
 * whichever of steps 1-3 is current (the same 20px rhythm step 4's shell
 * body carries), not a local `space-y-*`. This component's root is a
 * Fragment so every field is a direct sibling in that flex column.
 */
export function DetailsStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  return (
    <>
      <div>
        <label htmlFor="connect-agent-name" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
          Agent name
        </label>
        <Input
          id="connect-agent-name"
          value={flow.name}
          onChange={(event) => flow.setName(event.target.value)}
          placeholder="e.g. Research Agent"
        />
      </div>
      <div>
        <label htmlFor="connect-agent-description" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
          Description <span className="normal-case">(optional)</span>
        </label>
        <Textarea
          id="connect-agent-description"
          value={flow.description}
          onChange={(event) => flow.setDescription(event.target.value)}
          placeholder="What does this agent do?"
          rows={2}
        />
      </div>
      <div>
        <label htmlFor="connect-agent-runtime" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
          Where will this agent run?
        </label>
        <Select
          id="connect-agent-runtime"
          value={flow.runtime}
          onChange={(event) => flow.setRuntime(event.target.value)}
        >
          {RUNTIME_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
        <p className="mt-1.5 text-xs text-[var(--v2-ink-3)]">
          Haven tailors the setup prompt and restart steps to this environment. "Other" always works.
        </p>
        {flow.localMcpSupported && (
          /* #1411: footnote weight, not a technical essay. A power-user
             opt-in on the first screen gets one outcome-language sentence
             behind a disclosure — was a protocol paragraph ("Construct and
             relay happen on this machine; you update it yourself and Haven
             keeps no central payment log.") that read denser than anything
             else in the flow. Stays on this screen (moving it is a flow
             change, out of scope here) but no longer competes for attention.

             #1393: the design system's chevron Icon, not the native <details>
             triangle — same group/list-none/group-open:rotate-90 idiom the
             step-4 disclosures use (WaitingForConnector,
             ConnectionVerificationFooter). */
          <details className="group mt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)]">
              <Icon
                icon={ChevronRight}
                className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
              />
              Advanced
            </summary>
            <Checkbox
              checked={flow.localMcp}
              onChange={(event) => flow.setLocalMcp(event.target.checked)}
              className="mt-2 text-xs text-[var(--v2-ink-3)]"
              label="Run everything on this machine instead of Haven's hosted tools — for users who manage their own runtime."
            />
          </details>
        )}
      </div>
      <div className="flex gap-3">
        {/* handleClose is safe here without a confirm: its only guard
            (manualCredentialNeedsSave) is a step-4 concern unreachable from
            step 1, so Cancel behaves exactly like backdrop/X/Escape. */}
        <Button variant="ghost" onClick={flow.handleClose} disabled={flow.busy} className="flex-1">
          Cancel
        </Button>
        <Button
          onClick={() => flow.setStep('policy')}
          disabled={!flow.name.trim()}
          className="flex-1"
        >
          Set agent budget
        </Button>
      </div>
    </>
  )
}
