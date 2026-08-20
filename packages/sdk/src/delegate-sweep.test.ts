import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DelegateSweepApi } from './delegate-sweep.js'
import { createErc20Contract, createJsonRpcProvider, createWallet } from './provider.js'
import { sweepUsdcAddress } from './sweep.js'
import { HavenSigningError, type HavenAgent } from './types.js'

vi.mock('./provider.js', () => ({
  createErc20Contract: vi.fn(),
  createJsonRpcProvider: vi.fn(),
  createWallet: vi.fn(),
}))

const DELEGATE_KEY = '0xcaller_held_delegate_key'
const AGENT: HavenAgent = {
  id: 'agent_1',
  name: 'Sweep agent',
  status: 'active',
  safeAddress: '0xsafe',
  delegateAddress: '0xdelegate',
  chainId: 8453,
  executionRail: 'legacy',
}

function service(overrides: Partial<ConstructorParameters<typeof DelegateSweepApi>[0]> = {}) {
  return new DelegateSweepApi({
    transport: { post: vi.fn() } as never,
    delegateKey: DELEGATE_KEY,
    chainRpcs: { 8453: 'https://base-rpc.test' },
    getAgent: vi.fn().mockResolvedValue(AGENT),
    buildExplorerUrl: (chainId, hash) => `https://explorer.test/${chainId}/${hash}`,
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DelegateSweepApi', () => {
  it('uses only the caller-held key and sweeps canonical USDC before ETH to the authenticated Safe', async () => {
    const usdcTx = { hash: '0xusdc', wait: vi.fn().mockResolvedValue({ hash: '0xusdc-receipt' }) }
    const ethTx = { hash: '0xeth', wait: vi.fn().mockResolvedValue({ hash: '0xeth-receipt' }) }
    const contract = { balanceOf: vi.fn().mockResolvedValue(1_500_000n), transfer: vi.fn().mockResolvedValue(usdcTx) }
    const provider = {
      getBalance: vi.fn().mockResolvedValue(1_000_000_000_000_000_000n),
      getFeeData: vi.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n, gasPrice: null }),
    }
    const wallet = { sendTransaction: vi.fn().mockResolvedValue(ethTx) }
    vi.mocked(createJsonRpcProvider).mockReturnValue(provider as never)
    vi.mocked(createWallet).mockReturnValue(wallet as never)
    vi.mocked(createErc20Contract).mockReturnValue(contract as never)

    const result = await service().sweepDelegate()
    const reserved = 1_000_000_000n * 21_000n * 2n

    expect(createWallet).toHaveBeenCalledWith(DELEGATE_KEY, provider)
    expect(createErc20Contract).toHaveBeenCalledWith(
      sweepUsdcAddress(8453),
      expect.any(Array),
      wallet,
    )
    expect(contract.transfer).toHaveBeenCalledWith(AGENT.safeAddress, 1_500_000n)
    expect(wallet.sendTransaction).toHaveBeenCalledWith({
      to: AGENT.safeAddress,
      value: 1_000_000_000_000_000_000n - reserved,
    })
    expect(usdcTx.wait).toHaveBeenCalledWith(1)
    expect(ethTx.wait).toHaveBeenCalledWith(1)
    expect(result).toMatchObject({
      fromAddress: AGENT.delegateAddress,
      toAddress: AGENT.safeAddress,
      transfers: [
        { asset: 'USDC', amountAtomic: '1500000', txHash: '0xusdc-receipt' },
        { asset: 'ETH', amountAtomic: String(1_000_000_000_000_000_000n - reserved), txHash: '0xeth-receipt' },
      ],
    })
  })

  it('skips USDC on an unsupported chain but can still sweep native ETH', async () => {
    const provider = {
      getBalance: vi.fn().mockResolvedValue(1_000_000n),
      getFeeData: vi.fn().mockResolvedValue({ maxFeePerGas: null, gasPrice: 1n }),
    }
    const wallet = { sendTransaction: vi.fn().mockResolvedValue({ hash: '0xeth', wait: vi.fn().mockResolvedValue(null) }) }
    vi.mocked(createJsonRpcProvider).mockReturnValue(provider as never)
    vi.mocked(createWallet).mockReturnValue(wallet as never)

    const result = await service({
      chainRpcs: { 999: 'https://other-rpc.test' },
      getAgent: vi.fn().mockResolvedValue({ ...AGENT, chainId: 999 }),
    }).sweepDelegate()

    expect(createErc20Contract).not.toHaveBeenCalled()
    expect(wallet.sendTransaction).toHaveBeenCalledWith({ to: AGENT.safeAddress, value: 958_000n })
    expect(result.transfers).toEqual([expect.objectContaining({ asset: 'ETH', amountAtomic: '958000' })])
  })

  it('preserves missing-key, delegate, and RPC errors before any transfer', async () => {
    const missingKeyGetAgent = vi.fn()
    await expect(service({ delegateKey: undefined, getAgent: missingKeyGetAgent }).sweepDelegate())
      .rejects.toBeInstanceOf(HavenSigningError)
    expect(missingKeyGetAgent).not.toHaveBeenCalled()

    await expect(service({ getAgent: vi.fn().mockResolvedValue({ ...AGENT, delegateAddress: null }) }).sweepDelegate())
      .rejects.toMatchObject({ message: 'Agent has no delegate address.', statusCode: 422 })
    await expect(service({ chainRpcs: {} }).sweepDelegate())
      .rejects.toMatchObject({ message: 'chainRpcs[8453] must be configured to sweep the delegate wallet.', statusCode: 422 })
  })

  it('keeps keyless prepare and submit as exact API passthroughs', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true })
    const api = service({ transport: { post } as never })
    const authorization = { agentId: 'agent_1' } as never

    await api.prepareSweep()
    await api.submitSweep(authorization, '0xsig')

    expect(post).toHaveBeenNthCalledWith(1, '/machine-payments/sweep/prepare', {})
    expect(post).toHaveBeenNthCalledWith(2, '/machine-payments/sweep/submit', { authorization, signature: '0xsig' })
  })
})
