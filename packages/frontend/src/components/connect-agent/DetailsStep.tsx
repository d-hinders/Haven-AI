'use client'

import { RUNTIME_OPTIONS, type AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { Textarea } from '../ui/Textarea'

/** Step 1: agent name, description, and runtime. */
export function DetailsStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  return (
    <div className="v2-animate-step-rise space-y-5">
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
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          Haven tailors the setup prompt and restart steps to this environment. "Other" always works.
        </p>
        {flow.localMcpSupported && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)]">
              Advanced
            </summary>
            <Checkbox
              checked={flow.localMcp}
              onChange={(event) => flow.setLocalMcp(event.target.checked)}
              className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-2)]"
              label="Run a fully-local Haven MCP (no hosted dependency). Construct and relay happen on this machine; you update it yourself and Haven keeps no central payment log. Recommended only for offline or self-host setups."
            />
          </details>
        )}
      </div>
      <Button
        onClick={() => flow.setStep('policy')}
        disabled={!flow.name.trim()}
        className="w-full"
      >
        Set agent budget
      </Button>
    </div>
  )
}
