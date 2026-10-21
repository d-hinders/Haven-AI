/**
 * Third-party telemetry opt-out (#4216): `@metamask/smart-accounts-kit` 1.6.0
 * posts usage analytics to `https://mm-sdk-analytics.api.cx.metamask.io/` from
 * the first of its tracked functions that runs. Owner decision: the kit's
 * analytics are OFF in the backend (server, tests and scripts) and the
 * frontend. The kit has no programmatic opt-out — it reads
 * `process.env.DO_NOT_TRACK` (among three other inputs) exactly once, when it
 * latches at the first tracked call — so a plain assignment here, imported
 * FIRST by `src/index.ts`, `vitest.setup.ts` and every `scripts/*.ts` that
 * reaches the kit, turns it off everywhere this module is loaded before that
 * latch. The delegations, smart-account calls and signatures the kit produces
 * are unchanged.
 *
 * Plain assignment, NOT `??=`: an inherited `DO_NOT_TRACK=''` or `'0'` is not
 * nullish and would leave analytics on. Overriding an inherited value is the
 * point — this constant means "Haven does not send this telemetry", not a
 * preference an outer environment is allowed to veto. Proof:
 * `src/telemetry/__tests__/kit-analytics-off.test.ts` records 0 connections to
 * the analytics host with this module loaded and ≥1 without it.
 */
process.env.DO_NOT_TRACK = '1'
