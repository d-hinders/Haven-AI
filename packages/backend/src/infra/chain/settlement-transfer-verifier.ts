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
 * 4. **…whose `from` is the payer smart account** (`intent.account_address`).
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
 * ## Check 9 — WHICH EIP-3009 authorization was burned (#3925)
 *
 * The eip3009 twin of check 8, and the sweep's own standard (#3888) extended
 * to every merchant-settlement record: an optional
 * `expectedAuthorizationUsed: { authorizer, nonce }` on the expected shape
 * makes the token's own `AuthorizationUsed` log in THIS transaction's receipt
 * part of the verdict. Runs BEFORE the transfer scan, for the same reason
 * check 8 does — the chain's attribution key outranks transfer shape:
 *
 * - `(authorizer, nonce)` present → `nonceBound: true`, and (#4061 review)
 *   checks 3–6 then read ONLY that authorization's own `Transfer` — the log
 *   immediately after its `AuthorizationUsed` (FiatToken v2 emits the pair in
 *   that order). A transaction settling several of the delegate's
 *   authorizations cannot lend one nonce another's transfer.
 * - The token burned other nonce(s) for this authorizer → `mismatch` with
 *   `authorizationUsedNonces`, so the caller can tell a mere wrong-nonce
 *   report from one that settles ANOTHER payment's derived nonce.
 * - No `AuthorizationUsed` from the token for this authorizer at all →
 *   `mismatch`: USDC's `transferWithAuthorization` /
 *   `receiveWithAuthorization` always emit it, so its absence means this is
 *   not an EIP-3009 settlement at all.
 *
 * The authorizer and nonce are the CALLER's to derive: the agent-reported
 * path takes them from the posted X-PAYMENT header's own authorization
 * (signer-checked against the delegate before use), the passive sweep from
 * `deriveX402PaymentNonce(payment_id)`. Both name the same fact: the
 * transaction burned a nonce provably bound to THIS payment.
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
 * The retired AllowanceModule verifier collapsed an RPC exception into
 * `valid: false`, which reads a transport failure as a negative verdict).
 * `rpc_unavailable` in particular must never become either a confirmation or a
 * permanent rejection: an RPC outage is "not known yet", and the caller maps
 * it to a retryable status.
 */
import { ethers } from 'ethers'
import { getProvider } from '../../infra/chain/relayer-reads.js'
import { getDelegationContracts } from '../../rails/delegation-contracts.js'
import { delegationHashFromLog } from './redeemed-delegation-scanner.js'
// #3925: the same event decoder the sweep's forward scan uses, so the two
// attribution directions can never drift apart on what an `AuthorizationUsed`
// log means (mirrors the #2117 sharing of `delegationHashFromLog`).
import { AUTHORIZATION_USED_IFACE } from './authorization-used-scanner.js'

const ERC20_TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
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
    // #2117: the decode + re-hash is shared with the sweeper's forward scan, so
    // the two attribution directions can never drift apart on what a
    // `RedeemedDelegation` log means.
    const hash = delegationHashFromLog(log)
    if (hash) hashes.push(hash)
  }
  return hashes.length > 0 ? hashes : null
}

/**
 * #4061 review: the Transfer an `AuthorizationUsed` at `logs[i]` belongs to —
 * the NEXT log, a `Transfer` from the same token contract (its `from`/`to`/
 * `value` are then held to checks 3–6 like any candidate). FiatToken v2 emits exactly that pair, in that order, for every
 * `transferWithAuthorization` / `receiveWithAuthorization`. When the receipt
 * carries log indices, the two must also be consecutive by index. `null` when
 * the next log is anything else: the authorization's transfer is then not
 * identifiable, and nothing else in the receipt may stand in for it.
 */
function pairedTransferLog(
  logs: readonly ethers.Log[],
  i: number,
  tokenLower: string,
): ethers.Log | null {
  const used = logs[i]
  const next = logs[i + 1]
  if (!used || !next || next.address.toLowerCase() !== tokenLower) return null
  const usedIndex = (used as { index?: unknown }).index
  const nextIndex = (next as { index?: unknown }).index
  if (typeof usedIndex === 'number' && typeof nextIndex === 'number' && nextIndex !== usedIndex + 1) {
    return null
  }
  let parsed: ethers.LogDescription | null = null
  try {
    parsed = ERC20_TRANSFER_IFACE.parseLog({ topics: [...next.topics], data: next.data })
  } catch {
    return null
  }
  if (parsed?.name !== 'Transfer') return null
  return next
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
  /**
   * #3925: the EIP-3009 nonce this payment's settlement is expected to burn,
   * with the delegate that burned it. When present, check 9 requires the
   * receipt to carry the token's own `AuthorizationUsed(authorizer, nonce)`
   * log — the sweep's attribution proof (#3888), now required of every
   * merchant-settlement record. Mirrors `delegationHash` above: conditional,
   * so callers that cannot name a nonce (none today — the agent path derives
   * it from the posted X-PAYMENT header, the sweep from the payment id) leave
   * the verdict at the earlier checks.
   */
  expectedAuthorizationUsed?: { authorizer: string; nonce: string }
}

