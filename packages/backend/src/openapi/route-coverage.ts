/**
 * What the OpenAPI spec is allowed NOT to describe — and the ceiling on it.
 *
 * #1443 (epic #1442). The pre-existing drift test (`spec.test.ts`) checks seven
 * hand-listed route files against the spec. That list is itself the pattern the
 * epic is about: a new route MODULE was invisible to the gate, because nobody
 * remembered to add it. The gate now derives its scope from the app's own
 * registration table (`route-inventory.ts`), which means every registered
 * module is checked — and the 65% of the API that was never documented becomes
 * visible instead of absent.
 *
 * Two kinds of exemption, deliberately different in weight:
 *
 * - `KNOWN_UNDOCUMENTED_ROUTES` — a single route that will never be in the
 *   public agent-payment spec, each with its own `because:`. Precise and cheap
 *   to audit. Moved here verbatim from `spec.test.ts` so both gates read one
 *   list.
 * - `UNDOCUMENTED_MODULES` — a whole module deferred to the #1446 backfill.
 *   Coarse on purpose: writing 80 per-route justifications for work that is
 *   already scheduled would be ceremony, not honesty. Each entry says what the
 *   module is and why it is not documented YET.
 *
 * Both are **shrink-only**, enforced by the ceilings below. An entry may leave;
 * none may be added without lowering something else, which is what makes the
 * backfill converge instead of drifting.
 */

export interface UndocumentedRoute {
  method: string
  path: string
  because: string
}

/**
 * Routes on the agent-payment surface that are intentionally NOT in the
 * published spec. Each entry needs an explicit `because:` — auditors and future
 * contributors must understand why a route exists but is undocumented.
 *
 * When a new route is added it should EITHER be documented in `spec.ts` OR
 * added here with a clear reason. The default must be "document it"; this list
 * exists for genuinely-internal routes.
 */
export const KNOWN_UNDOCUMENTED_ROUTES: UndocumentedRoute[] = [
  // ── agents.ts ──
  {
    method: 'PUT',
    path: '/agents/{id}',
    because:
      'Dashboard-only mutation that uses dashboard JWT auth, not the agent API key. ' +
      'Could be documented when the dashboard surface is folded into a separate dashboard spec.',
  },
  {
    method: 'DELETE',
    path: '/agents/{id}',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'POST',
    path: '/agents/{id}/pause',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'POST',
    path: '/agents/{id}/resume',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'POST',
    path: '/agents/{id}/rotate-key',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'DELETE',
    path: '/agents/{id}/allowances/{tokenAddress}',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'POST',
    path: '/agents/{id}/allowances',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  // ── transactions.ts ──
  {
    method: 'GET',
    path: '/transactions/payment-intents/{paymentId}/evidence',
    because: 'Dashboard-only audit view using dashboard JWT auth.',
  },
  // ── index.ts (declared straight on the app, not via a routes/ module) ──
  {
    method: 'GET',
    path: '/chains',
    because:
      'Public chain/token registry read, declared inline in index.ts next to /health. ' +
      'It SHOULD be in the spec — it was simply invisible until #1443 taught the gate ' +
      'to look at index.ts, and documenting it belongs to the #1446 backfill rather ' +
      'than to the gate that found it.',
  },
  // ── x402.ts ──
  {
    method: 'POST',
    path: '/x402/{id}/settle',
    because:
      'Delegation-rail x402 settlement (#830, epic #821). Behind the /x402 ' +
      'darkened rail; documented in the OpenAPI spec in the epic docs sweep (#834).',
  },
]

export interface UndocumentedModule {
  file: string
  because: string
}

/**
 * Modules whose routes are wholesale undocumented, deferred to #1446.
 *
 * Ordered by what #1446 should take first: the agent-facing and money-path
 * surfaces, then the dashboard-session ones, then the integrations. A module
 * leaves this list in the same pull request that documents it.
 */
export const UNDOCUMENTED_MODULES: UndocumentedModule[] = [
  // ── Agent-facing / money-path — highest priority for #1446 ──
  {
    file: 'x402-resources.ts',
    because: 'The x402 demo-resource + receipts surface; agent-reachable, undocumented since it shipped.',
  },
  {
    file: 'agent-passports.ts',
    because: 'Agent Passport issuance/status (epic #970). Governance metadata, never spend authority.',
  },
  {
    file: 'passport-verify.ts',
    because: 'Public passport verification. A natural candidate for the published spec — nobody has written it up.',
  },
  {
    file: 'hybrid-accounts.ts',
    because: 'Delegation-rail account provisioning (#886). Dashboard-driven today; agent-facing once onboarding opens up.',
  },
  // ── Dashboard-session surfaces (JWT auth, not the agent API key) ──
  {
    file: 'user.ts',
    because: 'Dashboard account/profile surface on JWT auth. Belongs to the "separate dashboard spec" idea the per-route entries above reference.',
  },
  {
    file: 'user-safes.ts',
    because: 'Wallet linking/renaming plus the Safe approvers subsection. See the Safe-retirement decision in #1440 before documenting the approver half.',
  },
  {
    file: 'auth.ts',
    because: 'Login/session for the dashboard. Deliberately outside the agent-facing spec.',
  },
  {
    file: 'passkeys.ts',
    because: 'WebAuthn enrolment for dashboard sessions; credential handling, no payment surface.',
  },
  {
    file: 'approvals.ts',
    because: 'The legacy over-budget approval queue — a Safe/AllowanceModule-rail feature slated for retirement (#1440). Documenting a dying rail would be waste; revisit when #1440 lands.',
  },
  {
    file: 'agent-activity.ts',
    because: 'Dashboard activity feed for one agent; read-only projection of data already documented elsewhere.',
  },
  {
    file: 'analytics.ts',
    because: 'Internal product analytics; not part of any external contract.',
  },
  {
    file: 'safe-deploy.ts',
    because: 'Safe deployment — the rail is being retired entirely (#1440). Do not document; expect deletion.',
  },
  {
    file: 'safe-exec.ts',
    because: 'Relayed Safe execution — same retirement as safe-deploy.ts (#1440).',
  },
  // ── Integrations ──
  {
    file: 'fortnox.ts',
    because: 'Fortnox OAuth + connection management for the bookkeeping feed; vendor-specific, dashboard-driven.',
  },
  {
    file: 'accounting.ts',
    because: 'Accounting export surface behind the reporting entitlement.',
  },
  {
    file: 'reporting.ts',
    because: 'Reporting-feed status and backfill controls; dashboard-driven.',
  },
]

/**
 * Shrink-only ceilings. Raising either number is the thing this gate exists to
 * prevent: it would mean a new route shipped undocumented AND unexplained.
 *
 * Recorded 2026-08-14 against dev: **138 registered routes, 90 undocumented**
 * (65%), of which 10 carry their own per-route justification and 80 sit in
 * deferred modules.
 *
 * A note for whoever reads this next to the epic's opening measurement of
 * 136/89: the surface did not get worse between the scan and this PR. The gate
 * simply started seeing two more routes — the ones declared inline in
 * `index.ts` — and one of them (`GET /chains`) turned out to be undocumented.
 * That is the gate earning its keep on its first run, not slack being taken.
 */
export const MAX_UNDOCUMENTED_MODULES = 16
export const MAX_UNDOCUMENTED_ROUTES = 76
