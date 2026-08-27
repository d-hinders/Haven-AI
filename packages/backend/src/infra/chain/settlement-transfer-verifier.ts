/**
 * On-chain verification of an AGENT-REPORTED erc7710 settlement transaction
 * (#2092).
 *
 * ## Why this file exists
 *
 * On erc7710 direct settlement the MERCHANT redeems the [child, budget]
 * delegation chain; Haven submits nothing and therefore learns the settlement
 * transaction only because the agent relays it (from the merchant's
 * `PAYMENT-RESPONSE` header). That makes the reported hash CLIENT INPUT on a
 * path that ends in a `confirmed` payment intent, a `machine_payment_evidence`
 * row, a fee-ledger row, and a line in the user's Fortnox bookkeeping. An
 * agent must not be able to inject a fabricated row into a user's books, so
 * the hash is verified against the chain before anything is written.
 *
 * ## Verification depth — what IS checked (all of it, or nothing confirms)
 *
 * 1. **The transaction exists and is mined on the intent's own chain.** The
 *    RPC is chosen by `chainId` from the intent, so a real hash from another
 *    chain reads as `not_found` rather than passing.
 * 2. **Its receipt status is success (1).** A reverted transaction settled
 *    nothing.
 * 3. **It contains an ERC-20 `Transfer` log emitted BY the expected token
 *    contract** — `log.address === intent.token_address`. A `Transfer` event
 *    from some other contract with the same signature proves nothing about
 *    USDC.
 * 4. **…whose `from` is the payer smart account** (`intent.safe_address`).
 *    This is the anti-fabrication binding: without it an agent could point at
 *    ANY third party's transfer of the right size to the right merchant.
 * 5. **…whose `to` is the expected merchant `payTo`** (`intent.to_address`).
 * 6. **…whose `value` EXACTLY equals the authorized amount**
 *    (`intent.amount_raw`). Exact, not `>=`: the settlement child is built
 *    with an exact-amount caveat, so anything else is not this payment.
 * 7. **The mined block's timestamp falls inside this intent's own settlement
 *    window.** The settlement child carries a `timestamp` caveat that the
 *    DelegationManager enforces on-chain, so a genuine settlement of THIS
 *    child cannot be mined outside `authorize .. authorize + windowSec`. This
 *    is the one check that is about WHICH intent rather than about the
 *    transfer's shape, and it is why a settlement from an hour ago cannot be
 *    replayed onto a fresh look-alike intent.
 *
 * All of 3–6 must hold on ONE log, and 7 on the block that carries it. A transaction that moves the right amount
 * from the right account to a different recipient, or the right pair for a
 * different amount, is a mismatch — not a partial pass.
 *
 * ## What is deliberately NOT checked, and why
 *
 * - **The DelegationManager calldata / which delegation chain was redeemed.**
 *   The transaction is built and submitted by a merchant-side facilitator
 *   Haven does not control, and its calldata shape varies per facilitator
 *   (and per x402 facilitator version). The ERC-20 `Transfer` log is the
 *   settlement's EFFECT and is universal across all of them. Checking the
 *   effect is both more portable and strictly closer to the property we care
 *   about — and the caveat enforcers (budget, recipient pin, expiry) already
 *   bounded on-chain what could move, so re-deriving the delegation from
 *   calldata would re-prove what the chain enforced. (Contrast #1847/PR #2070,
 *   which decodes calldata because attestation attribution has no log form.)
 * - **Who submitted the transaction (`tx.from`) / the facilitator identity.**
 *   `extra.facilitatorAddresses` is advisory and frequently absent, redemption
 *   is permissionless, and who paid the gas is not an integrity property of
 *   the payment. The token `from` in (4) is what binds the transfer to THIS
 *   user's account.
 * - **Reorg depth / confirmation count.** A mined receipt is accepted at one
 *   confirmation, exactly as the rest of the backend does. A deep reorg could
 *   unwind a confirmed settlement; that residual is accepted and documented
 *   rather than traded for latency on every payment.
 * - **That the merchant actually served the resource.** Not an on-chain fact;
 *   the merchant HTTP status travels with the evidence row instead.
 *
 * ## Failure handling — fail closed, and never on an RPC outage
 *
 * Every outcome other than `verified` leaves the caller unable to confirm. The
 * outcomes are kept DISTINCT rather than collapsed into a boolean (the older
 * `allowance-transfer-verifier.ts` collapses an RPC exception into
 * `valid: false`, which reads a transport failure as a negative verdict).
 * `rpc_unavailable` in particular must never become either a confirmation or a
 * permanent rejection: an RPC outage is "not known yet", and the caller maps
 * it to a retryable status.
 */
import { ethers } from 'ethers'
import { getProvider } from '../../rails/allowance-module.js'

