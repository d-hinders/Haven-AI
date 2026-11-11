/**
 * #4808 — `HavenClient.executeTool` dispatches every tool `havenTools`
 * advertises, and the status it returns names only tools the SDK agent can
 * call.
 *
 * Part D: `havenTools.claude()` and `havenTools.openai()` both list
 * `haven_sweep_delegate`, but `executeTool` had no branch for it — a model that
 * called the tool it was offered got `Unknown tool: haven_sweep_delegate`. The
 * capability already existed as `HavenClient.sweepDelegate()`, the same method
 * the local MCP's handler calls.
 *
 * Part B: the backend's `message` names `haven_report_settlement_evidence` in
 * two states, a tool only the hosted MCP registers. This surface replaces it
 * whole, keyed on the structured fields, and names `get_payment_status` — one
 * of the six — for the poll.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenApiError } from './types.js'
import { HavenClient } from './client.js'
import { havenTools } from './tools.js'

const delegateKey = `0x${'01'.repeat(32)}`

function client(): HavenClient {
  return new HavenClient({ apiKey: 'test-key', delegateKey, baseUrl: 'https://haven.example' })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const sweepResult = {
  fromAddress: '0xDelegate0000000000000000000000000000000001',
  toAddress: '0xAccount00000000000000000000000000000000002',
  chainId: 8453,
  transfers: [
    {
      asset: 'USDC' as const,
      amount: '1.5',
      amountAtomic: '1500000',
      txHash: `0x${'ab'.repeat(32)}`,
      explorerUrl: 'https://basescan.org/tx/0xab',
      confirmation: 'confirmed' as const,
    },
  ],
  unconfirmed: false,
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Part D: the sweep tool runs ──────────────────────────────────────────────

describe('#4808 D — executeTool dispatches haven_sweep_delegate', () => {
  it('calls sweepDelegate() once and returns its result as a plain object', async () => {
    const haven = client()
    const spy = vi.spyOn(haven, 'sweepDelegate').mockResolvedValue(sweepResult)

    const result = await haven.executeTool('haven_sweep_delegate', {})

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith()
    expect(result).toEqual(sweepResult)
    expect(result.fromAddress).toBe(sweepResult.fromAddress)
    expect(result.toAddress).toBe(sweepResult.toAddress)
    expect(result.chainId).toBe(sweepResult.chainId)
    expect(result.transfers).toEqual(sweepResult.transfers)
    // The get_allowances branch's shape: a plain object, not the class instance.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })

  it('reads nothing from input — an extra destination changes nothing about the call', async () => {
    const haven = client()
    const spy = vi.spyOn(haven, 'sweepDelegate').mockResolvedValue(sweepResult)

    await haven.executeTool('haven_sweep_delegate', { to: '0xAttacker', amount: '999', asset: 'USDC' })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith()
  })

  it('propagates an error from sweepDelegate() unchanged', async () => {
    const haven = client()
    const refusal = new HavenApiError('chainRpcs[8453] must be configured to sweep the delegate wallet.', 422)
    vi.spyOn(haven, 'sweepDelegate').mockRejectedValue(refusal)

    await expect(haven.executeTool('haven_sweep_delegate', {})).rejects.toBe(refusal)
  })

  it('every tool havenTools advertises has an executeTool branch (the class guard)', async () => {
    const haven = client()
    // The two payment branches catch and return a tool error; the read branches
    // and the sweep branch let errors propagate. Either is a pass — only
    // `Unknown tool` is a failure.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    vi.spyOn(haven, 'sweepDelegate').mockResolvedValue(sweepResult)

    const advertised = [
      ...havenTools.claude().map((tool) => tool.name),
      ...havenTools.openai().map((tool) => tool.function.name),
    ]
    // Anti-vacuity: six names per format, and the walk really runs.
    expect(havenTools.claude()).toHaveLength(6)
    expect(havenTools.openai()).toHaveLength(6)
    expect(advertised).toHaveLength(12)

    for (const name of advertised) {
      let error: unknown
      try {
        await haven.executeTool(name, {})
      } catch (err) {
        error = err
      }
      expect(String((error as Error | undefined)?.message ?? ''), name).not.toMatch(/Unknown tool/)
    }

    // Anti-vacuity: a name no branch handles does reject with `Unknown tool`.
    await expect(haven.executeTool('haven_not_a_real_tool', {})).rejects.toThrow(/Unknown tool/)
  })
})

// ── Part B: the status message names only tools this surface has ────────────

const BACKEND_DELIVERED_UNVERIFIED =
  "This payment is settled no further than it was: the merchant delivered, but the settlement window and the sweep's last chance to verify a settlement have both passed with no verified on-chain evidence. Polling cannot change this — tell the user the goods were delivered but Haven holds no verified settlement evidence for this payment. If you hold the merchant's real settlement transaction hash, haven_report_settlement_evidence still accepts it."

const BACKEND_AWAITING_SETTLEMENT_EVIDENCE =
  "The settlement window passed with no verified on-chain evidence for this payment's settlement yet. If you hold the merchant's real settlement transaction hash, report it with haven_report_settlement_evidence. Otherwise, Haven's settlement sweep can still attribute it until shortly after this payment's expiry — poll haven_get_payment_status once more a couple of minutes past that. If it still shows no evidence, the goods were delivered but Haven holds no verified settlement evidence for this payment; tell the user."

const SDK_DELIVERED_UNVERIFIED =
  "This payment is settled no further than it was: the merchant delivered, but the settlement window and the sweep's last chance to verify a settlement have both passed with no verified on-chain evidence. Polling cannot change this — tell the user the goods were delivered but Haven holds no verified settlement evidence for this payment."

const SDK_AWAITING_SETTLEMENT_EVIDENCE =
  "The settlement window passed with no verified on-chain evidence for this payment's settlement yet. Haven's settlement sweep can still attribute it until shortly after this payment's expiry — poll get_payment_status once more a couple of minutes past that. If it still shows no evidence, the goods were delivered but Haven holds no verified settlement evidence for this payment; tell the user."

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

describe('#4808 B — executeTool(get_payment_status) replaces the settlement-evidence message', () => {
  const states = [
    {
      label: 'delivered_unverified',
      overrides: { phase: 'delivered_unverified', next_action: 'stop_and_tell_user' },
      backend: BACKEND_DELIVERED_UNVERIFIED,
      replacement: SDK_DELIVERED_UNVERIFIED,
    },
    {
      label: 'awaiting_settlement_evidence',
      overrides: { phase: 'payment_submitted', next_action: 'awaiting_settlement_evidence' },
      backend: BACKEND_AWAITING_SETTLEMENT_EVIDENCE,
      replacement: SDK_AWAITING_SETTLEMENT_EVIDENCE,
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
      it(`${state.label}: pins the SDK-tools replacement with ${variant} in the fixture`, async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          jsonResponse(statusBody({ ...state.overrides, message })),
        )

        const result = await client().executeTool('get_payment_status', { payment_id: 'pay_x402' })

        expect(result.message).toBe(state.replacement)
        // Every haven_… name in the replacement is one of the six.
        expect(String(result.message)).not.toMatch(/haven_[a-z0-9_]+/)
        if (state.label === 'awaiting_settlement_evidence') {
          // The poll instruction, if kept, names the SDK's own status tool.
          expect(String(result.message)).toContain('poll get_payment_status')
        }
      })
    }
  }

  it('passes the backend message through unchanged in every other state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(statusBody({ phase: 'payment_confirmed', next_action: 'none', message: 'The payment is confirmed.' })),
    )

    const result = await client().executeTool('get_payment_status', { payment_id: 'pay_x402' })

    expect(result.message).toBe('The payment is confirmed.')
  })
})
