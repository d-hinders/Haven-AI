/**
 * One sentence for one fact — what a Haven-side pause does, and what it leaves
 * standing — shared by every surface that announces it (#2230).
 *
 * `/agents` (`AgentCard`) and `/agents/[agentId]` (`AgentDetailClient`) render
 * the same `ApprovalRequiredBanner` for the same agent state, one click apart:
 * the card's own link IS the navigation between them. #2216 made them agree on
 * `tone`, on the reasoning that leaving one fact rendered two ways across that
 * link is the #2195 defect. They still disagreed on the WORDS:
 *
 *   AgentCard         "… Existing NETWORK PERMISSIONS stay in place."
 *   AgentDetailClient "… Existing WALLET RULES stay in place."
 *
 * Same seven-word opening, then a different noun for the same thing.
 *
 * ── WHICH WORDING WAS TAKEN, AND WHY IT WAS TAKEN RATHER THAN WRITTEN ────────
 *
 * The detail page's — "wallet rules". Taking a settled phrasing rather than
 * inventing a third is #2233's own lesson on this component, where `/custody`'s
 * "Enforced on-chain" was adopted for exactly this reason. Three independent
 * readings agree on which of these two is the settled one:
 *
 * 1. **Usage.** "wallet rules" is what the product already says everywhere
 *    else — `packages/connect/README.md` (twice), `packages/connect/src/
 *    storage.ts`'s credential note, `docs/architecture/07-edge-signer.md` — as
 *    well as on the detail page. "network permissions" appears in exactly one
 *    file in the repository: this card's own, and its pause dialog below.
 *    One of these is a convention; the other is a local coinage.
 * 2. **Register.** `docs/product/copy-guidelines.md` prefers "agent rules" /
 *    "agent budgets" over policy-and-permission language, and lists "Session
 *    key permissions" among the phrasings to avoid; `:417` maps the agent's
 *    delegate address to "Agent wallet address". Both point at rules-and-wallet
 *    rather than permissions-and-network.
 * 3. **Accuracy.** Neither phrase is exact — what survives a Haven-side pause
 *    is the agent's SIGNED BUDGET DELEGATION, enforced on-chain by the caveat
 *    enforcers, which Haven cannot revoke by pausing (`CLAUDE.md` § Agent
 *    Model). Of the two approximations, "rules" is the register the product
 *    uses for that envelope, and "wallet" names where it lives. "Network
 *    permissions" reads as a property of the chain rather than of the user's
 *    own account.
 *
 * A third, more literally accurate phrasing ("the budget you signed stays in
 * place") was considered and rejected: it would be a third sentence for a fact
 * that already has two, which is the shape this module exists to end.
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
 * Was two sentences differing only in the noun ("network permissions" on the
 * card, "wallet rules" on the detail page); this is the detail page's, taken
 * verbatim for the reasons in the module header.
 */
export const AGENT_PAUSED_BODY =
  'New agent payments are blocked until you resume this agent. Existing wallet rules stay in place.'
