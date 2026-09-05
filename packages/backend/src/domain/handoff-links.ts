import { config } from '../config.js'

/**
 * Agent hand-off links (#2522, B2 of the agent-first epic #2519).
 *
 * When an agent drives onboarding, every human-only step should be a link the
 * agent can paste rather than a sentence the human has to decode. This module
 * holds the two pure facts that both the auth route and the connection-setup
 * route need — so neither has to import the other, which is the only reason
 * this is a domain module rather than a helper next to its first caller.
 */

/**
 * The attribution marker's only legal value.
 *
 * An ENUM, unlike the neighbouring free-slug `source` (#2302). `via` answers
 * one closed question — did an agent produce the link the user followed — and
 * D1 (#2529) segments the funnel on it. A free-text field would let whoever
 * writes a link write anything into that metric.
 *
 * Mirrors `parseViaMarker` in the frontend's `lib/discovery.ts`; keep the two
 * rules identical.
 */
export const VIA_AGENT = 'agent'

/** Sanitize, never refuse: attribution must not cost anyone an account or a connect. */
export function normalizeViaMarker(value: unknown): typeof VIA_AGENT | null {
  if (typeof value !== 'string') return null
  return value.trim().toLowerCase() === VIA_AGENT ? VIA_AGENT : null
}

/**
 * The link that lands a human on the budget approval for one setup.
 *
 * ABSOLUTE, deliberately, against the same-origin rule the discovery artifacts
 * follow (#2520): this URL is printed into a terminal by the connector and
 * pasted into a chat by an agent, where a bare path resolves against nothing.
 * The host comes from `config.frontendUrl` rather than a literal, so there is
 * still no hard-coded domain to sweep when it changes.
 *
 * The trailing-slash strip matters: `FRONTEND_URL=https://app.example.com/`
 * is a perfectly ordinary way to set that variable, and without it the link
 * would read `…com//agents`, which is a protocol-relative path to the host
 * `agents` the moment anything resolves it against a base.
 */
export function buildApprovalUrl(setupId: string): string {
  return `${config.frontendUrl.replace(/\/+$/, '')}/agents?setup=${encodeURIComponent(setupId)}`
}
