/**
 * On-chain AllowanceModule transfer verification (#994 extraction from
 * routes/x402-resources.ts's `_verifyTx`).
 *
 * Does NOT belong on the `ChainClient` port: this decodes ONE specific
 * legacy-rail contract's calldata shape (`executeAllowanceTransfer`) — there
 * is no delegation-rail equivalent to substitute, so a generic interface
 * would be speculative. Moved here purely to get the direct `ethers` import
 * (the `Interface` calldata decode, `provider.getTransaction`/
 * `getTransactionReceipt`) out of `routes/**`.
 */
import { ethers } from 'ethers'
import { getProvider } from '../../lib/allowance-module.js'
import { getChain } from '../../lib/chains.js'

const ALLOWANCE_MODULE_IFACE = new ethers.Interface([
  'function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)',
])

export interface AllowanceTransferVerification {
  valid: boolean
  reason?: string
  payer?: string
  amount?: bigint
}

/**
 * Verify an on-chain AllowanceModule transfer transaction.
 *
 * Decodes the tx calldata and checks that:
 *   - tx was confirmed (status = 1)
 *   - tx was sent to the AllowanceModule contract
 *   - transfer went to the expected Safe (payTo)
 *   - token matches the resource's token
 *   - amount >= expected price
 */
export async function verifyAllowanceTransferTx(
  chainId: number,
  txHash: string,
  expectedSafe: string, // the Safe that should receive the funds (payTo in AllowanceModule)
  expectedToken: string,
  expectedAmount: bigint,
): Promise<AllowanceTransferVerification> {
  try {
    const provider = getProvider(chainId)
    const chain = getChain(chainId)

    const [tx, receipt] = await Promise.all([
      provider.getTransaction(txHash),
      provider.getTransactionReceipt(txHash),
    ])

    if (!tx) return { valid: false, reason: 'Transaction not found on chain' }
    if (!receipt) return { valid: false, reason: 'Transaction not yet confirmed' }
    if (receipt.status !== 1) return { valid: false, reason: 'Transaction reverted' }

    // Check tx was to the AllowanceModule
    const moduleAddress = chain.contracts.allowanceModule?.toLowerCase()
    if (moduleAddress && tx.to?.toLowerCase() !== moduleAddress) {
      return { valid: false, reason: 'Transaction was not sent to the AllowanceModule contract' }
    }

    // Decode calldata
    let parsed: ethers.TransactionDescription | null = null
    try {
      parsed = ALLOWANCE_MODULE_IFACE.parseTransaction({ data: tx.data })
    } catch {
      return { valid: false, reason: 'Could not decode transaction calldata as AllowanceModule transfer' }
    }

    if (!parsed || parsed.name !== 'executeAllowanceTransfer') {
      return { valid: false, reason: 'Transaction is not an executeAllowanceTransfer call' }
    }

    const [safe, token, to, amount] = parsed.args as unknown as [string, string, string, bigint]

    // 'to' in executeAllowanceTransfer is the recipient of the funds (the Safe owner's Safe)
    if (to.toLowerCase() !== expectedSafe.toLowerCase()) {
      return {
        valid: false,
        reason: `Payment went to ${to}, expected ${expectedSafe}`,
      }
    }

    if (token.toLowerCase() !== expectedToken.toLowerCase()) {
      return {
        valid: false,
        reason: `Wrong token: got ${token}, expected ${expectedToken}`,
      }
    }

    if (amount < expectedAmount) {
      return {
        valid: false,
        reason: `Insufficient amount: got ${amount.toString()}, required ${expectedAmount.toString()}`,
      }
    }

    return {
      valid: true,
      payer: safe.toLowerCase(), // the Safe that paid (payer's Safe)
      amount,
    }
  } catch (err) {
    return {
      valid: false,
      reason: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
