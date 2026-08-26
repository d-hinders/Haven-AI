/**
 * The passkey SIGNER factory deploy, kept for `routes/safe-exec.ts` (#994
 * extraction; trimmed by #1988).
 *
 * This file used to own Safe proxy deployment too — `encodeSafeSetupCalldata`,
 * `predictSafeProxyAddress`, `extractSafeAddressFromReceipt` and
 * `getProxyFactoryContract`. `routes/safe-deploy.ts` was their only caller and
 * it is a 410 tombstone as of epic #1440 slice 5, so they are deleted with it.
 *
 * What remains is reached from `POST /safe/exec`, which deliberately stays
 * OPEN: it is owner-signed Safe execution relayed for gas only, and it is how
 * an owner still moves funds out of an account they hold. A passkey-owned
 * Safe whose signer contract was never deployed cannot verify a signature at
 * all, so `ensurePasskeySignerDeployed` is part of that path, not part of the
 * retired inflow.
 *
 * The bare `tx.wait()` this file used to await is fixed as of #1755 (shipped
 * with #1754): the wait is bounded and an unconfirmed deploy is now a typed
 * {@link PasskeySignerDeployUnconfirmedError} rather than an untyped rejection
 * that `POST /safe/exec` reported as a revert. It still has NO durable
 * outbound record — see the note on {@link ensurePasskeySignerDeployed}.
 *
 * Does NOT belong on the `ChainClient` port: the passkey signer factory is
 * specific to the legacy rail's own contracts — there is no delegation-rail
 * equivalent to substitute against, so a generic interface would be
 * speculative. It lives here purely to keep `ethers` out of `routes/**`.
 */
import { Contract, type Wallet } from 'ethers'
import { withRelayerSendLock } from '../relayer.js'

const PASSKEY_SIGNER_FACTORY_ABI = [
  'function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address signer)',
] as const

interface PasskeySignerFactoryContract {
  createSigner(x: bigint, y: bigint, verifiers: bigint): Promise<{
    hash: string
    wait(confirms?: number, timeout?: number): Promise<unknown>
  }>
}

/**
 * How long to wait for the passkey signer deploy to confirm before giving up
 * on the wait (#1755, shipped with #1754).
 *
 * Bracketed, not round:
 *
 * - **Floor** — one confirmation of a single `createSigner` factory call on
 *   2 s Base / Gnosis blocks is a handful of blocks. 120 s is ~60 blocks of
 *   slack, so a healthy deploy never reaches the deadline and no ordinary
 *   caller sees a behaviour change.
 * - **Ceiling** — `STALE_BROADCAST_SECONDS` (180 s,
 *   `infra/outbound-bump-worker.ts`) is the age at which the bump worker
 *   adopts a `broadcast` row. This submission has no outbound row to adopt
 *   (see below), so today that is a ceiling this constant is kept UNDER for
 *   the future in which it does, not a hand-off that already works. Stated so
 *   the two cannot silently cross; a test asserts the inequality.
 *
 * It is deliberately the same 120 s the caller's own exec wait uses
 * (`SAFE_EXEC_CONFIRM_TIMEOUT_MS`) and the same the frontend's direct-signing
 * path uses (`packages/frontend/src/lib/safe-tx.ts`): the three legs of one
 * user action should not disagree about how long "not yet confirmed" takes.
 */
export const PASSKEY_SIGNER_DEPLOY_CONFIRM_TIMEOUT_MS = 120_000

/**
 * The passkey signer deploy was broadcast but did not confirm within
 * {@link PASSKEY_SIGNER_DEPLOY_CONFIRM_TIMEOUT_MS} (#1755).
 *
 * Deliberately distinct from a revert: nothing failed, the deploy may still
 * mine. What the CALLER must know is the asymmetry — this transaction is a
 * PREREQUISITE, so when it is unconfirmed the caller's own transaction was
 * never broadcast at all. `POST /safe/exec` translates that into an honest
 * "your Safe transaction was not submitted" rather than a revert.
 */
