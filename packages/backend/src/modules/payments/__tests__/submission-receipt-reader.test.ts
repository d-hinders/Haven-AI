/**
 * The receipt→outcome MAPPING of `readUserOperationReceipt` (#3564): an
 * included receipt carries its success flag and transaction hash verbatim,
 * and a success:false receipt is still INCLUDED (a revert the bundler saw) —
 * the fact the reverted arm of the reconciler keys on. The not-found mapping
 * (null / RPC error / missing credential → not_found_yet) is pinned against
 * the REAL seam in `submission-reconciler.test.ts`; this file stubs the
 * bundler client so the included shapes are assertable without a bundler.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const getReceipt = vi.hoisted(() => vi.fn())

vi.mock('permissionless/clients/pimlico', () => ({
  createPimlicoClient: () => ({ getUserOperationReceipt: getReceipt }),
}))

import { readUserOperationReceipt } from '../../../rails/delegation-rail.js'

describe('#3564 — the receipt → outcome mapping', () => {
  beforeEach(() => {
    getReceipt.mockReset()
    process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = 'https://bundler.example/v2/84532'
  })

  it('an included, succeeded receipt carries success and the transaction hash', async () => {
    getReceipt.mockResolvedValue({ success: true, receipt: { transactionHash: `0x${'ef'.repeat(32)}` } })
    await expect(readUserOperationReceipt(84532, `0x${'ab'.repeat(32)}`)).resolves.toEqual({
      state: 'included',
      success: true,
      txHash: `0x${'ef'.repeat(32)}`,
    })
  })

  it('an included, REVERTED receipt is still included — with success false', async () => {
    getReceipt.mockResolvedValue({ success: false, receipt: { transactionHash: `0x${'cd'.repeat(32)}` } })
    await expect(readUserOperationReceipt(84532, `0x${'ab'.repeat(32)}`)).resolves.toEqual({
      state: 'included',
      success: false,
      txHash: `0x${'cd'.repeat(32)}`,
    })
  })
})
