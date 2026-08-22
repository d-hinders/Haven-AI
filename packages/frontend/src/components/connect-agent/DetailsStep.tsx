'use client'

import { ChevronRight } from 'lucide-react'
import { type AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'

/**
 * Step 1: agent name, description, and the advanced local-MCP opt-in.
 *
 * #1720 removed the runtime picker. Every environment now gets a
 * byte-identical setup command and the connector resolves the runtime
 * itself, so there is nothing left to ask here.
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
        {/* #1720: the Advanced opt-in is no longer gated on a picked runtime —
            there is no pick. It is offered to everyone and the CONNECTOR
            decides, which is the only component that knows the runtime.

            That gate did real work, though: it kept the box away from users
            whose runtime cannot take it. The connector's refusal is clear but
            FATAL (`runtime.ts` throws before /resolve), and `--local` is baked
            into a server-generated command the setup prompt forbids editing —
            so an uninformed tick is a trip back here to start over. The
            constraint therefore moves into the label, where it is read BEFORE
            the choice instead of enforced after it. */}
        <details className="group">
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
            label="Run everything on this machine instead of Haven's hosted tools — for users who manage their own runtime. Works with Claude Code, Codex, and Cowork only; on anything else the connector stops and asks you to set this up again without it."
          />
        </details>
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
