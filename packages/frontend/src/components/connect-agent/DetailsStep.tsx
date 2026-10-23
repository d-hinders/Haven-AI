'use client'

import type { Ref } from 'react'
import { ChevronRight } from 'lucide-react'
import { type AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { Button } from '../ui/Button'
import { DialogActions } from '../ui/DialogActions'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'

/**
 * Step 1: agent name, description, and the advanced local-MCP opt-in.
 *
 * #1720 removed the runtime picker. Every environment now gets a
 * byte-identical connector command and the connector resolves the runtime
 * itself, so there is nothing left to ask here.
 *
 * #1411: no rhythm of its own — the vertical gap between fields comes from
 * the shared `flex flex-col gap-5` wrapper ConnectAgentFlow renders around
 * whichever of steps 1-2 is current (the same 20px rhythm step 3's shell
 * body carries), not a local `space-y-*`. This component's root is a
 * Fragment so every field is a direct sibling in that flex column.
 *
 * `nameInputRef` is how the caret lands in *Agent name*: on open in the modal
 * (its initial focus) and on Back in either container (ConnectAgentFlow's
 * step-change focus, #3687).
 *
 * `showCancel` (default true) is false in the inline first-agent flow on
 * `/agents` (#4065, owner decision 2026-10-19): there is no dialog to
 * dismiss, and Cancel's only other effect would be resetting an empty form.
 * The step's one action then renders full width, the single-action rule
 * `DialogActions` describes.
 */
export function DetailsStep({
  flow,
  nameInputRef,
  showCancel = true,
}: {
  flow: AgentConnectionSetupFlow
  nameInputRef?: Ref<HTMLInputElement>
  showCancel?: boolean
}) {
  const next = (
    <Button
      onClick={() => flow.setStep('policy')}
      disabled={!flow.name.trim()}
      className={showCancel ? 'flex-1' : 'w-full'}
    >
      Set agent budget
    </Button>
  )

  return (
    <>
      <div>
        <label htmlFor="connect-agent-name" className="mb-1.5 block text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
          Agent name
        </label>
        <Input
          ref={nameInputRef}
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
      {/* #1720: the Advanced opt-in is no longer gated on a picked runtime —
          there is no pick. It is offered to everyone and the CONNECTOR
          decides, which is the only component that knows the runtime.

          That gate did real work, though: it kept the box away from users
          whose runtime cannot take it. The connector's refusal is clear but
          FATAL (`runtime.ts` throws before /resolve), and `--local` is baked
          into a server-generated command the setup prompt forbids editing —
          so an uninformed tick is a trip back here to start over. The
          constraint therefore moves into the label, where it is read BEFORE
          the choice instead of enforced after it.

          No wrapper div: this used to share one with the runtime Select and
          its helper text. Alone it needs none — the modal's shared
          `flex flex-col gap-5` gives a bare sibling the identical rhythm. */}
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
          label="Run everything on this machine instead of Haven's hosted tools. Only Claude Code, Codex, and Cowork support it — elsewhere, setup stops and you restart without it."
        />
      </details>
      {showCancel ? (
        <DialogActions>
          {/* handleClose is safe here without a confirm: its only guard
              (manualCredentialNeedsSave) is a step-4 concern unreachable from
              step 1, so Cancel behaves exactly like backdrop/X/Escape. */}
          <Button variant="ghost" onClick={flow.handleClose} disabled={flow.busy} className="flex-1">
            Cancel
          </Button>
          {next}
        </DialogActions>
      ) : (
        next
      )}
    </>
  )
}
