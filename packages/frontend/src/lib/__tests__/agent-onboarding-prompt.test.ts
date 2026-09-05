import { describe, it, expect } from 'vitest'
// Canonical string lives in the SDK, beside the sentence constants the backend's
// setup prompt is built from. The frontend keeps zero @haven_ai/* runtime
// dependencies (standalone Vercel deploys), so parity is asserted here against
// the SDK source by relative path — exactly as for-agents-runbook.test.ts and
// agent-skill-bundle.test.ts do.
import {
  AGENT_ONBOARDING_PROMPT as SDK_PROMPT,
  AGENT_APPROVAL_RELAY_JSON_SENTENCE,
  AGENT_SECRET_HYGIENE_SENTENCE,
} from '../../../../sdk/src/agent-guidance'
import {
  AGENT_ONBOARDING_PROMPT,
  HAVEN_ORIGIN_PLACEHOLDER,
  buildAgentOnboardingPrompt,
} from '@/lib/agent-onboarding-prompt'

/**
 * Guard for the onboarding prompt the dashboard offers a signed-in user (#2535).
 *
 * Two different properties are asserted here and they are not the same claim:
 *
 * 1. **Parity** — the frontend copy is the SDK string. Nothing in a build
 *    regenerates it, so this test is the only thing stopping the two drifting.
 * 2. **Shared rules** — the prompt reuses the sentence constants VERBATIM
 *    rather than paraphrasing them. This is the property #2535 actually cares
 *    about ("so the two never drift in tone or rules"): byte parity between two
 *    frontend/SDK copies would still pass if this prompt told an agent
 *    something the setup prompt contradicts. Containment is what rules that out.
 */
describe('the onboarding prompt (#2535)', () => {
  it('is byte-for-byte the canonical SDK string', () => {
    expect(AGENT_ONBOARDING_PROMPT).toBe(SDK_PROMPT)
  })

  it('carries the shared rules verbatim, not paraphrased', () => {
    // Both sentences are also in buildSetupPrompt (routes/agent-connection-setups.ts),
    // so an agent cannot be told two different versions of the same rule.
    expect(AGENT_ONBOARDING_PROMPT).toContain(AGENT_APPROVAL_RELAY_JSON_SENTENCE)
    expect(AGENT_ONBOARDING_PROMPT).toContain(AGENT_SECRET_HYGIENE_SENTENCE)
  })

  it('names only commands that exist, and never asks for a password', () => {
    // #2535 makes this blocking: the prompt may name `haven login` (#2526) and
    // `haven agents connect` (#2527) only because both landed first.
    expect(AGENT_ONBOARDING_PROMPT).toContain('npx @haven_ai/cli login')
    expect(AGENT_ONBOARDING_PROMPT).toContain('haven agents connect --name')
    expect(AGENT_ONBOARDING_PROMPT).toContain('haven_get_agent')
    // The epic invariant no slice may weaken.
    expect(AGENT_ONBOARDING_PROMPT).toMatch(/must never ask for it/)
  })

  it('carries no secret and no setup token — it is shown before any setup exists', () => {
    expect(AGENT_ONBOARDING_PROMPT).not.toMatch(/sk_agent_|sk_live_|--setup /)
  })

  it('substitutes every origin placeholder', () => {
    const rendered = buildAgentOnboardingPrompt('https://app.example.com')
    expect(rendered).not.toContain(HAVEN_ORIGIN_PLACEHOLDER)
    // Not merely "the first one" — the string carries several.
    expect(AGENT_ONBOARDING_PROMPT.split(HAVEN_ORIGIN_PLACEHOLDER).length - 1).toBeGreaterThan(1)
    expect(rendered).toContain('signed in at https://app.example.com.')
    expect(rendered).toContain('https://app.example.com/for-agents.md')
  })
})
