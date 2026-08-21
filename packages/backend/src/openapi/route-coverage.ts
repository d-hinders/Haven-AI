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
  // ── transactions.ts ──
  // ── index.ts (declared straight on the app, not via a routes/ module) ──
  // ── x402.ts ──
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
  // ── Dashboard-session surfaces (JWT auth, not the agent API key) ──
  {
    file: 'safe-deploy.ts',
    because: 'Safe deployment — the rail is being retired entirely (#1440). Do not document; expect deletion.',
  },
  {
    file: 'safe-exec.ts',
    because: 'Relayed Safe execution — same retirement as safe-deploy.ts (#1440).',
  },
  // ── Integrations ──
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
export const MAX_UNDOCUMENTED_MODULES = 2
export const MAX_UNDOCUMENTED_ROUTES = 2
