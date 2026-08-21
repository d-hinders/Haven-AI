import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DelegateSweepApi } from './delegate-sweep.js'
import { createErc20Contract, createJsonRpcProvider, createWallet } from './provider.js'
import type { HavenAgent } from './types.js'

vi.mock('./provider.js', () => ({
  createErc20Contract: vi.fn(),
  createJsonRpcProvider: vi.fn(),
  createWallet: vi.fn(),
}))

const AGENT: HavenAgent = {
  id: 'agent_1',
  name: 'Sweep agent',
  status: 'active',
  safeAddress: '0xsafe',
  delegateAddress: '0xdelegate',
  chainId: 8453,
  executionRail: 'legacy',
}

/**
 * `TransactionResponse.wait(confirms?, timeout?)` as ethers v6 actually
 * behaves, in the ONE respect this issue is about:
 *
 * - the deadline comes from the **second** argument;
 * - with no second argument there is **no deadline at all**, and the promise
 *   never settles while the transaction sits unmined;
 * - when the deadline is reached it REJECTS with `code: 'TIMEOUT'` — it does
 *   not resolve `null`, and it is not a revert.
 *
 * Written this way on purpose: a regression to a bare `wait(1)` makes these
 * tests **hang** rather than quietly pass. A mock that resolved regardless of
 * its arguments would be a test that cannot fail for the very defect it
 * claims to cover — the shape this bug already survived review in once.
 */
function neverMinesWait() {
  return vi.fn((_confirms?: number, timeoutMs?: number) => {
    if (timeoutMs === undefined) return new Promise<never>(() => {})
    return new Promise<never>((_resolve, reject) => {
      reject(Object.assign(new Error(`timeout waiting for transaction (${timeoutMs}ms)`), { code: 'TIMEOUT' }))
    })
  })
}

/** ethers v6 throws CALL_EXCEPTION for a transaction that mined and reverted. */
function revertedWait() {
  return vi.fn(() =>
    Promise.reject(Object.assign(new Error('transaction execution reverted'), { code: 'CALL_EXCEPTION' })),
  )
}

const HUNG = Symbol('did not settle')

/**
 * Observe `sweepDelegate()` for a bounded window. Returns HUNG when it has
 * neither resolved nor rejected — the only way to assert "this hangs the
 * caller's agent" without hanging the suite.
 */
async function settleWithin<T>(promise: Promise<T>, ms = 50): Promise<T | typeof HUNG> {
  promise.catch(() => {}) // an unobserved rejection here is the assertion's subject, not a failure
  return Promise.race([promise, new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), ms))])
}

function service(overrides: Partial<ConstructorParameters<typeof DelegateSweepApi>[0]> = {}) {
  return new DelegateSweepApi({
    transport: { post: vi.fn() } as never,
    delegateKey: '0xcaller_held_delegate_key',
    chainRpcs: { 8453: 'https://base-rpc.test' },
    getAgent: vi.fn().mockResolvedValue(AGENT),
    buildExplorerUrl: (chainId, hash) => `https://explorer.test/${chainId}/${hash}`,
    ...overrides,
  })
}

/** Both legs fundable: 1.5 USDC stranded and 1 ETH stranded. */
function fundedDelegate(usdcTx: unknown, ethTx: unknown) {
  const contract = { balanceOf: vi.fn().mockResolvedValue(1_500_000n), transfer: vi.fn().mockResolvedValue(usdcTx) }
  const provider = {
    getBalance: vi.fn().mockResolvedValue(1_000_000_000_000_000_000n),
    getFeeData: vi.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n, gasPrice: null }),
  }
  const wallet = { sendTransaction: vi.fn().mockResolvedValue(ethTx) }
  vi.mocked(createJsonRpcProvider).mockReturnValue(provider as never)
  vi.mocked(createWallet).mockReturnValue(wallet as never)
  vi.mocked(createErc20Contract).mockReturnValue(contract as never)
  return { contract, provider, wallet }
}

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * CHARACTERIZATION of `sweepDelegate()`'s confirmation waits BEFORE #1756.
 *
 * Every `it()` here describes what the SDK does **today**, defect included.
 * The fix inverts the first three and must preserve the last two.
 */
describe('#1756 characterization — DelegateSweepApi.sweepDelegate confirmation waits (pre-fix)', () => {
  it('passes confirmations ONLY — there is no deadline argument on either leg', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue({ hash: '0xusdc-receipt' }) }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    fundedDelegate(usdcTx, ethTx)

    await service().sweepDelegate()

    // `wait(1)` reads as a deliberate bound. It is not one: in ethers v6 the
    // FIRST argument is confirmations and the SECOND is the timeout, so this
    // is exactly as unbounded as a bare `wait()`.
    expect(usdcTx.wait).toHaveBeenCalledWith(1)
    expect(ethTx.wait).toHaveBeenCalledWith(1)
    expect(usdcTx.wait.mock.calls[0]).toHaveLength(1)
    expect(ethTx.wait.mock.calls[0]).toHaveLength(1)
  })

  it('THE DEFECT: a USDC transfer that never mines hangs sweepDelegate() forever — no result, no error, no tx hash', async () => {
    const usdcTx = { hash: '0xusdc', wait: neverMinesWait() }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    const { wallet } = fundedDelegate(usdcTx, ethTx)

    expect(await settleWithin(service().sweepDelegate())).toBe(HUNG)

    // And the second leg never even starts, so the ETH this sweep exists to
    // recover is stranded by the USDC leg's stall.
    expect(wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('THE DEFECT, native leg: a stuck ETH transfer hangs the caller after the USDC leg already moved money', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue({ hash: '0xusdc-receipt' }) }
    const ethTx = { hash: '0xeth', wait: neverMinesWait() }
    fundedDelegate(usdcTx, ethTx)

    // The USDC transfer confirmed. The caller is never told, because the
    // return value that would carry it is behind the ETH leg's unbounded wait.
    expect(await settleWithin(service().sweepDelegate())).toBe(HUNG)
  })

  it('THE DEFECT: a null receipt is reported as a completed transfer, indistinguishable from a confirmed one', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue(null) }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    fundedDelegate(usdcTx, ethTx)

    const result = await service().sweepDelegate()

    // `receipt?.hash ?? tx.hash` silently substitutes the broadcast hash, and
    // the entry then looks exactly like the confirmed ETH one beside it.
    expect(result.transfers[0]).toMatchObject({ asset: 'USDC', txHash: '0xusdc' })
    expect(Object.keys(result.transfers[0]).sort()).toEqual(Object.keys(result.transfers[1]).sort())
  })

  it('PRESERVE: a genuine revert propagates to the caller uncaught', async () => {
    const usdcTx = { hash: '0xusdc', wait: revertedWait() }
    fundedDelegate(usdcTx, { hash: '0xeth', wait: vi.fn() })

    await expect(service().sweepDelegate()).rejects.toMatchObject({ code: 'CALL_EXCEPTION' })
  })

  it('PRESERVE: the confirmed path returns the RECEIPT hash, not the broadcast hash', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue({ hash: '0xusdc-receipt' }) }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    fundedDelegate(usdcTx, ethTx)

    const result = await service().sweepDelegate()

    expect(result.transfers.map((t) => t.txHash)).toEqual(['0xusdc-receipt', '0xeth-receipt'])
    expect(result.transfers.map((t) => t.explorerUrl)).toEqual([
      'https://explorer.test/8453/0xusdc-receipt',
      'https://explorer.test/8453/0xeth-receipt',
    ])
  })
})
