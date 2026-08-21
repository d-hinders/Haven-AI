import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DelegateSweepApi } from './delegate-sweep.js'
import { createErc20Contract, createJsonRpcProvider, createWallet } from './provider.js'
import { DEFAULT_CONFIRMATION_TIMEOUT_MS, type HavenAgent } from './types.js'

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
 * #1756 — `sweepDelegate()`'s confirmation waits are bounded, and expiry is a
 * REPORTED outcome rather than a hang or a thrown failure.
 *
 * These began as characterization tests of the pre-fix behaviour (commit
 * `82b611e8`); the first four are the same scenarios, inverted.
 */
describe('#1756 — DelegateSweepApi.sweepDelegate confirmation waits', () => {
  it('passes the shared 90 s deadline as the SECOND argument on both legs', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue({ hash: '0xusdc-receipt' }) }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    fundedDelegate(usdcTx, ethTx)

    await service().sweepDelegate()

    // In ethers v6 the FIRST argument is confirmations and the SECOND is the
    // timeout, so `wait(1)` alone was as unbounded as a bare `wait()` while
    // reading like a deliberate bound. Arity is asserted as well as value:
    // "the deadline argument was dropped again" is how this regresses.
    expect(usdcTx.wait).toHaveBeenCalledWith(1, DEFAULT_CONFIRMATION_TIMEOUT_MS)
    expect(ethTx.wait).toHaveBeenCalledWith(1, DEFAULT_CONFIRMATION_TIMEOUT_MS)
    expect(usdcTx.wait.mock.calls[0]).toHaveLength(2)
    expect(ethTx.wait.mock.calls[0]).toHaveLength(2)
  })

  it('reuses the SDK\'s existing confirmation default rather than inventing a fourth number', () => {
    // Pinned against the constant `HavenClient` uses for `confirmationTimeout`
    // — they are the same binding since #1756, so this cannot drift silently.
    expect(DEFAULT_CONFIRMATION_TIMEOUT_MS).toBe(90_000)
  })

  it('a USDC transfer that never mines returns `unconfirmed` with its broadcast hash instead of hanging', async () => {
    const usdcTx = { hash: '0xusdc', wait: neverMinesWait() }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    const { wallet } = fundedDelegate(usdcTx, ethTx)

    const result = await settleWithin(service().sweepDelegate())

    expect(result).not.toBe(HUNG)
    if (result === HUNG) return
    expect(result.transfers[0]).toMatchObject({
      asset: 'USDC',
      txHash: '0xusdc', // the BROADCAST hash — the only handle a user has for manual recovery
      confirmation: 'unconfirmed',
      explorerUrl: 'https://explorer.test/8453/0xusdc',
    })
    expect(result.unconfirmed).toBe(true)

    // And the ETH leg still runs: a stuck ERC-20 transfer must not strand the
    // native balance this sweep also exists to recover.
    expect(wallet.sendTransaction).toHaveBeenCalledOnce()
    expect(result.transfers[1]).toMatchObject({ asset: 'ETH', confirmation: 'confirmed' })
  })

  it('a stuck ETH transfer still reports the USDC transfer that DID confirm', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue({ hash: '0xusdc-receipt' }) }
    const ethTx = { hash: '0xeth', wait: neverMinesWait() }
    fundedDelegate(usdcTx, ethTx)

    const result = await settleWithin(service().sweepDelegate())

    expect(result).not.toBe(HUNG)
    if (result === HUNG) return
    // The two legs are reported independently: one confirmed, one still in
    // flight. A single thrown error could not express this.
    expect(result.transfers.map((t) => [t.asset, t.confirmation])).toEqual([
      ['USDC', 'confirmed'],
      ['ETH', 'unconfirmed'],
    ])
    expect(result.unconfirmed).toBe(true)
  })

  it('a null receipt is `unconfirmed`, not a completed transfer', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue(null) }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    fundedDelegate(usdcTx, ethTx)

    const result = await service().sweepDelegate()

    // Pre-#1756 this substituted the broadcast hash and the entry was
    // structurally identical to the confirmed one beside it. "No receipt" is
    // not "confirmed" — the same distinction, one node-behaviour away.
    expect(result.transfers[0]).toMatchObject({ asset: 'USDC', txHash: '0xusdc', confirmation: 'unconfirmed' })
    expect(result.transfers[1]).toMatchObject({ asset: 'ETH', confirmation: 'confirmed' })
    expect(result.unconfirmed).toBe(true)
  })

  it('`unconfirmed` is false only when EVERY transfer confirmed', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue({ hash: '0xusdc-receipt' }) }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    fundedDelegate(usdcTx, ethTx)

    const result = await service().sweepDelegate()

    expect(result.transfers.every((t) => t.confirmation === 'confirmed')).toBe(true)
    expect(result.unconfirmed).toBe(false)
  })

  it('an empty sweep is not `unconfirmed` — nothing was broadcast', async () => {
    const contract = { balanceOf: vi.fn().mockResolvedValue(0n), transfer: vi.fn() }
    const provider = { getBalance: vi.fn().mockResolvedValue(0n), getFeeData: vi.fn() }
    vi.mocked(createJsonRpcProvider).mockReturnValue(provider as never)
    vi.mocked(createWallet).mockReturnValue({ sendTransaction: vi.fn() } as never)
    vi.mocked(createErc20Contract).mockReturnValue(contract as never)

    expect(await service().sweepDelegate()).toMatchObject({ transfers: [], unconfirmed: false })
  })

  it('PRESERVE: a genuine revert propagates to the caller uncaught — a timeout is not a revert, and a revert is not a timeout', async () => {
    const usdcTx = { hash: '0xusdc', wait: revertedWait() }
    fundedDelegate(usdcTx, { hash: '0xeth', wait: vi.fn() })

    await expect(service().sweepDelegate()).rejects.toMatchObject({ code: 'CALL_EXCEPTION' })
  })

  it('PRESERVE: a non-TIMEOUT wait error still throws — the hand-off branch must stay narrow', async () => {
    // The way this fix decays is `isWaitTimeout` widening until nothing can
    // fail. Without this, a predicate that stopped discriminating would pass
    // every other test in the file.
    const usdcTx = {
      hash: '0xusdc',
      wait: vi.fn(() => Promise.reject(Object.assign(new Error('rpc exploded'), { code: 'NETWORK_ERROR' }))),
    }
    fundedDelegate(usdcTx, { hash: '0xeth', wait: vi.fn() })

    await expect(service().sweepDelegate()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
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
