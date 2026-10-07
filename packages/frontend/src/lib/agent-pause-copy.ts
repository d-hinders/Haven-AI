/**
 * One sentence for one fact — what a Haven-side pause does, and what it leaves
 * standing — shared by every surface that announces it.
 *
 * `/agents` (`AgentCard`) and `/agents/[agentId]` (`AgentDetailClient`) render
 * the same `ApprovalRequiredBanner` for the same agent state, one click apart:
 * the card's own link IS the navigation between them. #2216 made them agree on
 * `tone`, and #2230 put the WORDS in this shared module so the next
 * divergence is a test failure rather than a reviewer finding.
 *
 * ── THE 2026-10-07 OWNER DECISION ───────────────────────────────────────────
 *
 * The #2230 sentence ("New agent payments are blocked until you resume this
 * agent. Existing wallet rules stay in place.") was honest but incomplete: a
 * pause blocks only HAVEN-initiated payments. The budget delegation stays
 * live on-chain and the agent holds its delegate key, so a holder of the raw
 * key can still redeem within the budget OUTSIDE Haven, paying its own gas
 * (`docs/architecture/07-edge-signer.md`;
 * `delegation-rail-security-model.md`; `packages/signer/src/consent.ts`).
 * #3271's binding makes the shipped signer refuse unbound redemptions, so
 * that is a capability, not default behaviour — but the old sentence said
 * nothing about what is still standing.
 *
 * Owner feedback from prod (2026-10-07) asked the pause controls to say what
 * they do, and the owner approved this sentence verbatim for the banner:
 *
 *   Payments paused. Haven won't send payments for this agent until you
 *   resume. Its budget is still live on-chain. To end it, stop the budget or
 *   remove the agent.
 *
 * It states the narrow truth (only Haven's sending is paused), that the
 * budget survives, and names the two actions that actually end it. The same
 * decision renamed the pause controls "Pause payments" and made them one
 * click on both surfaces (the `/agents` card's pause confirm was removed) —
 * the banner is the honest account of what that one click did.
 *
 * ── WHY A MODULE AND NOT TWO STRINGS THAT AGREE ─────────────────────────────
 *
 * #2195's resolution is the precedent: a shared clause in `src/lib/`, so the
 * next divergence is a test failure rather than a reviewer finding. Unlike
 * `stranded-funds-copy.ts`, the two surfaces here are EQUALLY informed — both
 * know only `status === 'paused'` — so there is no parameter and no
 * per-surface variant. Any future surface that knows more should add a clause
 * AROUND this one rather than reword it.
 */

/** The title both surfaces give this state. Unchanged by #2230 — it already agreed. */
export const AGENT_PAUSED_TITLE = 'Paused in Haven'

/**
 * The body both surfaces give this state.
 *
 * The owner-approved sentence from 2026-10-07 (see the module header), taken
 * verbatim. It replaced #2230's "New agent payments are blocked until you
 * resume this agent. Existing wallet rules stay in place." — same first
 * claim, plus what survives the pause and how to end it.
 */
export const AGENT_PAUSED_BODY =
  "Payments paused. Haven won't send payments for this agent until you resume. Its budget is still live on-chain. To end it, stop the budget or remove the agent."
