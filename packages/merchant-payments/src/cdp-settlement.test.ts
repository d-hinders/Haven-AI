/**
 * #4890 review B1: what the recovery of an already-used authorization answers
 * when the search for its transaction cannot finish. The search's outcomes
 * themselves are characterised in the demo merchant's `cdp-settlement.test.ts`;
 * this pins the timeout answer the 30 s bound added.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, type Hex } from 'viem'
import { CdpTimeoutError, SETTLE_RESOLVE_MS, type CdpChainReader, type CdpSettlementConfig } from './cdp.js'
import { recoverUsedAuthorization } from './cdp-settlement.js'
import { AuthorizationAlreadyUsedError, PaymentError, type Eip3009Authorization } from './payment-checks.js'

const PAYER = getAddress('0x1a642f0e3c3af545e7acbd38b07251b3990914f1')
const MERCHANT = getAddress('0x15179876c595922999c2d5dc7c23cc7711fe799a')
const NONCE = `0x${'ab'.repeat(32)}` as Hex
const TX = `0x${'cd'.repeat(32)}` as Hex

// A long signed window, inside the limit the merchant accepts: the buyer
// chose `validAfter`, so the search has many log windows to walk.
const AUTHORIZATION: Eip3009Authorization = {
  from: PAYER,
  to: MERCHANT,
  value: '10000',
  validAfter: String(1_800_000_000 - 41_000),
  validBefore: '1800000000',
  nonce: NONCE,
}

function config(findAuthorizationOutcome: CdpChainReader['findAuthorizationOutcome']): CdpSettlementConfig {
  return {
    facilitator: {
      verify: async () => {
        throw new Error('not called')
      },
      settle: async () => {
        throw new Error('not called')
      },
    },
    chain: { authorizationUsed: async () => true, findAuthorizationOutcome },
  }
}

describe('recoverUsedAuthorization when the search cannot finish (#4890)', () => {
  it('a search that ran out of time is NOT served: retryable, nothing delivered', async () => {
    // The nonce is used (for example cancelled) and the search times out. Serving
    // here would hand a cancelled authorization the goods.
    const cdp = config(async () => {
      throw new CdpTimeoutError('chain_read', SETTLE_RESOLVE_MS)
    })
    const answer = recoverUsedAuthorization({ cdp, authorization: AUTHORIZATION })
    await expect(answer).rejects.toBeInstanceOf(PaymentError)
    await expect(answer).rejects.not.toBeInstanceOf(AuthorizationAlreadyUsedError)
    await expect(answer).rejects.toMatchObject({ reasonCode: 'facilitator_retryable' })
  })

  it('a search that failed with a read error still serves with no reference, as before', async () => {
    const cdp = config(async () => {
      throw new Error('getLogs: upstream 502')
    })
    const answer = recoverUsedAuthorization({ cdp, authorization: AUTHORIZATION })
    await expect(answer).rejects.toBeInstanceOf(AuthorizationAlreadyUsedError)
    await expect(answer).rejects.toMatchObject({ txHash: undefined })
  })

  it('a completed search still decides: not in the window is refused, settled is served with its hash', async () => {
    await expect(
      recoverUsedAuthorization({ cdp: config(async () => ({ kind: 'not_in_window' })), authorization: AUTHORIZATION }),
    ).rejects.toMatchObject({ reasonCode: 'facilitator_refused' })
    await expect(
      recoverUsedAuthorization({ cdp: config(async () => ({ kind: 'settled', txHash: TX })), authorization: AUTHORIZATION }),
    ).rejects.toMatchObject({ txHash: TX })
  })
})
