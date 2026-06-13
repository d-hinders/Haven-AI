/**
 * Tier 2 — Fork conformance: certify the reference model against the LIVE
 * deployed AllowanceModule.
 *
 * Tier 1 differential-tests Haven's mirror against `referenceEffectiveAllowance`.
 * That is only as trustworthy as the model. This suite closes the loop by
 * checking the model against on-chain reality, so a Tier-1 failure can be
 * promoted from "candidate" to "confirmed bug".
 *
 * It is SKIPPED unless a Gnosis archive/fork RPC is provided, because it needs
 * outbound RPC (and, for full boundary certification, an anvil/Hardhat fork
 * that can time-travel). To run it:
 *
 *   # 1. Start a fork that allows time manipulation:
 *   anvil --fork-url https://rpc.gnosischain.com --port 8545
 *
 *   # 2. Point the suite at it with a known Safe/delegate/token that already
 *   #    has an allowance configured on-chain:
 *   GNOSIS_FORK_RPC=http://127.0.0.1:8545 \
 *   FORK_SAFE=0x... FORK_DELEGATE=0x... FORK_TOKEN=0x... \
 *   npm --prefix packages/backend test -- src/loop-harness/allowance-fork.conformance.test.ts
 *
 * Full reset-boundary certification (the high-value part) additionally needs
 * the fork to step `block.timestamp` across the reset edge and statically
 * simulate `executeAllowanceTransfer` (eth_call) for `remaining` and
 * `remaining + 1` — see the TODO below. That step is intentionally left as a
 * documented scaffold rather than a half-working stub.
 */

import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { referenceEffectiveAllowance } from './reference-allowance-module.js'
import type { AllowanceInfo } from '../lib/allowance-module.js'

const FORK_RPC = process.env.GNOSIS_FORK_RPC
const SAFE = process.env.FORK_SAFE
const DELEGATE = process.env.FORK_DELEGATE
const TOKEN = process.env.FORK_TOKEN ?? '0x0000000000000000000000000000000000000000'

const ALLOWANCE_MODULE_ABI = [
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
]
// AllowanceModule on Gnosis Chain (same canonical address Safe deploys).
const ALLOWANCE_MODULE_ADDRESS = '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134'

const enabled = Boolean(FORK_RPC && SAFE && DELEGATE)

describe.skipIf(!enabled)('Tier 2 · reference model vs live AllowanceModule', () => {
  it('reference prediction is consistent with on-chain storage + latest block time', async () => {
    const provider = new ethers.JsonRpcProvider(FORK_RPC)
    const contract = new ethers.Contract(
      ALLOWANCE_MODULE_ADDRESS,
      ALLOWANCE_MODULE_ABI,
      provider,
    )

    const [raw, block] = await Promise.all([
      contract.getTokenAllowance(SAFE, DELEGATE, TOKEN) as Promise<bigint[]>,
      provider.getBlock('latest'),
    ])

    const info: AllowanceInfo = {
      amount: raw[0],
      spent: raw[1],
      resetTimeMin: Number(raw[2]),
      lastResetMin: Number(raw[3]),
      nonce: Number(raw[4]),
    }
    const blockTimeSec = Number(block!.timestamp)

    const predicted = referenceEffectiveAllowance(info, blockTimeSec)

    // Sanity invariants the model must satisfy against real storage:
    // remaining never exceeds the configured cap, and a reset can only be
    // pending when a reset window is configured.
    expect(predicted.remaining).toBeLessThanOrEqual(info.amount)
    if (predicted.isResetPending) {
      expect(info.resetTimeMin).toBeGreaterThan(0)
    }

    // TODO (full boundary certification — requires an anvil fork):
    //   for each candidate block time T around referenceResetBoundarySec(info):
    //     await provider.send('evm_setNextBlockTimestamp', [T])
    //     await provider.send('evm_mine', [])
    //     const allowed = predicted.remaining  // model says this much fits
    //     // static-call executeAllowanceTransfer(amount = allowed)   → expect success
    //     // static-call executeAllowanceTransfer(amount = allowed+1) → expect revert
    //   Any mismatch means the MODEL is wrong (fix the model); a mismatch the
    //   model and Haven share but the chain rejects means HAVEN is wrong.
  })
})
