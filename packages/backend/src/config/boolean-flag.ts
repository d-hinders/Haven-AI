/**
 * `parseBooleanFlag` lives in its own dependency-free module (#3046): it is
 * read at ESM evaluation by `infra/chain/x402-binding-signer.ts`, and that
 * file is imported across the package boundary by the mcp-server's
 * wire-contract suite, which carries no backend runtime env. Importing it
 * from `config.ts` dragged in the module-level `config` object and its
 * `requireEnv('DATABASE_URL')` — the MCP CI job could not load the suite.
 * `config.ts` re-exports this function, so its six call sites are unchanged.
 */
/**
 * A boolean feature flag read from the environment: `true` or `false`, and
 * **nothing else silently**.
 *
 * Every flag here used to compare the raw environment string to `'true'` with
 * a bare `===`, which reads `TRUE`, `1`, `yes` and `true ` as OFF. That is the
 * worst shape a flag can have,
 * because a silently-off flag is indistinguishable from a deliberately-off
 * one: nothing logs, nothing warns, and the observable behaviour is exactly
 * what an operator who meant to disable the feature would see.
 *
 * It reached production. `HAVEN_HOSTED` was set to `TRUE` on the prod backend,
 * so `config.hosted` was false and `/accounting` told users of the HOSTED
 * service that the feed "is not available on a self-hosted deployment"
 * (#3015, found 2026-09-15 while closing out epic #2858). The variable was
 * present in the dashboard, looked set, and did nothing.
 *
 * So an unrecognised value refuses the boot instead — the shape
 * `parseConnectorChannel` and `parseAccountingEntitlementMode` (both in `config.ts`)
 * already use. Normalising case was the alternative and was rejected by the
 * owner on 2026-09-15 ("flags should fail loudly"): lower-casing fixes `TRUE`
 * and still reads `1`, `yes` and `on` as off, which is the same defect with a
 * smaller blast radius.
 *
 * Unset, `null` and empty-after-trim are all `false` — "the operator cleared
 * it" lands on the same signal as "never configured" rather than a third
 * state, matching `parseConnectorChannel`. Whitespace AROUND a real value is
 * accepted and trimmed, because a padded value is a dashboard paste artefact
 * and the operator's intent is not in doubt; `warnPublicRpc` trims for the
 * same reason. `null` is accepted alongside `undefined` for the reason given
 * on `parseConnectorChannel`: a reader that hands us one should get the
 * designed refusal, not a `TypeError` from `.trim()`.
 *
 * Trimming is the one place this is NOT a pure tightening, so say it plainly:
 * `" true "` read as FALSE under `=== 'true'` and reads as TRUE here, which
 * can turn a flag on rather than merely refusing. It was checked against both
 * Railway projects before shipping (#3015); a future flag added to this family
 * deserves the same check rather than the assumption.
 *
 * The refusal quotes the value, so it lands in the boot log. That is the point
 * for a feature flag and wrong for anything credential-adjacent — do not reuse
 * this for a secret.
 */
export function parseBooleanFlag(name: string, raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return false
  const value = raw.trim()
  if (value === '') return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(
    `${name} is set to ${JSON.stringify(raw)}, which is not a boolean. Accepted values are ` +
    '"true" and "false", lower-case; surrounding whitespace is trimmed, case is not ' +
    `normalised. Set ${name}=false to turn the feature off, or unset it. Refusing to start ` +
    'rather than reading an unrecognised value as false, because a flag that is silently off ' +
    'looks identical to one that is deliberately off (#3015).',
  )
}
