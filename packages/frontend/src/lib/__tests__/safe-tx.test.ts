import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toHex, type Address } from 'viem'

import { proposeSafeTx, type SafeTxParams } from '@/lib/safe-tx'

describe('proposeSafeTx', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    }))
  })

  it('preserves Safe contract signatures with v=0 for passkey signers', async () => {
    const safeTx: SafeTxParams = {
      to: '0x1111111111111111111111111111111111111111' as Address,
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000' as Address,
      refundReceiver: '0x0000000000000000000000000000000000000000' as Address,
      nonce: 1n,
    }

    const contractSignature = (
      `0x${'0'.repeat(24)}0802e96a6dd7e1dd80620cf5d759d41b714c0ce2` +
      `${'0'.repeat(63)}41` +
      '00' +
      `${toHex(1, { size: 32 }).slice(2)}` +
      'ab'
    ) as `0x${string}`

    await proposeSafeTx(
      '0x07058311f995c89F4DbE17Db61fa1A3CDe638975' as Address,
      safeTx,
      `0x${'cd'.repeat(32)}`,
      contractSignature,
      '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2' as Address,
      100,
    )

    const [, request] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(request.body as string)

    expect(body.signature).toBe(contractSignature)
  })
})
