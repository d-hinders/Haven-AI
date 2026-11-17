/**
 * #4853: reconciling settled joke payments against Stripe.
 *
 * A payment can settle on-chain and still have no PaymentIntent: the merchant
 * records at request time, and a purchase served through recovery without a
 * transaction hash (#4851) has nothing to key one on. There is no database to
 * remember a block range, so the operator passes one.
 *
 * The script only records what CDP settled. An EIP-3009 transfer is the
 * on-chain shape CDP's settlement leaves: USDC's `AuthorizationUsed` for the
 * payer in the same transaction as the `Transfer`. Any other transfer to the
 * deposit address — a plain `transfer`, a Permit2 pull, an ERC-7710
 * redemption — is listed as "not recorded" and left alone: recording a
 * transfer CDP did not settle needs Stripe's confirmation first (epic #4849,
 * Out of scope).
 *
 * Idempotent by construction: "already recorded" is a read of Stripe (the
 * PaymentIntent carrying the transaction hash in metadata), so a second run
 * over the same range creates nothing.
 *
 * #4866: the report carries Stripe's verdict, not the create call's. Only a
 * `succeeded` PaymentIntent is `recorded` / `already_recorded`; one Stripe is
 * still verifying is `pending`, and one it declined is `declined` — permanent
 * for that transaction, since Stripe allows one PaymentIntent per
 * transaction. And the chain is read in windows the RPC provider serves
 * (`log-range.ts`): the public Base Sepolia RPC refuses more than 200 blocks.
 */
import { getAddress, parseAbiItem, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem'
import { LogWindows } from './log-range.js'
import { USDC_ADDRESS, type ProductId } from './products.js'
import type { StripeRecording } from './stripe.js'

/** One USDC `Transfer` to the deposit address. */
export interface DepositTransfer {
  txHash: Hex
  from: Address
  value: bigint
}

export interface ReconcileChainReader {
  /** USDC `Transfer` logs to `to` in `[fromBlock, toBlock]`. */
  findTransfersTo(params: { to: Address; fromBlock: bigint; toBlock: bigint }): Promise<DepositTransfer[]>
  /**
   * Did this transaction carry USDC's `AuthorizationUsed` for `from`? That is
   * the on-chain mark of an EIP-3009 `transferWithAuthorization`, which is what
   * CDP's settlement submits.
   */
  isEip3009Transfer(params: { txHash: Hex; from: Address }): Promise<boolean>
}

export type NotRecordedReason = 'not_eip3009' | 'amount_mismatch'

export interface ReconcileReport {
  from_block: string
  to_block: string
  /** Every USDC transfer to the deposit address in the range. */
  transfers: number
  /** Payments this run recorded, and Stripe accepted (`succeeded`). */
  recorded: Array<{ tx_hash: string; payment_intent: string }>
  /** Payments Stripe already had a succeeded PaymentIntent for. */
  already_recorded: Array<{ tx_hash: string; payment_intent: string }>
  /** #4866: PaymentIntents Stripe had not decided yet. Run again later. */
  pending: Array<{ tx_hash: string; payment_intent: string }>
  /**
   * #4866: PaymentIntents Stripe declined. Permanent for that transaction —
   * Stripe will not take a second one. Exit code 2.
   */
  declined: Array<{ tx_hash: string; payment_intent: string; code?: string }>
  /** Transfers left alone, with the reason. */
  not_recorded: Array<{ tx_hash: string; reason: NotRecordedReason }>
  /** Payments that should have been recorded but Stripe refused. */
  failed: Array<{ tx_hash: string; reason: string }>
}

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const AUTHORIZATION_USED_EVENT = parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)')

export function createViemReconcileChainReader(
  client: PublicClient,
  // #4866: the operator's range is read in windows the provider serves,
  // narrowed by `ETH_GETLOGS_MAX_BLOCK_RANGE` and by the provider's refusal.
  logWindows: LogWindows = new LogWindows(),
): ReconcileChainReader {
  return {
    async findTransfersTo({ to, fromBlock, toBlock }) {
      const windows = await logWindows.scan(fromBlock, toBlock, (start, end) =>
        client.getLogs({
          address: USDC_ADDRESS,
          event: TRANSFER_EVENT,
          args: { to: getAddress(to) },
          fromBlock: start,
          toBlock: end,
        }),
      )
      const transfers: DepositTransfer[] = []
      for (const log of windows.flat()) {
        if (!log.transactionHash || !log.args.from || log.args.value === undefined) continue
        transfers.push({
          txHash: log.transactionHash,
          from: getAddress(log.args.from),
          value: log.args.value,
        })
      }
      return transfers
    },

    async isEip3009Transfer({ txHash, from }) {
      const receipt = await client.getTransactionReceipt({ hash: txHash })
      if (receipt.status !== 'success') return false
      const events = parseEventLogs({
        abi: [AUTHORIZATION_USED_EVENT],
        logs: receipt.logs,
        eventName: 'AuthorizationUsed',
      })
      return events.some(
        (event) =>
          getAddress(event.address) === getAddress(USDC_ADDRESS) &&
          getAddress(event.args.authorizer) === getAddress(from),
      )
    },
  }
}

/**
 * List the settled payments to the deposit address that have no PaymentIntent,
 * and record them.
 *
 * Only an EIP-3009 transfer of the product's exact price is recorded. Anything
 * else is reported as "not recorded" and left alone.
 */
export async function reconcileStripe(params: {
  chain: ReconcileChainReader
  recording: StripeRecording
  depositAddress: Address
  /** The recorded product's price, in USDC base units. */
  priceAtomic: bigint
  productId: ProductId
  fromBlock: bigint
  toBlock: bigint
}): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    from_block: params.fromBlock.toString(),
    to_block: params.toBlock.toString(),
    transfers: 0,
    recorded: [],
    already_recorded: [],
    pending: [],
    declined: [],
    not_recorded: [],
    failed: [],
  }

  const transfers = await params.chain.findTransfersTo({
    to: params.depositAddress,
    fromBlock: params.fromBlock,
    toBlock: params.toBlock,
  })
  report.transfers = transfers.length

  for (const transfer of transfers) {
    if (transfer.value !== params.priceAtomic) {
      report.not_recorded.push({ tx_hash: transfer.txHash, reason: 'amount_mismatch' })
      continue
    }
    if (!(await params.chain.isEip3009Transfer({ txHash: transfer.txHash, from: transfer.from }))) {
      report.not_recorded.push({ tx_hash: transfer.txHash, reason: 'not_eip3009' })
      continue
    }
    const result = await params.recording.record({
      txHash: transfer.txHash,
      amountAtomic: transfer.value,
      productId: params.productId,
    })
    if (result.status === 'recorded') {
      report.recorded.push({ tx_hash: transfer.txHash, payment_intent: result.paymentIntentId })
    } else if (result.status === 'already_recorded') {
      report.already_recorded.push({ tx_hash: transfer.txHash, payment_intent: result.paymentIntentId })
    } else if (result.status === 'pending') {
      report.pending.push({ tx_hash: transfer.txHash, payment_intent: result.paymentIntentId })
    } else if (result.status === 'declined') {
      report.declined.push({
        tx_hash: transfer.txHash,
        payment_intent: result.paymentIntentId,
        ...(result.declineCode ? { code: result.declineCode } : {}),
      })
    } else {
      report.failed.push({ tx_hash: transfer.txHash, reason: result.reason })
    }
  }

  return report
}
