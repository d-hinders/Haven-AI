import { createErc20Contract, createJsonRpcProvider, createWallet } from './provider.js'
import { sweepUsdcAddress, isSweepableChain, type SweepAuthorization, type SweepPrepareResponse, type SweepSubmitResponse } from './sweep.js'
import { HavenApiError, HavenSigningError, type HavenAgent, type SweepResult } from './types.js'
import type { HavenApiTransport } from './haven-api-transport.js'

export class DelegateSweepApi {
  constructor(private readonly options: { transport: Pick<HavenApiTransport, 'post'>; delegateKey?: string; chainRpcs: Record<number, string>; getAgent: () => Promise<HavenAgent>; buildExplorerUrl: (chainId: number, hash: string) => string }) {}
  async sweepDelegate(): Promise<SweepResult> {
    if (!this.options.delegateKey) throw new HavenSigningError('delegateKey is required for sweepDelegate.')
    const agent = await this.options.getAgent()
    if (!agent.delegateAddress) throw new HavenApiError('Agent has no delegate address.', 422)
    const rpcUrl = this.options.chainRpcs[agent.chainId]
    if (!rpcUrl) throw new HavenApiError(`chainRpcs[${agent.chainId}] must be configured to sweep the delegate wallet.`, 422)
    const provider = createJsonRpcProvider(rpcUrl)
    const wallet = createWallet(this.options.delegateKey, provider)
    const transfers: SweepResult['transfers'] = []
    if (isSweepableChain(agent.chainId)) {
      const contract = createErc20Contract(sweepUsdcAddress(agent.chainId), ['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'], wallet)
      const balance = await contract.balanceOf(agent.delegateAddress) as bigint
      if (balance > 0n) { const tx = await contract.transfer(agent.safeAddress, balance); const receipt = await (tx as { wait: (n: number) => Promise<{ hash: string } | null> }).wait(1); const txHash = receipt?.hash ?? (tx as { hash: string }).hash; transfers.push({ asset: 'USDC', amount: format(balance, 6), amountAtomic: balance.toString(), txHash, explorerUrl: this.options.buildExplorerUrl(agent.chainId, txHash) }) }
    }
    const balance = await provider.getBalance(agent.delegateAddress)
    if (balance > 0n) { const fee = await provider.getFeeData(); const send = balance - ((fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000n) * 21_000n * 2n); if (send > 0n) { const tx = await wallet.sendTransaction({ to: agent.safeAddress, value: send }); const receipt = await tx.wait(1); const txHash = receipt?.hash ?? tx.hash; transfers.push({ asset: 'ETH', amount: format(send, 18), amountAtomic: send.toString(), txHash, explorerUrl: this.options.buildExplorerUrl(agent.chainId, txHash) }) } }
    return { fromAddress: agent.delegateAddress, toAddress: agent.safeAddress, chainId: agent.chainId, transfers }
  }
  prepareSweep(): Promise<SweepPrepareResponse> { return this.options.transport.post('/machine-payments/sweep/prepare', {}) }
  submitSweep(authorization: SweepAuthorization, signature: string): Promise<SweepSubmitResponse> { return this.options.transport.post('/machine-payments/sweep/submit', { authorization, signature }) }
}
function format(value: bigint, decimals: number): string { const raw = value.toString().padStart(decimals + 1, '0'); return `${raw.slice(0, -decimals) || '0'}.${raw.slice(-decimals).replace(/0+$/, '') || '0'}` }
