/**
 * #4851: how the CDP path tells a SETTLED authorization from a CANCELLED one —
 * `authorizationState` reads "used" for both — from USDC's own events.
 */
import { describe, expect, it, vi } from 'vitest'
import { pad, toHex, type Address, type Hex } from 'viem'
import { USDC_ADDRESS } from './products.js'
import { createCdpChainReader, withCdpTimeout, CdpTimeoutError, type ChainReadClient } from './cdp.js'

const PAYER = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1' as Address
const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const NONCE = `0x${'12'.repeat(32)}` as Hex
const TX = `0x${'ab'.repeat(32)}` as Hex
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex
const NOW = 1_800_000_000n
const LATEST = 30_000_000n

function transferLog(from: Address, to: Address, value: bigint, token: Address = USDC_ADDRESS) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, pad(from, { size: 32 }), pad(to, { size: 32 })] as Hex[],
    data: toHex(value, { size: 32 }),
  }
}

function client(opts: {
  logs?: Array<{ eventName: string; transactionHash: Hex }>
  logsInChunk?: (fromBlock: bigint, toBlock: bigint) => Array<{ eventName: string; transactionHash: Hex }>
  receipt?: Awaited<ReturnType<ChainReadClient['getTransactionReceipt']>>
}): ChainReadClient & { getLogs: ReturnType<typeof vi.fn> } {
  return {
    readContract: vi.fn().mockResolvedValue(true),
    getBlock: vi.fn().mockResolvedValue({ number: LATEST, timestamp: NOW }),
    getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      opts.logsInChunk ? opts.logsInChunk(fromBlock, toBlock) : (opts.logs ?? []),
    ),
    getTransactionReceipt: vi.fn().mockResolvedValue(
      opts.receipt ?? { status: 'success', logs: [transferLog(PAYER, MERCHANT, 10_000n)] },
    ),
  } as unknown as ChainReadClient & { getLogs: ReturnType<typeof vi.fn> }
}

const PARAMS = {
  authorizer: PAYER,
  nonce: NONCE,
  to: MERCHANT,
  value: 10_000n,
  validAfter: NOW - 600n,
  validBefore: NOW - 300n,
}
/** A window wide enough to need two 500-block chunks: 600 blocks back to 150 back, plus margins. */
const WIDE = { ...PARAMS, validAfter: NOW - 1_200n }

describe('findAuthorizationOutcome (#4851)', () => {
  it('AuthorizationUsed whose transaction paid the merchant the price: settled, with that hash', async () => {
    const reader = createCdpChainReader(client({ logs: [{ eventName: 'AuthorizationUsed', transactionHash: TX }] }))
    expect(await reader.findAuthorizationOutcome(PARAMS)).toEqual({ kind: 'settled', txHash: TX })
  })

  it('AuthorizationCanceled: canceled — nothing was paid', async () => {
    const reader = createCdpChainReader(client({ logs: [{ eventName: 'AuthorizationCanceled', transactionHash: TX }] }))
    expect(await reader.findAuthorizationOutcome(PARAMS)).toEqual({ kind: 'canceled' })
  })

  it.each([
    ['paid someone else', { status: 'success' as const, logs: [transferLog(PAYER, OTHER, 10_000n)] }],
    ['paid a different amount', { status: 'success' as const, logs: [transferLog(PAYER, MERCHANT, 9_999n)] }],
    ['moved a different token', { status: 'success' as const, logs: [transferLog(PAYER, MERCHANT, 10_000n, OTHER)] }],
    ['came from someone else', { status: 'success' as const, logs: [transferLog(OTHER, MERCHANT, 10_000n)] }],
    ['reverted', { status: 'reverted' as const, logs: [transferLog(PAYER, MERCHANT, 10_000n)] }],
  ])('AuthorizationUsed whose transaction %s: used_elsewhere', async (_label, receipt) => {
    const reader = createCdpChainReader(
      client({ logs: [{ eventName: 'AuthorizationUsed', transactionHash: TX }], receipt }),
    )
    expect(await reader.findAuthorizationOutcome(PARAMS)).toEqual({ kind: 'used_elsewhere', txHash: TX })
  })

  it('nothing found in range: null', async () => {
    const reader = createCdpChainReader(client({ logs: [] }))
    expect(await reader.findAuthorizationOutcome(PARAMS)).toBeNull()
  })

  it('searches the signed window in chunks of at most 500 blocks, filtered by authorizer and nonce', async () => {
    const stub = client({ logs: [] })
    await createCdpChainReader(stub).findAuthorizationOutcome(WIDE)
    const calls = stub.getLogs.mock.calls.map(([args]) => args as { fromBlock: bigint; toBlock: bigint; args: unknown; address: Address })
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call.toBlock - call.fromBlock).toBeLessThan(500n)
      expect(call.address).toBe(USDC_ADDRESS)
      expect(call.args).toEqual({ authorizer: PAYER, nonce: NONCE })
    }
    // Contiguous and covering the window: validAfter is 600 blocks back, validBefore 150.
    for (let i = 1; i < calls.length; i++) expect(calls[i].fromBlock).toBe(calls[i - 1].toBlock + 1n)
    expect(calls[0].fromBlock).toBeLessThanOrEqual(LATEST - 600n)
    expect(calls.at(-1)!.toBlock).toBeGreaterThanOrEqual(LATEST - 150n)
    expect(calls.at(-1)!.toBlock).toBeLessThanOrEqual(LATEST)
  })

  it('finds an event in a later chunk', async () => {
    const reader = createCdpChainReader(
      client({
        logsInChunk: (fromBlock) =>
          fromBlock > LATEST - 300n ? [{ eventName: 'AuthorizationUsed', transactionHash: TX }] : [],
      }),
    )
    expect(await reader.findAuthorizationOutcome(WIDE)).toEqual({ kind: 'settled', txHash: TX })
  })
})

describe('withCdpTimeout (#4851)', () => {
  it('rejects with a typed CdpTimeoutError when the call does not answer in time', async () => {
    await expect(withCdpTimeout('settle', 10, () => new Promise(() => {}))).rejects.toBeInstanceOf(CdpTimeoutError)
  })

  it('returns the answer when it comes in time', async () => {
    await expect(withCdpTimeout('verify', 1_000, async () => 'ok')).resolves.toBe('ok')
  })
})