export class PasskeySignerDeployUnconfirmedError extends Error {
  constructor(
    readonly txHash: string,
    readonly timeoutMs: number,
  ) {
    super(
      `passkey signer deploy not confirmed within ${timeoutMs}ms (tx ${txHash}) — ` +
        'the deploy may still mine; the transaction that needed it was NOT broadcast',
    )
    this.name = 'PasskeySignerDeployUnconfirmedError'
  }
}

/** ethers v6 rejects a timed-out `wait()` with `code: 'TIMEOUT'`. */
function isWaitTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'TIMEOUT'
}

/** `provider.getCode` for the relayer's own provider — '0x' when unconfigured, matching the pre-#994 inline check. */
export async function getRelayerProviderCode(relayer: Wallet, address: string): Promise<string> {
  const provider = relayer.provider
  return provider ? await provider.getCode(address) : '0x'
}

function getPasskeySignerFactoryContract(
  factoryAddress: string,
  relayer: Wallet,
): PasskeySignerFactoryContract {
  return new Contract(factoryAddress, PASSKEY_SIGNER_FACTORY_ABI, relayer) as unknown as PasskeySignerFactoryContract
}

/**
 * Deploy the passkey signer contract if it isn't already deployed. Reached
 * only from `POST /safe/exec` now that safe-deploy is a tombstone: an existing
 * Safe whose signer contract somehow was never deployed.
 *
 * Throws {@link PasskeySignerDeployUnconfirmedError} when the deploy is
 * broadcast but unconfirmed, so the caller can say that instead of guessing.
 *
 * KNOWN GAP, deliberately not closed here (#1755): this broadcast still has
 * NO durable outbound record, so a fee-stuck signer deploy is owned by
 * nobody and the #1558 bump worker cannot adopt what was never recorded.
 * Recording it is a design decision about a user-signed, Safe-nonce-bound
 * path — see the follow-up issue linked from #1754.
 */
export async function ensurePasskeySignerDeployed(args: {
  chainId: number
  relayer: Wallet
  factoryAddress: string
  signerAddress: string
  x: `0x${string}`
  y: `0x${string}`
  verifierAddress: string
}): Promise<void> {
  const code = await getRelayerProviderCode(args.relayer, args.signerAddress)
  if (code !== '0x') {
    return
  }

  const signerFactory = getPasskeySignerFactoryContract(args.factoryAddress, args.relayer)

  // Broadcast under the per-chain send lock so the signer deploy can't race
  // another relayer submission for the same EOA nonce (#692/#718).
  const tx = await withRelayerSendLock(args.chainId, () =>
    signerFactory.createSigner(
      BigInt(args.x),
      BigInt(args.y),
      BigInt(args.verifierAddress),
    ),
  )

  // Bounded (#1755). ethers v6 with NO timeout argument sets `timeout = 0`
  // and never creates the rejection timer, so a bare `wait()` cannot produce
  // a TIMEOUT at all — it simply never returns. Passing the deadline is what
  // CREATES the distinction the caller then maps; it is not merely tightening
  // an existing one.
  let receipt: unknown
  let waitError: unknown
  try {
    receipt = await tx.wait(1, PASSKEY_SIGNER_DEPLOY_CONFIRM_TIMEOUT_MS)
  } catch (err) {
    waitError = err
  }

  // NO RECEIPT IS NOT A REVERT. A wait timeout cancels nothing — the deploy
  // stays in the mempool and may still mine — and #690 records that a lagging
  // RPC can hand back a null receipt for a transaction that confirmed. A
  // genuine revert rejects with `CALL_EXCEPTION` and is rethrown untouched
  // below, exactly as before this change.
  //
  // The null-receipt half is belt-and-braces, not a reachable path: in ethers
  // 6.16.0 with `confirms = 1` a null receipt makes the implementation wait
  // rather than return. Kept, and recorded as such, so a later mutation of it
  // passing is not mistaken for dead code.
  if (receipt == null && (waitError == null || isWaitTimeout(waitError))) {
    throw new PasskeySignerDeployUnconfirmedError(tx.hash, PASSKEY_SIGNER_DEPLOY_CONFIRM_TIMEOUT_MS)
  }
  if (waitError != null) {
    throw waitError
  }
}
