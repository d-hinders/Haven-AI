'use client'

import { useMemo } from 'react'
import { Card } from '../ui/Card'
import { CopyBlock } from './CopyBlock'
import { useCopyTimeout } from '@/hooks/useCopyTimeout'
import { buildAgentOnboardingPrompt } from '@/lib/agent-onboarding-prompt'

/**
 * "Set up with your AI agent" — the whole-onboarding prompt, offered on the two
 * empty states a signed-in user with no agents can reach (#2535, epic #2519).
 *
 * ## Why this exists next to the connect modal rather than inside it
 *
 * The modal's prompt covers ONE step (run the connector) and only exists once a
 * setup does. A user who arrives at Haven first and wants their agent to do the
 * rest has nothing to paste until they get there. This card is what they paste
 * before that point.
 *
 * ## It is the onboarding prompt, not the "setup prompt"
 *
 * `setup prompt` is canonical for the modal's token-carrying text
 * (`docs/product/copy-guidelines.md` § Agent-facing vocabulary). Naming this
 * one the same thing would undo the disambiguation #2533 and #2576 paid for, so
 * every string here says "prompt" or "onboarding prompt" and never that term.
 *
 * ## Safe to render before any setup exists
 *
 * It carries no setup token and no credential — asserted, not assumed, by
 * `src/lib/__tests__/agent-onboarding-prompt.test.ts`. That is what makes it
 * showable on an empty state, where the modal's prompt would have nothing to say.
 */
export function AgentOnboardingPromptCard({ className }: { className?: string }) {
  const { copied, markCopied } = useCopyTimeout()

  // The host the user is actually signed in to, so the links in the prompt
  // resolve on dev, on a preview deploy and in production from one committed
  // string. Read in the browser rather than baked at build time for the same
  // reason the SDK constant carries a placeholder at all.
  const prompt = useMemo(
    () => buildAgentOnboardingPrompt(typeof window === 'undefined' ? '' : window.location.origin),
    [],
  )

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      markCopied()
    } catch {
      /* clipboard unavailable — the prompt is still on screen to select by hand */
    }
  }

  return (
    <Card hover={false} className={className}>
      <Card.Header
        title="Set up with your AI agent"
        description="Paste this to an agent with a terminal and it can do the rest. You still approve the budget and fund the account — nothing spends without your signature."
      />
      <Card.Section>
        <CopyBlock label="Prompt for your agent" value={prompt} copied={copied} onCopy={handleCopy} primary />
        <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
          Want to read what your agent will do first?{' '}
          <a
            href="/for-agents.md"
            className="underline underline-offset-2 hover:text-[var(--v2-ink)]"
            target="_blank"
            rel="noreferrer"
          >
            Read the agent guide
          </a>
          .
        </p>
      </Card.Section>
    </Card>
  )
}