const ERC20_TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

/**
 * The ERC-20 `Transfer` event topic (keccak of the canonical signature).
 * Exported for the passive settlement observer, which needs it to filter
 * `eth_getLogs` candidates down to Transfer events of the expected token.
 */
export const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

export interface ExpectedSettlementTransfer {
  chainId: number
  /**
   * Unix-second bounds the settlement block must fall inside — this intent's
   * own settlement-child validity window, widened by a clock-skew allowance.
   * Derived from an invariant of `buildSettlementDelegation`, so it can never
   * exclude a genuine settlement of this intent.
   */
  notBeforeSec: number
  notAfterSec: number
  /** ERC-20 contract that must have emitted the Transfer log. */
  tokenAddress: string
  /** The payer smart account the funds must leave. */
  fromAddress: string
  /** The merchant payTo the funds must reach. */
  toAddress: string
  /** Atomic amount that must match EXACTLY. */
  amountRaw: string
}

export type SettlementVerification =
  /** All six checks passed on one Transfer log. */
  | { outcome: 'verified' }
  /** Unknown hash, or not mined yet on this chain. Retryable. */
  | { outcome: 'not_found'; reason: string }
  /** Mined and reverted. Permanent — nothing settled. */
  | { outcome: 'reverted'; reason: string }
  /** Mined and successful, but it is not this payment. Permanent. */
  | { outcome: 'mismatch'; reason: string }
  /** The chain could not be reached. NOT a verdict — retryable. */
  | { outcome: 'rpc_unavailable'; reason: string }

/**
 * Verify that `txHash` really is the on-chain settlement of `expected`.
 *
 * Returns a verdict; never throws. `verified` is the ONLY outcome a caller may
 * treat as permission to confirm a payment intent.
 */
export async function verifySettlementTransferTx(
  txHash: string,
  expected: ExpectedSettlementTransfer,
): Promise<SettlementVerification> {
  let receipt: ethers.TransactionReceipt | null
  let blockTimestampSec: number | null
  try {
    const provider = getProvider(expected.chainId)
    receipt = await provider.getTransactionReceipt(txHash)
    // Fetched inside the same try: a provider that can answer for the receipt
    // but not for its block is still an RPC failure, not a verdict.
    blockTimestampSec = receipt ? ((await provider.getBlock(receipt.blockNumber))?.timestamp ?? null) : null
  } catch (err) {
    // Transport/provider failure. Deliberately NOT folded into `not_found`:
    // "we could not ask" and "the chain says no" are different facts, and
    // only one of them is retryable.
    return {
      outcome: 'rpc_unavailable',
      reason: `Could not reach the chain to verify ${txHash}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!receipt) {
    return {
      outcome: 'not_found',
      reason: `Transaction ${txHash} is not mined on chain ${expected.chainId}`,
    }
  }
  if (receipt.status !== 1) {
    return { outcome: 'reverted', reason: `Transaction ${txHash} reverted on chain` }
  }
  if (blockTimestampSec == null) {
    // The receipt exists but its block does not read back — treat it as "could
    // not ask", never as a pass. Without the timestamp check 7 is missing, and
    // check 7 is the only intent-specific one.
    return {
      outcome: 'rpc_unavailable',
      reason: `Could not read the block carrying ${txHash} to check the settlement window`,
    }
  }
  if (blockTimestampSec < expected.notBeforeSec || blockTimestampSec > expected.notAfterSec) {
    return {
      outcome: 'mismatch',
      reason:
        `Transaction ${txHash} was mined at ${blockTimestampSec}, outside this payment's ` +
        `settlement window (${expected.notBeforeSec}..${expected.notAfterSec})`,
    }
  }

  const token = expected.tokenAddress.toLowerCase()
  const from = expected.fromAddress.toLowerCase()
  const to = expected.toAddress.toLowerCase()
  let amount: bigint
  try {
    amount = BigInt(expected.amountRaw)
  } catch {
    return { outcome: 'mismatch', reason: 'The payment intent has no usable atomic amount' }
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token) continue
    let parsed: ethers.LogDescription | null = null
    try {
      parsed = ERC20_TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data })
    } catch {
      continue // not a Transfer event on this contract
    }
    if (parsed?.name !== 'Transfer') continue
    if ((parsed.args.from as string).toLowerCase() !== from) continue
    if ((parsed.args.to as string).toLowerCase() !== to) continue
    if ((parsed.args.value as bigint) !== amount) continue
    return { outcome: 'verified' }
  }

  return {
    outcome: 'mismatch',
    reason:
      `Transaction ${txHash} succeeded but carries no ${expected.tokenAddress} Transfer of ` +
      `${expected.amountRaw} from ${expected.fromAddress} to ${expected.toAddress}`,
  }
}
