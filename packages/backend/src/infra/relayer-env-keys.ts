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
export function relayerKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Array<string | undefined> {
  return Object.keys(env)
    .filter((name) => /^RELAYER_PRIVATE_KEY(_\d+)?$/.test(name))
    .map((name) => env[name])
}
