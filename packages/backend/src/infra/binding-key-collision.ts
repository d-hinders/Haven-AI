/**
 * #4655 (owner decision 2): refuse to boot when `X402_BINDING_PRIVATE_KEY` is a
 * key that already has another job.
 *
 * The binding signer authenticates x402 expected context and sweep
 * authorizations, and its address is published as `HAVEN_X402_BINDING_SIGNER`
 * for installed signers to pin. Reusing a relayer key (which pays gas for
 * user-authorised transactions) or the passport receipt key (whose address is
 * published for merchants) would put a key that touches value into that role —
 * the same rule `casp-risk-guardrails.md` states for every listed server key.
 *
 * Until #4655 the only protection was the wording of the error inside the
 * signer itself ("do not fall back to the relayer key"), which is advice, not a
 * check. This is the check.
 *
 * Placement follows `relayer-env-keys.ts`, not the signer: the non-custody
 * invariant pins that `infra/chain/x402-binding-signer.ts` never names a relayer
 * key (`__tests__/non-custody.invariants.test.ts`), so the comparison cannot
 * live there.
 *
 * The refusal names the VARIABLES and never the values: an error surface is the
 * last place a private key may appear, and the operator only needs to know which
 * two variables collide.
 */
import { sameKey } from './key-identity.js'

/** A key the binding key must not equal, with the variable it came from. */
export interface ForbiddenKey {
  /** The env variable name — the only thing the refusal may print. */
  variable: string
  value: string | null | undefined
}

/**
 * Throw when a SET `X402_BINDING_PRIVATE_KEY` equals any forbidden key.
 *
 * Unset (or blank) stays allowed: a deployment that does not sign x402 binding
 * context has no binding key to collide, and refusing it would break every
 * environment that never configured one.
 *
 * Comparison is `sameKey` — the key's VALUE, not its text — so a paste that
 * differs only in casing or the `0x` prefix is still caught.
 */
export function assertBindingKeyNotReused(
  bindingKey: string | null | undefined,
  forbiddenKeys: ReadonlyArray<ForbiddenKey>,
): void {
  const key = bindingKey?.trim()
  if (!key) return

  for (const { variable, value } of forbiddenKeys) {
    if (!value || !value.trim()) continue
    if (!sameKey(value, key)) continue
    throw new Error(
      `X402_BINDING_PRIVATE_KEY must not be the same key as ${variable}: the binding signer ` +
        'authenticates x402 expected context and sweep authorizations, and its address is ' +
        'published as HAVEN_X402_BINDING_SIGNER for installed signers to pin. A relayer key ' +
        'pays gas for user-authorised transactions and the receipt key signs published ' +
        'assertions, so neither may be reused here. Set X402_BINDING_PRIVATE_KEY to a ' +
        'dedicated key, or unset it.',
    )
  }
}
