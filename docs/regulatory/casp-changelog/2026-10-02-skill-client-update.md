- **haven-pay skill `client_update` line (no issue; follow-up to the Circle
  agent-skills comparison, 2026-10-02)** — guidance text only. The runbook's
  existing `client_update` sentence becomes a shared constant
  (`AGENT_CLIENT_UPDATE_SENTENCE`, `packages/sdk/src/agent-guidance.ts`) and the
  generic haven-pay skill (`skill-content.ts`, plus its pinned frontend copy in
  `agent-skill-bundle.ts`) now carries the same sentence, so an agent past
  onboarding knows to run the backend-supplied `upgrade_command`. No code path,
  key, signer, delegation, enforcer, budget or settlement behaviour changes;
  Haven gains no signing authority and the agent gains no new capability — the
  sentence only tells it to update a client that the backend already flags.
  `/for-agents.md` is byte-unchanged. Pinned by `skill-content.test.ts` (both
  texts contain the shared sentence) and the existing frontend parity test.
  Perimeter unchanged.
