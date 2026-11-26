/**
 * #4808 B — the local MCP's `haven_get_payment_status` names only tools this
 * surface registers.
 *
 * The backend's `message` names `haven_report_settlement_evidence` in two
 * states, a tool only the hosted MCP registers. This surface cannot report a
 * settlement hash at all, so the instruction is unreachable for the agent
 * reading it. The handler replaces `message` whole in those two states, keyed
 * on the structured fields (`phase`, `nextAction`) and never on the backend's
 * sentence, and names no reporting tool.
 *
 * The hosted MCP reads the same SDK helper and must keep the backend text —
 * see `packages/mcp-server/src/payment-status-message.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, toolSchemas } from './tools.js'

const delegateKey = '0x59c6995e998f97a5a0044966f09453843a4bba3e18a70e0614612ece7c1e4568'
const baseUrl = 'https://haven.example'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function handlers() {
  return createToolHandlers(new HavenClient({ apiKey: 'test-key', delegateKey, baseUrl }))
}

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

const BACKEND_DELIVERED_UNVERIFIED =
  "This payment is settled no further than it was: the merchant delivered, but the settlement window and the sweep's last chance to verify a settlement have both passed with no verified on-chain evidence. Polling cannot change this — tell the user the goods were delivered but Haven holds no verified settlement evidence for this payment. If you hold the merchant's real settlement transaction hash, haven_report_settlement_evidence still accepts it."

const BACKEND_AWAITING_SETTLEMENT_EVIDENCE =
  "The settlement window passed with no verified on-chain evidence for this payment's settlement yet. If you hold the merchant's real settlement transaction hash, report it with haven_report_settlement_evidence. Otherwise, Haven's settlement sweep can still attribute it until shortly after this payment's expiry — poll haven_get_payment_status once more a couple of minutes past that. If it still shows no evidence, the goods were delivered but Haven holds no verified settlement evidence for this payment; tell the user."

const LOCAL_DELIVERED_UNVERIFIED =
  "This payment is settled no further than it was: the merchant delivered, but the settlement window and the sweep's last chance to verify a settlement have both passed with no verified on-chain evidence. Polling cannot change this — tell the user the goods were delivered but Haven holds no verified settlement evidence for this payment."

const LOCAL_AWAITING_SETTLEMENT_EVIDENCE =
  "The settlement window passed with no verified on-chain evidence for this payment's settlement yet. Haven's settlement sweep can still attribute it until shortly after this payment's expiry — poll haven_get_payment_status once more a couple of minutes past that. If it still shows no evidence, the goods were delivered but Haven holds no verified settlement evidence for this payment; tell the user."

/** A tool name, on a word boundary on both sides (the #4796 extractor). */
const TOOL_NAME = /(?<![a-z0-9])haven_[a-z0-9]+(?:_[a-z0-9]+)*/g

afterEach(() => {
  vi.restoreAllMocks()
})

describe('#4808 B — local haven_get_payment_status replaces the settlement-evidence message', () => {
  const states = [
    {
      label: 'delivered_unverified',
      overrides: { phase: 'delivered_unverified', next_action: 'stop_and_tell_user' },
      backend: BACKEND_DELIVERED_UNVERIFIED,
      replacement: LOCAL_DELIVERED_UNVERIFIED,
    },
    {
      label: 'awaiting_settlement_evidence',
      overrides: { phase: 'payment_submitted', next_action: 'awaiting_settlement_evidence' },
      backend: BACKEND_AWAITING_SETTLEMENT_EVIDENCE,
      replacement: LOCAL_AWAITING_SETTLEMENT_EVIDENCE,
    },
  ] as const

  for (const state of states) {
    // Twice per state: once with the backend's current sentence, once with an
    // arbitrary string. The replacement keys on phase/next_action, never on the
    // backend's wording.
    for (const [variant, message] of [
      ['the backend sentence', state.backend],
      ['an arbitrary string', 'some other sentence entirely'],
    ] as const) {
      it(`${state.label}: pins the local replacement with ${variant} in the fixture`, async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          jsonResponse(statusBody({ ...state.overrides, message })),
        )

        const result = await handlers().haven_get_payment_status({ payment_id: 'pay_x402' })
        expect(result.success).toBe(true)
        const data = (result as { data: { message: string } }).data

        expect(data.message).toBe(state.replacement)
        // Every haven_… name in the replacement is registered on this surface.
        const registered = Object.keys(toolSchemas)
        for (const name of data.message.match(TOOL_NAME) ?? []) {
          expect(registered, name).toContain(name)
        }
        expect(data.message).not.toContain('haven_report_settlement_evidence')
      })
    }
  }

  it('passes the backend message through unchanged in every other state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(statusBody({ phase: 'payment_confirmed', next_action: 'none', message: 'The payment is confirmed.' })),
    )

    const result = await handlers().haven_get_payment_status({ payment_id: 'pay_x402' })
    expect(result.success).toBe(true)
    expect((result as { data: { message: string } }).data.message).toBe('The payment is confirmed.')
  })
})
