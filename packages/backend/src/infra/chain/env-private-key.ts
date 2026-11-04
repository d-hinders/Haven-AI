/**
 * #4654 (epic #4484, Railway incident 2026-10-21): validate an env private key
 * as a STRING before it reaches a signer constructor.
 *
 * ethers v6 echoes the input it could not parse. A value wrapped in quotes, one
 * with a stray character, or a `NAME=` prefix pasted in throws
 * `invalid BytesLike value (argument="value", value="<the input>", …)` and also
 * sets an enumerable `value` field holding that input. Our code logs the error
 * (`infra/relayer-balance-monitor.ts` logs `err.message`;
 * `infra/http-error-handler.ts` logs the whole error, whose pino `err`
 * serializer emits both `message` and `value`), so on 2026-11-04 a malformed
 * production `RELAYER_PRIVATE_KEY` was written to the backend logs and had to
 * be treated as exposed and rotated (#4487).
 *
 * This helper refuses the same inputs ethers refuses, but with an error that
 * names the VARIABLE and carries no part of the value and no `cause`. It is
 * pure — no imports at all — so `infra/chain/x402-binding-signer.ts` stays
 * importable without the backend's runtime env (#3046) and nothing here reaches
 * `config.ts` or viem.
 *
 * The accepted set is deliberately identical to what ethers accepts today, so a
 * deployed key keeps working: 64 hex characters, optionally `0x`-prefixed,
 * after trimming. A key without `0x` is accepted and returned `0x`-prefixed.
 * Quotes are REFUSED, not stripped: a quoted value is a paste accident, and
 * silently repairing it would hide the operator error that produced it.
 *
 * The constructors stay in the files they are in today — this module only
 * validates the string, so the non-custody signer allow-list
 * (`__tests__/non-custody.invariants.test.ts`) is untouched.
 */
const PRIVATE_KEY_SHAPE = /^(0x)?([0-9a-fA-F]{64})$/

/**
 * Normalize `raw` to a `0x`-prefixed 32-byte hex key, or throw an error naming
 * `name` and carrying no part of the value.
 *
 * `name` is the environment variable the caller actually read, so the refusal
 * points an operator at the variable that is wrong — for the relayer that is
 * `RELAYER_PRIVATE_KEY_<chainId>` when it is set, otherwise
 * `RELAYER_PRIVATE_KEY`.
 */
export function parseEnvPrivateKey(name: string, raw: string | undefined | null): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  const match = PRIVATE_KEY_SHAPE.exec(trimmed)
  if (!match) {
    throw new Error(
      `${name} is not a valid private key: expected 64 hexadecimal characters, ` +
        'optionally prefixed with 0x. The value is deliberately not included in this message.',
    )
  }
  return `0x${match[2]}`
}
