/**
 * #4808 B — the hosted MCP keeps the backend's settlement-evidence message.
 *
 * The local MCP and the SDK's own `executeTool` replace `message` in the two
 * states whose backend text names `haven_report_settlement_evidence`, because
 * neither surface registers that tool. The hosted MCP DOES register it, so the
 * instruction is correct there and must reach the agent verbatim.
 *
 * This is the assertion that fails if a replacement is moved into the shared
 * read (`getPaymentStatusWithPostPurchaseAllowance`) instead of the two client
 * layers — the four backend pins would not notice.
 */
import { describe, expect, it } from 'vitest'
import { handlers, installSharedFixtureLifecycle, ok, stubFetch } from './test-support/hosted-mcp.js'

installSharedFixtureLifecycle()

const BACKEND_DELIVERED_UNVERIFIED =
  "This payment is settled no further than it was: the merchant delivered, but the settlement window and the sweep's last chance to verify a settlement have both passed with no verified on-chain evidence. Polling cannot change this — tell the user the goods were delivered but Haven holds no verified settlement evidence for this payment. If you hold the merchant's real settlement transaction hash, haven_report_settlement_evidence still accepts it."

const BACKEND_AWAITING_SETTLEMENT_EVIDENCE =
  "The settlement window passed with no verified on-chain evidence for this payment's settlement yet. If you hold the merchant's real settlement transaction hash, report it with haven_report_settlement_evidence. Otherwise, Haven's settlement sweep can still attribute it until shortly after this payment's expiry — poll haven_get_payment_status once more a couple of minutes past that. If it still shows no evidence, the goods were delivered but Haven holds no verified settlement evidence for this payment; tell the user."

function statusBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    payment_id: 'pay_x402',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'submitted',
    phase: 'payment_submitted',
    next_action: 'check_status_later',
    amount: '1.50',
    token: 'USDC',
    resource_url: 'https://merchant.example/paid',
    merchant_address: '0xMerchant',
    tx_hash: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    message: 'The payment is submitted.',
    ...overrides,
  }
}

describe('#4808 B — hosted haven_get_payment_status keeps the backend message', () => {
  const states = [
    {
      label: 'delivered_unverified',
      overrides: { phase: 'delivered_unverified', next_action: 'stop_and_tell_user' },
      backend: BACKEND_DELIVERED_UNVERIFIED,
    },
    {
      label: 'awaiting_settlement_evidence',
      overrides: { phase: 'payment_submitted', next_action: 'awaiting_settlement_evidence' },
      backend: BACKEND_AWAITING_SETTLEMENT_EVIDENCE,
    },
  ] as const

  for (const state of states) {
    it(`${state.label}: the hosted agent still reads haven_report_settlement_evidence`, async () => {
      stubFetch({
        'GET /machine-payments/pay_x402/status': { body: statusBody({ ...state.overrides, message: state.backend }) },
      })

      const result = ok<{ message: string }>(await handlers().haven_get_payment_status({ payment_id: 'pay_x402' }))

      expect(result.data.message).toBe(state.backend)
      expect(result.data.message).toContain('haven_report_settlement_evidence')
    })
  }
})
