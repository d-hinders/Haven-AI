/**
 * The period pre-check evaluator (#3616, epic #3615 S-A) — today's
 * `POST /payments` semantics, lifted from `routes/payments.ts:757-781`
 * (#3503) into one reusable function.
 *
 * Semantics (characterized against `payments-period-budget.test.ts`, the
 * reference suite):
 *
 * - EVERY link returned by `resolveBudgetScope` is read; on a sub-budget all
 *   three links are read and the SMALLEST remaining decides — B's own slice
 *   is usually the tighter, but A's budget binds every spend B makes too.
 * - FAIL OPEN per link: an unreadable read (a thrown one, or one answering
 *   `fromChain: false`) contributes NOTHING to the decision, exactly like
 *   the x402 legs — the enforcer stays the gate.
 * - Refuse only on `remaining < amount` — `<`, never `<=`: spending the
 *   exact remainder is what the chain allows. When no link produced a usable
 *   measurement, the pre-check does not refuse at all.
 */
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'

/** A raw read result exactly as `readRemainingBudget` answers. */
export interface LinkRead {
  remainingAtomic: string
  fromChain: boolean
}

export interface PeriodPrecheckInput {
  chainId: number
  /** The atomic amount to cover. */
  amountAtomic: bigint
  /** One entry per redemption link, in the scope's own order. */
  delegationJsons: string[]
  /** The read the caller injects — the module never touches the chain itself. */
  read: (chainId: number, delegationJson: string, amountAtomic: string) => Promise<LinkRead>
}

export interface PeriodPrecheckOutcome {
  /** True when `remaining < amount` was measured on at least one readable link. */
  refused: boolean
  /** The smallest readable remaining, when at least one link was readable. */
  remainingAtomic: bigint | null
  /** How many links produced a usable measurement (readable and parseable). */
  readableLinks: number
  /** How many links failed open (thrown, `fromChain: false`, or unparseable). */
  failedOpenLinks: number
}

/**
 * Evaluate the period pre-check across the scope's links. Returns
 * `refused: false` when no readable link measured a remaining below the
 * amount — including the "no usable measurement at all" case (all links
 * failed open), which is the fail-open posture the enforcer relies on.
 */
export async function evaluatePeriodPrecheck(input: PeriodPrecheckInput): Promise<PeriodPrecheckOutcome> {
  let remainingAtomic: bigint | null = null
  let readableLinks = 0
  let failedOpenLinks = 0

  const reads = await Promise.all(
    input.delegationJsons.map(async (json) => {
      try {
        const read = await input.read(input.chainId, json, input.amountAtomic.toString())
        // The parse is inside the guard with the read: `BigInt()` throws on a
        // malformed string, and "no usable number" reads the same as a
        // degraded read everywhere below.
        return read.fromChain ? BigInt(read.remainingAtomic) : null
      } catch {
        return null
      }
    }),
  )

  for (const read of reads) {
    if (read === null) {
      failedOpenLinks++
      continue
    }
    readableLinks++
    // The smallest readable remaining wins — a sub-budget redeems three links
    // and each carries its own period caveat, so all three are read and the
    // tightest decides.
    if (remainingAtomic === null || read < remainingAtomic) remainingAtomic = read
  }

  return {
    // `<`, never `<=`: spending the exact remainder is what the chain allows.
    refused: remainingAtomic !== null && remainingAtomic < input.amountAtomic,
    remainingAtomic,
    readableLinks,
    failedOpenLinks,
  }
}
