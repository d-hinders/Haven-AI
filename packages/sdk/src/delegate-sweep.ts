import { createErc20Contract, createJsonRpcProvider, createWallet } from './provider.js'
import { sweepUsdcAddress, isSweepableChain, type SweepAuthorization, type SweepPrepareResponse, type SweepSubmitResponse } from './sweep.js'
import { DEFAULT_CONFIRMATION_TIMEOUT_MS, HavenApiError, HavenSigningError, type HavenAgent, type SweepConfirmation, type SweepResult } from './types.js'
import type { HavenApiTransport } from './haven-api-transport.js'

/** The shape of an ethers v6 `TransactionResponse` this module actually uses. */
interface SweepTx {
  hash: string
  wait: (confirmations?: number, timeoutMs?: number) => Promise<{ hash: string } | null>
}

/**
 * Did a confirmation wait expire, as opposed to fail? (#1756)
 *
 * ethers v6 rejects with `code: 'TIMEOUT'` when the deadline passed and
 * `code: 'CALL_EXCEPTION'` when the transaction mined and reverted. Only the
 * first is "still in flight" — collapsing them is the same defect this fix
 * exists to remove, one layer out.
 */
function isWaitTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'TIMEOUT'
}

/**
 * Wait for one sweep transfer, bounded (#1756).
 *
 * Before this, both legs called `wait(1)` — which passes CONFIRMATIONS, not a
 * timeout, so it was as unbounded as a bare `wait()` while reading like a
 * deliberate choice. A fee-stuck sweep hung the calling agent forever, with no
 * error and no way to learn the hash it was waiting on.
 *
 * Expiry RETURNS `unconfirmed` rather than throwing. The backend's equivalents
 * (#1722 / #1735 / #1742) can leave a stuck transaction to a durable outbound
 * record and a bump worker; this code runs on the user's machine with no queue
 * behind it, so the CALLER is the only possible owner of a stuck transfer —
 * and throwing would destroy the one thing that owner needs, the tx hash.
 *
 * Everything that is not a timeout still throws, unchanged: a revert is a
 * revert.
 */
async function waitForSweepTx(tx: SweepTx): Promise<{ txHash: string; confirmation: SweepConfirmation }> {
  let receipt: { hash: string } | null
  try {
    receipt = await tx.wait(1, DEFAULT_CONFIRMATION_TIMEOUT_MS)
  } catch (err) {
    if (!isWaitTimeout(err)) throw err
    return { txHash: tx.hash, confirmation: 'unconfirmed' }
  }
  // A null receipt is "no receipt yet", never "confirmed" — the pre-#1756 code
  // substituted the broadcast hash here and reported the transfer as done.
  if (!receipt) return { txHash: tx.hash, confirmation: 'unconfirmed' }
  return { txHash: receipt.hash, confirmation: 'confirmed' }
}

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
      if (balance > 0n) { const tx = await contract.transfer(agent.safeAddress, balance); const { txHash, confirmation } = await waitForSweepTx(tx as SweepTx); transfers.push({ asset: 'USDC', amount: format(balance, 6), amountAtomic: balance.toString(), txHash, explorerUrl: this.options.buildExplorerUrl(agent.chainId, txHash), confirmation }) }
    }
    // Reached even when the USDC leg came back `unconfirmed`: a stuck ERC-20
    // transfer must not strand the native balance this sweep also exists to
    // recover (#1756). Before the bound, it did — the ETH leg never ran.
    const balance = await provider.getBalance(agent.delegateAddress)
    if (balance > 0n) { const fee = await provider.getFeeData(); const send = balance - ((fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000n) * 21_000n * 2n); if (send > 0n) { const tx = await wallet.sendTransaction({ to: agent.safeAddress, value: send }); const { txHash, confirmation } = await waitForSweepTx(tx as SweepTx); transfers.push({ asset: 'ETH', amount: format(send, 18), amountAtomic: send.toString(), txHash, explorerUrl: this.options.buildExplorerUrl(agent.chainId, txHash), confirmation }) } }
    return { fromAddress: agent.delegateAddress, toAddress: agent.safeAddress, chainId: agent.chainId, transfers, unconfirmed: transfers.some((t) => t.confirmation === 'unconfirmed') }
  }
  prepareSweep(): Promise<SweepPrepareResponse> { return this.options.transport.post('/machine-payments/sweep/prepare', {}) }
  submitSweep(authorization: SweepAuthorization, signature: string): Promise<SweepSubmitResponse> { return this.options.transport.post('/machine-payments/sweep/submit', { authorization, signature }) }
}
function format(value: bigint, decimals: number): string { const raw = value.toString().padStart(decimals + 1, '0'); return `${raw.slice(0, -decimals) || '0'}.${raw.slice(-decimals).replace(/0+$/, '') || '0'}` }