export type SettlementVerification =
  /**
   * Checks 1–7 passed on one Transfer log. `delegationBound` reports whether
   * check 8 also ran and matched — i.e. whether the pinned DelegationManager
   * itself named THIS intent's child. Only a bound settlement may be treated
   * as attributable to one intent rather than to any look-alike of it.
   * `nonceBound` reports the same for check 9 (#3925): whether the token's own
   * `AuthorizationUsed` log names the expected `(authorizer, nonce)`.
   */
  | { outcome: 'verified'; delegationBound: boolean; nonceBound?: boolean }
  /** Unknown hash, or not mined yet on this chain. Retryable. */
  | { outcome: 'not_found'; reason: string }
  /** Mined and reverted. Permanent — nothing settled. */
  | { outcome: 'reverted'; reason: string }
  /**
   * Mined and successful, but it is not this payment. Permanent. When the
   * refusal is check 9's, `authorizationUsedNonces` carries every nonce the
   * token reports burning for the expected authorizer — the caller needs them
   * to tell "wrong nonce, this payment" from "settles ANOTHER payment"
   * (#3925).
   */
  | { outcome: 'mismatch'; reason: string; authorizationUsedNonces?: string[] }
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

  // ── Check 9 (#3925): WHICH EIP-3009 authorization this settlement burned ─
  // The same principle as check 8, one rail over: runs BEFORE the transfer
  // scan so a transaction that demonstrably burned someone else's nonce is
  // refused on the chain's own attribution key rather than on transfer shape.
  // The token's `AuthorizationUsed(authorizer, nonce)` log is the proof the
  // passive sweep has always been held to (#3888); requiring it of the
  // agent-reported path too is what closes the same-shaped-sibling residual.
  //
  // Three outcomes, mirroring the issue's three receipt cases:
  // (a) the expected `(authorizer, nonce)` is present → `nonceBound: true`;
  // (b) the token burned OTHER nonce(s) for this authorizer → mismatch with
  //     `authorizationUsedNonces` so the caller can name a stolen sibling;
  // (c) no `AuthorizationUsed` from the token for this authorizer at all →
  //     not an EIP-3009 settlement (USDC's transferWithAuthorization /
  //     receiveWithAuthorization always emit it).
  //
  // #4061 review: the burned nonce is PAIRED with its own transfer. FiatToken
  // v2's `_transferWithAuthorization` / `_receiveWithAuthorization` call
  // `_markAuthorizationAsUsed` (emits `AuthorizationUsed`) and then
  // `_transfer` (emits `Transfer`), so an authorization's Transfer is the log
  // IMMEDIATELY AFTER its AuthorizationUsed, from the same token contract
  // (pinned against a live Base Sepolia settlement receipt in
  // `settlement-transfer-verifier.test.ts`). Checking the two independently
  // let a transaction that settled TWO of the delegate's authorizations pass
  // a nonce whose own transfer went elsewhere, by matching the OTHER
  // authorization's transfer. With an expected authorization, only its paired
  // Transfer may satisfy checks 3–6 below.
  let nonceBound = false
  let pairedTransfer: ethers.Log | null = null
  if (expected.expectedAuthorizationUsed) {
    const tokenLower = expected.tokenAddress.toLowerCase()
    const authorizerLower = expected.expectedAuthorizationUsed.authorizer.toLowerCase()
    const nonceLower = expected.expectedAuthorizationUsed.nonce.toLowerCase()
    const burned: string[] = []
    const logs = receipt.logs
    for (let i = 0; i < logs.length; i += 1) {
      const log = logs[i]!
      if (log.address.toLowerCase() !== tokenLower) continue
      let parsed: ethers.LogDescription | null = null
      try {
        parsed = AUTHORIZATION_USED_IFACE.parseLog({ topics: [...log.topics], data: log.data })
      } catch {
        continue // not an AuthorizationUsed event on this contract
      }
      if (parsed?.name !== 'AuthorizationUsed') continue
      if ((parsed.args.authorizer as string).toLowerCase() !== authorizerLower) continue
      const burnedNonce = (parsed.args.nonce as string).toLowerCase()
      if (burnedNonce === nonceLower) {
        nonceBound = true
        pairedTransfer = pairedTransferLog(logs, i, tokenLower)
        break
      }
      burned.push(burnedNonce)
    }
    if (nonceBound && !pairedTransfer) {
      return {
        outcome: 'mismatch',
        reason:
          `Transaction ${txHash} burned the reported authorization's nonce, but the log after it is ` +
          `not a ${expected.tokenAddress} Transfer — that authorization's transfer cannot be identified`,
      }
    }
    if (!nonceBound) {
      return burned.length > 0
        ? {
            outcome: 'mismatch',
            authorizationUsedNonces: burned,
            reason:
              `Transaction ${txHash} burned AuthorizationUsed nonce(s) ${burned.join(', ')} for this ` +
              `delegate, not the reported authorization's ${expected.expectedAuthorizationUsed.nonce} — ` +
              `the nonce does not match the reported authorization`,
          }
        : {
            outcome: 'mismatch',
            reason:
              `Transaction ${txHash} carries no ${expected.tokenAddress} AuthorizationUsed for ` +
              `${expected.expectedAuthorizationUsed.authorizer} — not an EIP-3009 settlement of this ` +
              `delegate's authorization`,
          }
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

  // #4061 review: with check 9 in force, only the burned authorization's OWN
  // Transfer is a candidate — never another log that happens to match shape.
  const candidates = pairedTransfer ? [pairedTransfer] : receipt.logs
  for (const log of candidates) {
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
    return { outcome: 'verified', delegationBound, nonceBound }
  }

  if (pairedTransfer) {
    return {
      outcome: 'mismatch',
      reason:
        `Transaction ${txHash} burned the reported authorization, but that authorization's own ` +
        `Transfer is not ${expected.amountRaw} from ${expected.fromAddress} to ${expected.toAddress}`,
    }
  }

  return {
    outcome: 'mismatch',
    reason:
      `Transaction ${txHash} succeeded but carries no ${expected.tokenAddress} Transfer of ` +
      `${expected.amountRaw} from ${expected.fromAddress} to ${expected.toAddress}`,
  }
}
