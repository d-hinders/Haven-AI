import { beforeAll, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { buildBudgetDelegation, type HavenBudgetPolicy } from '../../rails/delegation-policy.js'
import { getDelegationContracts } from '../../rails/delegation-contracts.js'
import {
  decideProbeMode,
  type ProbeMode,
  erc20TransferExecution,
  probeEnforcer,
  probeReachable,
  PROBE_CHAIN_ID,
  readProbeModeInputs,
  resolveProbeRpcUrl,
  unreachableMessage,
} from '../../rails/__tests__/helpers/enforcer-probe.js'

/**
 * On-chain caveat-enforcer contract test (guardrail:
 * `docs/regulatory/casp-risk-guardrails.md` Red Line #4, "Off-Chain-Only
 * Spend Control"; design: `docs/research/non-custody-verification.md`).
 *
 * **This is the half of Red Line #4 that `non-custody-onchain-gate.contract.test.ts`
 * could not reach, filed as #2004 while shipping #1986.** That suite proves
 * Haven performs no off-chain spend arithmetic and forwards the chain's
 * verdict verbatim. It cannot prove the verdict is CORRECT, because
 * `prepareDelegationPayment` — the bundler seam where the enforcers actually
 * run — is mocked there by construction.
 *
 * ## What this suite proves, and against what
 *
 * It compiles a delegation with Haven's REAL caveat compiler
 * (`buildBudgetDelegation`, no mocks, no fixtures), takes the `terms` bytes
 * that compiler produced, and hands them to the enforcer contract DEPLOYED AT
 * HAVEN'S PINNED ADDRESS on Base Sepolia — the same bytecode
 * `delegation-contracts.ts` pins for Base mainnet, byte-compared there when
 * it was pinned (#908). Three refusals and three acceptances:
 *
 * | claim | enforcer | out-of-policy | in-policy (positive control) |
 * |---|---|---|---|
 * | period budget is the cap | `ERC20PeriodTransferEnforcer` | over-budget reverts | within-budget allowed |
 * | recipient pin is binding | `AllowedCalldataEnforcer` | wrong `to` reverts | pinned `to` allowed |
 * | expiry is binding | `TimestampEnforcer` | past expiry reverts | live delegation allowed |
 *
 * **The in-policy cases are not decoration.** A suite of three refusals would
 * pass just as happily against an enforcer that refuses everything, or
 * against terms so malformed the enforcer cannot parse them — which is the
 * empty-set-guard defect this file's siblings were rebuilt to remove twice
 * (#1986, #1987). Each refusal is only evidence because the same enforcer,
 * with the same Haven-compiled terms, says YES one line away.
 *
 * ## Why this is testnet-only and needs no key
 *
 * `beforeHook` is the enforcer's whole decision, and it is reachable by an
 * unsigned, unmined `eth_call`. Nothing is broadcast, no account is funded,
 * no key exists in this process, and the probe refuses any chain id but
 * Base Sepolia (`assertTestnetOnly`). See `helpers/enforcer-probe.ts`.
 *
 * ## The residual gap, stated rather than papered over
 *
 * This proves each enforcer's own verdict on Haven's own terms. It does NOT
 * prove the DelegationManager runs the full caveat stack in order during a
 * real `redeemDelegations`, because that needs a deployed and funded
 * delegator account plus a signature — operator-held testnet keys, outside
 * an automated suite. #1450's mainnet canary settled real value through this
 * exact stack, which is evidence but not a per-PR proof. That remainder stays
 * open and is named in the CASP changelog shard for #2004; do not read this
 * file's green as closing it.
 */

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address
const TREASURY = ('0x' + 'aa'.repeat(20)) as Address
const DELEGATE = ('0x' + 'bb'.repeat(20)) as Address
const PINNED_RECIPIENT = ('0x' + 'cc'.repeat(20)) as Address
const OTHER_RECIPIENT = ('0x' + 'dd'.repeat(20)) as Address

const BUDGET_ATOMIC = 5_000_000n // 5 USDC
const WITHIN_BUDGET = 1_000_000n // 1 USDC
const OVER_BUDGET = 10_000_000n // 10 USDC — strictly more than one period

const pins = getDelegationContracts(PROBE_CHAIN_ID)
const rpcUrl = resolveProbeRpcUrl()

/** Anchored in the past: local clocks run ahead of chain time (#820 run 6). */
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function policy(overrides: Partial<HavenBudgetPolicy> = {}): HavenBudgetPolicy {
  const now = nowSec()
  return {
    agentId: '11111111-1111-1111-1111-111111111111',
    chainId: PROBE_CHAIN_ID,
    treasuryAddress: TREASURY,
    delegateAccountAddress: DELEGATE,
    tokenAddress: USDC_BASE_SEPOLIA,
    budgetAtomic: BUDGET_ATOMIC,
    periodSeconds: 86_400,
    startDate: now - 3_600,
    recipient: PINNED_RECIPIENT,
    expiresAt: now + 90 * 86_400,
    version: 1,
    ...overrides,
  }
}

/**
 * The `terms` Haven's compiler emitted for one pinned enforcer. Selected by
 * ENFORCER ADDRESS, never by array position — a caveat-order change in the
 * compiler must not silently repoint a proof at a different enforcer.
 */
function termsFor(p: HavenBudgetPolicy, enforcer: string): Hex {
  const caveat = buildBudgetDelegation(p).caveats.find(
    (c) => c.enforcer.toLowerCase() === enforcer.toLowerCase(),
  )
  if (!caveat) {
    throw new Error(
      `Haven's caveat compiler attached NO caveat for enforcer ${enforcer} — ` +
        'the on-chain gate this red line depends on is not present at all',
    )
  }
  return caveat.terms as Hex
}

let mode: ProbeMode = 'run'

beforeAll(async () => {
  const inputs = readProbeModeInputs()
  mode = decideProbeMode({ reachable: await probeReachable(rpcUrl), ...inputs })
  if (mode === 'fail-ci' || mode === 'fail-unacknowledged') {
    throw new Error(unreachableMessage(rpcUrl, inputs.ci))
  }
}, 30_000)

/**
 * Every case below is COLLECTED unconditionally and skips only from inside,
 * on the mode `decideProbeMode` returned.
 *
 * The obvious shape — `HAVEN_SKIP_ENFORCER_PROBE === '1' ? describe.skip :
 * describe` — was written first and was WRONG, caught by running it with
 * `CI=1` set: a `describe.skip` decided at collection time reads the raw env
 * and never consults the policy, so the acknowledgement silently skipped the
 * proof in CI, which `decideProbeMode` exists to forbid. The unit tests said
 * `fail-ci`; the suite skipped anyway. Deciding inside `beforeAll` is what
 * makes the asserted policy and the actual behaviour the same thing.
 */
function chainIt(name: string, fn: () => Promise<void>) {
  it(
    name,
    async (ctx) => {
      if (mode === 'skip-acknowledged') ctx.skip()
      await fn()
    },
    30_000,
  )
}

describe(
  'non-custody: the deployed caveat enforcers are the final gate (Red Line #4, #2004)',
  () => {
    // ── period budget ───────────────────────────────────────────────────────

    chainIt('POSITIVE CONTROL — the deployed ERC20PeriodTransferEnforcer ALLOWS a within-budget transfer on Haven-compiled terms', async () => {
      const outcome = await probeEnforcer({
        rpcUrl,
        enforcer: pins.enforcers.erc20PeriodTransfer,
        terms: termsFor(policy(), pins.enforcers.erc20PeriodTransfer),
        executionCallData: erc20TransferExecution(
          USDC_BASE_SEPOLIA,
          PINNED_RECIPIENT,
          WITHIN_BUDGET,
        ),
        delegator: TREASURY,
        redeemer: DELEGATE,
      })
      expect(outcome).toEqual({ kind: 'allowed' })
    })

    chainIt('an OVER-BUDGET redemption reverts ON-CHAIN — the period budget is enforced in Solidity, not by Haven', async () => {
      const outcome = await probeEnforcer({
        rpcUrl,
        enforcer: pins.enforcers.erc20PeriodTransfer,
        terms: termsFor(policy(), pins.enforcers.erc20PeriodTransfer),
        executionCallData: erc20TransferExecution(
          USDC_BASE_SEPOLIA,
          PINNED_RECIPIENT,
          OVER_BUDGET,
        ),
        delegator: TREASURY,
        redeemer: DELEGATE,
      })
      expect(outcome.kind).toBe('reverted')
      expect(outcome.kind === 'reverted' && outcome.reason).toBe(
        'ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
      )
    })

    // ── recipient pin ───────────────────────────────────────────────────────

    chainIt('POSITIVE CONTROL — the deployed AllowedCalldataEnforcer ALLOWS the pinned recipient on Haven-compiled terms', async () => {
      const outcome = await probeEnforcer({
        rpcUrl,
        enforcer: pins.enforcers.allowedCalldata,
        terms: termsFor(policy(), pins.enforcers.allowedCalldata),
        executionCallData: erc20TransferExecution(
          USDC_BASE_SEPOLIA,
          PINNED_RECIPIENT,
          WITHIN_BUDGET,
        ),
        delegator: TREASURY,
        redeemer: DELEGATE,
      })
      expect(outcome).toEqual({ kind: 'allowed' })
    })

    chainIt('a WRONG-RECIPIENT redemption reverts ON-CHAIN against a recipient-pinned delegation', async () => {
      const outcome = await probeEnforcer({
        rpcUrl,
        enforcer: pins.enforcers.allowedCalldata,
        terms: termsFor(policy(), pins.enforcers.allowedCalldata),
        executionCallData: erc20TransferExecution(
          USDC_BASE_SEPOLIA,
          OTHER_RECIPIENT,
          WITHIN_BUDGET,
        ),
        delegator: TREASURY,
        redeemer: DELEGATE,
      })
      expect(outcome.kind).toBe('reverted')
      expect(outcome.kind === 'reverted' && outcome.reason).toBe(
        'AllowedCalldataEnforcer:invalid-calldata',
      )
    })

    // ── expiry ──────────────────────────────────────────────────────────────

    chainIt('POSITIVE CONTROL — the deployed TimestampEnforcer ALLOWS a live delegation on Haven-compiled terms', async () => {
      const outcome = await probeEnforcer({
        rpcUrl,
        enforcer: pins.enforcers.timestamp,
        terms: termsFor(policy(), pins.enforcers.timestamp),
        executionCallData: erc20TransferExecution(
          USDC_BASE_SEPOLIA,
          PINNED_RECIPIENT,
          WITHIN_BUDGET,
        ),
        delegator: TREASURY,
        redeemer: DELEGATE,
      })
      expect(outcome).toEqual({ kind: 'allowed' })
    })

    chainIt('an EXPIRED delegation reverts ON-CHAIN — Haven cannot extend a window it did not sign', async () => {
      const now = nowSec()
      const expired = policy({ startDate: now - 200_000, expiresAt: now - 86_400 })
      const outcome = await probeEnforcer({
        rpcUrl,
        enforcer: pins.enforcers.timestamp,
        terms: termsFor(expired, pins.enforcers.timestamp),
        executionCallData: erc20TransferExecution(
          USDC_BASE_SEPOLIA,
          PINNED_RECIPIENT,
          WITHIN_BUDGET,
        ),
        delegator: TREASURY,
        redeemer: DELEGATE,
      })
      expect(outcome.kind).toBe('reverted')
      expect(outcome.kind === 'reverted' && outcome.reason).toBe(
        'TimestampEnforcer:expired-delegation',
      )
    })
  },
)
