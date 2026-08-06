'use client'

import { RUNTIME_OPTIONS, type AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'

/** Step 1: agent name, description, and runtime. */
export function DetailsStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  return (
    <div className="v2-animate-step-rise space-y-5">
      <div>
        <label htmlFor="connect2-name" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
          Agent name
        </label>
        <Input
          id="connect2-name"
          value={flow.name}
          onChange={(event) => flow.setName(event.target.value)}
          placeholder="e.g. Research Agent"
        />
      </div>
      <div>
        <label htmlFor="connect2-description" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
          Description <span className="normal-case">(optional)</span>
        </label>
        <textarea
          id="connect2-description"
          value={flow.description}
          onChange={(event) => flow.setDescription(event.target.value)}
          placeholder="What does this agent do?"
          rows={2}
          className="w-full resize-none rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] px-3 py-2 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] transition-colors focus:border-[var(--v2-brand)] focus:outline-none focus:ring-2 focus:ring-[var(--v2-brand)]/20"
        />
      </div>
      <div>
        <label htmlFor="connect2-runtime" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
          Where will this agent run?
        </label>
        <Select
          id="connect2-runtime"
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
            <label className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
              <input
                type="checkbox"
                checked={flow.localMcp}
                onChange={(event) => flow.setLocalMcp(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Run a fully-local Haven MCP (no hosted dependency). Construct and relay happen on
                this machine; you update it yourself and Haven keeps no central payment log.
                Recommended only for offline or self-host setups.
              </span>
            </label>
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
