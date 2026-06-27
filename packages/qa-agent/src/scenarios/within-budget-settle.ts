/**
 * #420 invariant: a within-budget payment **settles on-chain** and is logged.
 *
 * Creates a small USDC payment (inside the agent's allowance), signs it with the
 * delegate key, and asserts it reaches `confirmed` with a tx hash that also shows
 * up in the transaction history.
 */

import { ethers } from 'ethers'
import { signHash } from '../lib/haven-api.js'
import { type Scenario, type ScenarioContext, pass, fail } from './types.js'

const AMOUNT = '0.1' // USDC — within the seeded allowance and Safe balance

export const withinBudgetSettle: Scenario = {
  name: 'within-budget-settle',
  invariant: 'A payment inside the allowance settles on-chain and is logged as a receipt.',
  async run(ctx: ScenarioContext) {
    const created = await ctx.api.createPayment('USDC', AMOUNT, ctx.cfg.paymentTo)
    if (!created.ok || !created.data.payment_id || !created.data.sign_data?.hash) {
      return fail(
        `create payment did not return a signable intent (HTTP ${created.status}, status ${created.data.status ?? '?'}): ${created.data.error ?? created.data.message ?? ''}`,
      )
    }
    const { payment_id, sign_data } = created.data

    // Sign locally and self-verify before submitting.
    const signature = signHash(ctx.delegateKey, sign_data.hash)
    const recovered = ethers.recoverAddress(sign_data.hash, signature)
    if (recovered.toLowerCase() !== ctx.delegateAddress.toLowerCase()) {
      return fail(`local signature recovered ${recovered}, expected delegate ${ctx.delegateAddress}`)
    }

    const signed = await ctx.api.signPayment(payment_id, signature)
    if (!signed.ok) {
      // Surface a concise on-chain failure reason (e.g. relayer out of gas):
      // the human phrase before the tx dump, plus the ethers error code.
      const raw = signed.data.details ?? signed.data.error ?? `HTTP ${signed.status}`
      const phrase = raw.split('(transaction=')[0].trim()
      const code = raw.match(/code=([A-Z_]+)/)?.[1]
      return fail(`execution failed: ${phrase}${code ? ` [${code}]` : ''}`)
    }

    const settled = await ctx.api.pollUntilSettled(payment_id)
    if (settled.status !== 'confirmed' || !settled.tx_hash) {
      return fail(`payment ended '${settled.status}' (tx ${settled.tx_hash ?? 'none'}; ${settled.error_message ?? ''})`)
    }

    // Receipt assertion: the settlement tx is in the transaction history.
    const txs = await ctx.api.listTransactions()
    const logged = txs.ok && txs.data.transactions.some(
      (t) => t.tx_hash?.toLowerCase() === settled.tx_hash!.toLowerCase(),
    )
    if (!logged) {
      return fail(`settled (tx ${settled.tx_hash}) but tx not found in /transactions`)
    }

    return pass(`settled ${AMOUNT} USDC on-chain + logged (tx ${settled.tx_hash})`)
  },
}
