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
 * ## Check 8 — WHICH delegation was redeemed (#2094, conditional)
 *
 * Checks 1–7 establish that a transfer of the right shape happened inside this
 * intent's window. They do NOT establish that it was THIS intent's settlement
 * rather than a sibling's, because before #2094 two authorizations sharing
 * merchant/token/amount/expiry-second produced a byte-identical child. #2094
 * salts the child from the intent id, which puts an intent-unique
 * `delegationHash` on-chain — and check 8 reads it back:
 *
 * 8. **The pinned DelegationManager's `RedeemedDelegation` log names THIS
 *    intent's child.** Each redeemed delegation in the chain is emitted as a
 *    full `Delegation` struct; re-hashing the emitted struct with the kit's own
 *    `hashDelegation` reproduces the `delegation_hash` stored at authorize time
 *    (verified by roundtrip test). If the transaction carries such logs from
 *    the manager, this intent's hash MUST be among them.
 *
 * It is deliberately CONDITIONAL — a strengthening that can never turn a
 * genuine settlement into a refusal:
 *
 * - No `delegationHash` stored (a pre-#2092 row), or no DelegationManager
 *   pinned for the chain → skipped, and the verdict is checks 1–7 exactly as
 *   before.
 * - The transaction carries NO `RedeemedDelegation` log from the pinned
 *   manager → skipped. Redemption is permissionless and facilitator-shaped;
 *   an absent log is "we learned nothing here", not "this is a forgery".
 * - Logs present but this intent's hash absent → `mismatch`. The transaction
 *   demonstrably redeemed some delegation, and not this one.
 *
 * The `verified` outcome reports which of those happened as `delegationBound`,
 * because the caller's ambiguity guard is narrowed only for a settlement that
 * was actually bound this way.
 *
 * ## What is deliberately NOT checked, and why
 *
 * - **The DelegationManager CALLDATA.** Check 8 reads the manager's own EVENT,
 *   not the transaction's input. The distinction is the reason check 8 is
 *   safe where a calldata decode would not be: calldata is built and shaped by
 *   a merchant-side facilitator Haven does not control and varies per
 *   facilitator (and per x402 facilitator version), whereas the event is
 *   emitted by the pinned, audited manager at a fixed ABI. The ERC-20
 *   `Transfer` log remains the settlement's EFFECT and is universal across all
 *   facilitators, which is why checks 3–6 stay the backbone and check 8 is a
 *   discriminator layered on top rather than a replacement. (Contrast
 *   #1847/PR #2070, which decodes calldata because attestation attribution has
 *   no log form.)
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
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { getProvider } from '../../rails/allowance-module.js'
import { getDelegationContracts } from '../../rails/delegation-contracts.js'

const ERC20_TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

/**
 * The ERC-20 `Transfer` event topic (keccak of the canonical signature).
 * Exported for the passive settlement observer, which needs it to filter
 * `eth_getLogs` candidates down to Transfer events of the expected token.
 */
export const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

/**
 * The pinned DelegationManager's redemption event (#2094). The `Delegation`
 * tuple is emitted in full and NOT indexed, so the struct can be decoded and
 * re-hashed rather than merely matched on a topic.
 */
const REDEEMED_DELEGATION_IFACE = new ethers.Interface([
  'event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, ' +
    '(address delegate,address delegator,bytes32 authority,' +
    '(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation)',
])

/**
 * Every delegation hash the pinned DelegationManager reports having redeemed
 * in this transaction, or `null` when the manager emitted nothing decodable
 * (an unpinned chain, or a facilitator route that never reached it).
 *
 * `null` and `[]` are the SAME answer here — "no on-chain statement about
 * which delegation was redeemed" — and both must degrade to checks 1–7 rather
 * than to a refusal. They are collapsed into `null` on purpose so no caller
 * can accidentally read an empty array as "redeemed nothing, therefore fake".
 *
 * `signature` is excluded from the hash by construction (`hashDelegation`
 * hashes the EIP-712 struct, which has no signature member), so the emitted
 * struct re-hashes to exactly what `buildSettlementDelegation` stored.
 */
function redeemedDelegationHashes(
  receipt: ethers.TransactionReceipt,
  chainId: number,
): string[] | null {
  let manager: string
  try {
    manager = getDelegationContracts(chainId).delegationManager.toLowerCase()
  } catch {
    return null // no manager pinned for this chain — nothing to read
  }
  const hashes: string[] = []
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== manager) continue
    let parsed: ethers.LogDescription | null = null
    try {
      parsed = REDEEMED_DELEGATION_IFACE.parseLog({ topics: [...log.topics], data: log.data })
    } catch {
      continue // some other manager event
    }
    if (parsed?.name !== 'RedeemedDelegation') continue
    const d = parsed.args.delegation
    try {
      hashes.push(
        hashDelegation({
          delegate: d.delegate,
          delegator: d.delegator,
          authority: d.authority,
          caveats: d.caveats.map((c: { enforcer: string; terms: string; args: string }) => ({
            enforcer: c.enforcer,
            terms: c.terms,
            args: c.args,
          })),
          salt: d.salt,
          signature: '0x',
        } as never).toLowerCase(),
      )
    } catch {
      // A struct the kit cannot hash tells us nothing; it must not be able to
      // turn into either a match or a refusal.
      continue
    }
  }
  return hashes.length > 0 ? hashes : null
}

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
  /**
   * #2094: this intent's stored settlement-child hash (`delegation_hash`).
   * When present AND the transaction carries `RedeemedDelegation` logs from
   * the pinned manager, check 8 requires it to be among them. Absent (a
   * pre-#2092 row) leaves the verdict at checks 1–7.
   */
  delegationHash?: string | null
}

export type SettlementVerification =
  /**
   * Checks 1–7 passed on one Transfer log. `delegationBound` reports whether
   * check 8 also ran and matched — i.e. whether the pinned DelegationManager
   * itself named THIS intent's child. Only a bound settlement may be treated
   * as attributable to one intent rather than to any look-alike of it.
   */
  | { outcome: 'verified'; delegationBound: boolean }
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

  // ── Check 8 (#2094): WHICH delegation this transaction redeemed ──────────
  // Runs before the transfer scan so a transaction that demonstrably redeemed
  // someone else's child is refused on the strongest available evidence rather
  // than on transfer shape. `delegationBound` is carried into the verdict so
  // the caller knows whether it may narrow its ambiguity guard.
  let delegationBound = false
  if (expected.delegationHash) {
    const redeemed = redeemedDelegationHashes(receipt, expected.chainId)
    if (redeemed) {
      if (!redeemed.includes(expected.delegationHash.toLowerCase())) {
        return {
          outcome: 'mismatch',
          reason:
            `Transaction ${txHash} redeemed ${redeemed.length} delegation(s) through the ` +
            `DelegationManager, none of them this payment's settlement child ` +
            `(${expected.delegationHash}) — it settles a different payment`,
        }
      }
      delegationBound = true
    }
    // `redeemed === null`: the manager made no decodable statement in this
    // transaction. Fall through to checks 3–6 unchanged — an absent log is not
    // evidence of a forgery, and refusing here would break every facilitator
    // route that does not surface one.
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
    return { outcome: 'verified', delegationBound }
  }

  return {
    outcome: 'mismatch',
    reason:
      `Transaction ${txHash} succeeded but carries no ${expected.tokenAddress} Transfer of ` +
      `${expected.amountRaw} from ${expected.fromAddress} to ${expected.toAddress}`,
  }
}
