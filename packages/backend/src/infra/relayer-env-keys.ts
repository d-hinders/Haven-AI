/**
 * Every relayer key an operator has configured: `RELAYER_PRIVATE_KEY` and every
 * `RELAYER_PRIVATE_KEY_<chainId>`. Enumerated from the environment, NOT from the
 * supported chain list: narrowing the supported list (Gnosis, #3669) must never
 * drop a still-set per-chain key from the receipt-key collision check that
 * `index.ts` runs through `setReceiptSigningKey` at boot.
 *
 * Kept out of `modules/passport/receipt.ts` on purpose: the non-custody
 * invariant pins that the receipt signer never names a relayer key
 * (`__tests__/non-custody.invariants.test.ts`).
 */

/** One configured relayer key, with the variable it came from. */
export interface RelayerKeyEntry {
  /** The env variable name — the only thing a refusal may print (#4655). */
  variable: string
  value: string | undefined
}

/**
 * The same enumeration as `relayerKeysFromEnv`, keeping each key's variable
 * name. #4655's binding-key refusal has to name the colliding variable in its
 * error text and must never print the value, so it cannot work from a bare
 * value list.
 */
export function relayerKeyEntriesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RelayerKeyEntry[] {
  return Object.keys(env)
    .filter((name) => /^RELAYER_PRIVATE_KEY(_\d+)?$/.test(name))
    .map((name) => ({ variable: name, value: env[name] }))
}

export function relayerKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Array<string | undefined> {
  return relayerKeyEntriesFromEnv(env).map((entry) => entry.value)
}
