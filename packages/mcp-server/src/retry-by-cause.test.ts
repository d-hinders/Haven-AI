/**
 * #4470 — the hosted refusal step decides retry or stop from the CAUSE, not
 * the HTTP status alone.
 *
 * Every case here is driven through real SDK code over a stubbed `fetch` (or
 * a local JSON-RPC server, for the funding wait), never a hand-built error:
 * a hand-built error passes while the site that should produce it stays
 * broken, which is how the trial for this issue found it.
 *
 * Part 1 — a non-answer (the transport's own 408 timeout and status 0) is not
 * a refusal: a read may be re-called once, a write's outcome is unknown.
 * Part 2 — an SDK refusal of an answer it cannot use is not transient: a
 * retry gets the same answer, whatever its 5xx status says.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HavenApiError, HavenClient } from '@haven_ai/sdk'
import { normalizeError } from './tools/support/errors.js'
import { quoteMcpToolCall, withDiscoveryGuidance } from './tools/support/mcp-context.js'
import { requireAgentIdentity } from './tools/identity-gate.js'
import { createToolHandlers, type ToolPayload } from './tools.js'
import { AGENT_RESPONSE, PAYMENT_REQUIRED } from './test-support/hosted-mcp.js'

// The reasons, pinned whole: a reworded reason reddens these.
const NO_ANSWER_READ =
  'Haven did not answer this read (it timed out, was unreachable, or sent an unreadable body); a read changes nothing, so re-call the same tool with the same arguments once before telling the user'
const NO_ANSWER_WRITE =
  'Haven did not answer this write (it timed out, was unreachable, or sent an unreadable body), so whether it took effect is unknown; do not re-call it or create a new payment — if it concerned a payment_id, read haven_get_payment_status for it, otherwise tell the user'
const DETERMINISTIC =
  'Haven answered, but with something this client cannot use (the message says what); re-calling it the same way gets the same answer, so tell the user what failed'
const STOP_4XX =
  'the upstream call was refused as made (4xx); re-calling it the same way cannot succeed, so tell the user what failed'
const RETRY_5XX =
  'the upstream call failed transiently; re-call the same tool with the same arguments (and the same idempotency_key where the tool has one) once before telling the user'

type Answer = { status: number; json?: unknown; text?: string } | 'hang' | 'reject'

const FUNDING_TX = '0x' + 'ab'.repeat(32)

/**
 * Route `METHOD /path` to an answer, or to a function of the request body;
 * an unrouted request is a test bug, so it throws loudly.
 */
function stubBackend(routes: Record<string, Answer | ((body: Record<string, unknown> | undefined) => Answer)>) {
  const seen: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`
    seen.push(key)
    const route = routes[key]
    const answer = typeof route === 'function'
      ? route(init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined)
      : route
    if (answer === undefined) throw new Error(`unrouted test request: ${key}`)
    if (answer === 'reject') throw new TypeError('fetch failed')
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')))
      })
    }
    return new Response(answer.text ?? JSON.stringify(answer.json ?? {}), { status: answer.status })
  })
  return seen
}

function client(extra: Partial<ConstructorParameters<typeof HavenClient>[0]> = {}): HavenClient {
  return new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test', requestTimeout: 25, ...extra })
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

function failure(payload: ToolPayload): Record<string, unknown> {
  if (payload.success) throw new Error(`expected a failure, got ${JSON.stringify(payload)}`)
  return payload as unknown as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const NO_ANSWERS: Array<[string, Answer]> = [
  ['a hang (transport 408)', 'hang'],
  ['a rejecting fetch (status 0)', 'reject'],
  ['an HTML gateway 502 (status 0)', { status: 502, text: '<html>Bad Gateway</html>' }],
  ['a non-JSON 200 (status 0)', { status: 200, text: 'ok' }],
]

describe('Part 1 — a non-answer is not a refusal (#4470)', () => {
  it.each(NO_ANSWERS)('%s on a READ (getAgent): re-call once, never "refused"', async (_label, answer) => {
    stubBackend({ 'GET /machine-payments/agent': answer })
    const err = await caught(client().getAgent())
    const out = normalizeError(err)
    expect(out.next_action).toBe('retry_with_explicit_context')
    expect(out.next_tool_omitted_reason).toBe(NO_ANSWER_READ)
    expect(out.next_tool_omitted_reason).not.toMatch(/refused|4xx/)
  })

  it.each(NO_ANSWERS)('%s on a WRITE (submitSignature): never "re-call the same tool"', async (_label, answer) => {
    stubBackend({ 'POST /payments/pay_1/sign': answer })
    const err = await caught(client().submitSignature('pay_1', '0x' + '11'.repeat(65)))
    const out = normalizeError(err)
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool_omitted_reason).toBe(NO_ANSWER_WRITE)
    expect(out.next_tool_omitted_reason).not.toMatch(/refused|4xx|re-call the same tool/)
  })

  it('a server that ANSWERS 408 with a JSON body is an answer: it keeps the 4xx step', async () => {
    stubBackend({ 'GET /machine-payments/agent': { status: 408, json: { error: 'Request timed out' } } })
    const out = normalizeError(await caught(client().getAgent()))
    expect(out.next_tool_omitted_reason).toBe(STOP_4XX)
  })

  it('the identity gate (a read before every gated tool) answers a hang with re-call once', async () => {
    stubBackend({ 'GET /machine-payments/agent': 'hang' })
    const out = normalizeError(await caught(requireAgentIdentity(client())))
    expect(out.next_action).toBe('retry_with_explicit_context')
    expect(out.next_tool_omitted_reason).toBe(NO_ANSWER_READ)
  })

  it.each(NO_ANSWERS)('%s on haven_submit\'s erc7710 settle: the status read for args.payment_id, never a retry', async (_label, answer) => {
    stubBackend({
      'POST /x402/pay_7710/settle': answer,
      // paymentWindowExpiredErrorFor reads the status only behind a 410; listed so a wrong read would be visible.
      'GET /machine-payments/pay_7710/status': { status: 200, json: { payment_id: 'pay_7710', status: 'submitted' } },
    })
    const out = failure(
      await createToolHandlers(client()).haven_submit({
        payment_id: 'pay_7710',
        signature: '0x' + '22'.repeat(65),
        settlement_scheme: 'erc7710',
      }),
    )
    expect(out.code).toBe('NO_ANSWER_OUTCOME_UNKNOWN')
    expect(out.next_action).toBe('check_status_later')
    expect(out.next_tool_name).toBe('haven_get_payment_status')
    expect(out.next_arguments).toEqual({ payment_id: 'pay_7710' })
    expect(String(out.message)).not.toMatch(/\bretry\b|re-call/i)
    expect(String(out.message)).toContain('do not create a new payment')
  })

  it('haven_submit\'s eip3009 relay answers a hang the same way', async () => {
    stubBackend({ 'POST /payments/pay_3009/sign': 'hang' })
    const out = failure(
      await createToolHandlers(client()).haven_submit({ payment_id: 'pay_3009', signature: '0x' + '33'.repeat(65) }),
    )
    expect(out.code).toBe('NO_ANSWER_OUTCOME_UNKNOWN')
    expect(out.next_arguments).toEqual({ payment_id: 'pay_3009' })
  })
})

describe('Part 1 — the settlement report never claims an on-chain mismatch it did not check (#4470)', () => {
  const MERCHANT_TX = '0x' + 'be'.repeat(32)
  const fundedStatus = {
    payment_id: 'pay_x402', kind: 'payment_intent', rail: 'x402', status: 'confirmed', phase: 'payment_confirmed',
    next_action: 'none', amount: '0.10', token: 'USDC', resource_url: 'https://merchant.example/r',
    merchant_address: '0x00000000000000000000000000000000000000c1', tx_hash: FUNDING_TX,
    expires_at: '2099-01-01T00:00:00.000Z', chain_id: 8453, settlement_scheme: 'eip3009', message: 'confirmed',
  }

  it.each([
    ...NO_ANSWERS,
    ['a server 408 with a JSON body', { status: 408, json: { error: 'Request timed out' } }] as [string, Answer],
  ])('%s on the evidence post: retryable, and never "does not match this payment on-chain"', async (_label, answer) => {
    stubBackend({
      'GET /machine-payments/pay_x402/status': { status: 200, json: fundedStatus },
      'POST /machine-payments/evidence': answer,
    })
    const payload = await createToolHandlers(client()).haven_report_settlement_evidence({
      payment_id: 'pay_x402',
      settlement_tx_hash: MERCHANT_TX,
      payment_header: 'eyJ4IjoxfQ==',
    })
    const text = JSON.stringify(payload)
    expect(text).not.toMatch(/does not match this payment on-chain/)
    expect(text).not.toMatch(/do not re-report the same hash/)
    const data = (payload as { data?: Record<string, unknown> }).data ?? {}
    expect(data).toMatchObject({ settled: false, code: 'SETTLEMENT_PENDING', retryable: true })
    expect(String(data.reason)).toContain('Haven did not answer')
  })

  it.each(NO_ANSWERS)('%s on haven_report_x402_outcome\'s settlement report: never "does not match this payment on-chain"', async (_label, answer) => {
    stubBackend({
      'GET /machine-payments/pay_x402/status': { status: 200, json: fundedStatus },
      // The outcome's own funding-hash post is accepted; the settlement report gets no answer.
      'POST /machine-payments/evidence': (body) => (body?.txHash === MERCHANT_TX ? answer : { status: 202, json: { evidence: { id: 'ev_1' } } }),
    })
    const payload = await createToolHandlers(client()).haven_report_x402_outcome({
      payment_id: 'pay_x402',
      outcome: 'accepted',
      merchant_status: 200,
      settlement_tx_hash: MERCHANT_TX,
      payment_header: 'eyJ4IjoxfQ==',
    })
    const text = JSON.stringify(payload)
    expect(text).not.toMatch(/does not match this payment on-chain/)
    expect(text).not.toMatch(/do not re-report the same hash/)
    const data = (payload as { data?: Record<string, unknown> }).data ?? {}
    expect(data.settlement_evidence).toMatchObject({ recorded: false, outcome: 'retryable' })
    expect(data.next_tool_name).toBe('haven_report_settlement_evidence')
  })

  it('a genuine 409 refusal is still classed refused (the control)', async () => {
    stubBackend({
      'GET /machine-payments/pay_x402/status': { status: 200, json: fundedStatus },
      'POST /machine-payments/evidence': { status: 409, json: { error: 'tx_hash_mismatch' } },
    })
    const payload = await createToolHandlers(client()).haven_report_settlement_evidence({
      payment_id: 'pay_x402',
      settlement_tx_hash: MERCHANT_TX,
      payment_header: 'eyJ4IjoxfQ==',
    })
    expect(JSON.stringify(payload)).toMatch(/does not match this payment on-chain/)
  })

  it.each([
    ['a hang (408)', 'hang' as Answer],
    ['a rejecting fetch (0)', 'reject' as Answer],
  ])('%s on the status read before the report: nothing is posted (unavailable, not drop)', async (_label, answer) => {
    const seen = stubBackend({ 'GET /machine-payments/pay_x402/status': answer })
    const payload = await createToolHandlers(client()).haven_report_settlement_evidence({
      payment_id: 'pay_x402',
      settlement_tx_hash: MERCHANT_TX,
      payment_header: 'eyJ4IjoxfQ==',
    })
    expect(seen).not.toContain('POST /machine-payments/evidence')
    expect(JSON.stringify(payload)).toContain('the same payment_header you passed')
  })

  it('a genuine 404 on the status read still drops the header and reports (the control)', async () => {
    const seen = stubBackend({
      'GET /machine-payments/pay_x402/status': { status: 404, json: { error: 'Payment not found' } },
      'POST /machine-payments/evidence': { status: 404, json: { error: 'Payment not found' } },
    })
    await createToolHandlers(client()).haven_report_settlement_evidence({
      payment_id: 'pay_x402',
      settlement_tx_hash: MERCHANT_TX,
      payment_header: 'eyJ4IjoxfQ==',
    })
    expect(seen).toContain('POST /machine-payments/evidence')
  })
})

describe('Part 1 — the funding wait answers both its outcomes (#4470)', () => {
  // A real ethers JsonRpcProvider against a local JSON-RPC server, so ethers'
  // own waitForTransaction decides: a receipt that never arrives REJECTS with
  // its TIMEOUT once the wait (30 s, spent on fake timers) runs out — an RPC
  // error takes the same road, since ethers swallows it and keeps waiting —
  // and a mined status-0 receipt RESOLVES.
  let server: Server
  let rpcUrl: string
  let receiptAnswer: 'never' | 'reverted' = 'never'

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const parsed = JSON.parse(raw) as { id: number; method: string } | Array<{ id: number; method: string }>
        const one = (call: { id: number; method: string }) => {
          if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: '0x2105' }
          if (call.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: call.id, result: '0x10' }
          if (call.method === 'eth_getTransactionReceipt') {
            if (receiptAnswer === 'never') return { jsonrpc: '2.0', id: call.id, result: null }
            return {
              jsonrpc: '2.0', id: call.id, result: {
                transactionHash: FUNDING_TX, transactionIndex: '0x0', blockHash: '0x' + 'cc'.repeat(32), blockNumber: '0x10',
                from: '0x00000000000000000000000000000000000000a1', to: '0x00000000000000000000000000000000000000b1',
                cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null,
                logs: [], logsBloom: '0x' + '00'.repeat(256), type: '0x2', status: '0x0',
              },
            }
          }
          return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unstubbed ${call.method}` } }
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  async function complete(advanceMs = 0): Promise<{ out: Record<string, unknown>; merchantCalled: boolean }> {
    // Only Haven's API goes through fetch; ethers' provider speaks to the RPC server over node:http.
    stubBackend({
      'GET /machine-payments/pay_x402/status': {
        status: 200,
        json: { payment_id: 'pay_x402', rail: 'x402', status: 'confirmed', tx_hash: FUNDING_TX, chain_id: 8453, message: 'confirmed' },
      },
    })
    const haven = client({ chainRpcs: { 8453: rpcUrl }, requestTimeout: 5_000 })
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall')
    const pending = createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: {},
      mcp_transport: { handshake_required: true, source: 'bazaar' },
      payment_header: 'eyJwYXltZW50IjoiaGVhZGVyIn0=',
    })
    if (advanceMs) await vi.advanceTimersByTimeAsync(advanceMs)
    const out = failure(await pending)
    return { out, merchantCalled: merchant.mock.calls.length > 0 }
  }

  it('a receipt that never arrives (ethers rejects with TIMEOUT): check status first, funding may have moved', async () => {
    receiptAnswer = 'never'
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    const { out, merchantCalled } = await complete(31_000).finally(() => vi.useRealTimers())
    expect(merchantCalled).toBe(false)
    expect(out.code).toBe('FUNDING_CONFIRMATION_UNKNOWN')
    expect(out.next_action).toBe('check_status_later')
    expect(out.next_tool_name).toBe('haven_get_payment_status')
    expect(out.next_arguments).toEqual({ payment_id: 'pay_x402' })
    expect(String(out.message)).toContain('Do not create a new payment')
  })

  it('a mined status-0 receipt: its own stop, nothing reached the delegate', async () => {
    receiptAnswer = 'reverted'
    const { out, merchantCalled } = await complete()
    expect(merchantCalled).toBe(false)
    expect(out.code).toBe('FUNDING_REVERTED')
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool_omitted_reason).toBe(
      'the funding transaction reverted on-chain, so nothing reached the delegate and nothing was delivered; retrying this payment_id reads the same receipt, so tell the user',
    )
  })
})

describe('Part 2 — a deterministic SDK failure is not transient (#4470)', () => {
  const ERC7710_REQUIRED = {
    ...PAYMENT_REQUIRED,
    accepts: [{ ...PAYMENT_REQUIRED.accepts[0], extra: { ...PAYMENT_REQUIRED.accepts[0].extra, assetTransferMethod: 'erc7710' } }],
  }
  const pendingIntent = { payment_id: 'pay_1', status: 'pending_signature', expires_at: '2099-01-01T00:00:00.000Z', chain_id: 8453 }
  const DELEGATE_KEY = '0x' + '01'.repeat(32)

  const expectDeterministic = (err: unknown, message: RegExp) => {
    expect(err).toBeInstanceOf(HavenApiError)
    expect((err as HavenApiError).message).toMatch(message)
    const out = normalizeError(err)
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool_omitted_reason).toBe(DETERMINISTIC)
  }

  it('client.ts — no delegate address registered (createX402Intent)', async () => {
    stubBackend({ 'GET /machine-payments/agent': { status: 200, json: { ...AGENT_RESPONSE, delegate_address: null } } })
    expectDeterministic(await caught(client().createX402Intent(PAYMENT_REQUIRED as never)), /no delegate address registered/)
  })

  it('client.ts — no sign_hash from x402/authorize (createX402Intent)', async () => {
    stubBackend({ 'POST /x402': { status: 201, json: { ...pendingIntent, sign_data: {} } } })
    const err = await caught(client().createX402Intent(PAYMENT_REQUIRED as never, { delegateAddress: '0x00000000000000000000000000000000000000d1' }))
    expectDeterministic(err, /No sign_hash returned/)
  })

  it('client.ts — no expected-context binding (createX402Intent)', async () => {
    stubBackend({ 'POST /x402': { status: 201, json: { ...pendingIntent, sign_data: { hash: '0x' + '44'.repeat(32) } } } })
    const err = await caught(client().createX402Intent(PAYMENT_REQUIRED as never, { delegateAddress: '0x00000000000000000000000000000000000000d1' }))
    expectDeterministic(err, /No x402 expected-context binding/)
  })

  it('x402-erc7710.ts — no payment_id (prepareX402Erc7710)', async () => {
    stubBackend({ 'POST /x402': { status: 201, json: { status: 'pending_signature' } } })
    const err = await caught(client().prepareX402Erc7710(ERC7710_REQUIRED as never, { delegationRail: true }))
    expectDeterministic(err, /No payment_id returned/)
  })

  it('x402-erc7710.ts — not an erc7710 settlement child (prepareX402Erc7710)', async () => {
    stubBackend({ 'POST /x402': { status: 201, json: { ...pendingIntent, sign_data: { hash: '0x' + '44'.repeat(32), signature_scheme: 'eip712_userop' } } } })
    const err = await caught(client().prepareX402Erc7710(ERC7710_REQUIRED as never, { delegationRail: true }))
    expectDeterministic(err, /did not return an erc7710 settlement child/)
  })

  it('x402-erc7710.ts — settle returned no payment_header, through haven_submit', async () => {
    stubBackend({ 'POST /x402/pay_7710/settle': { status: 200, json: { status: 'submitted' } } })
    const out = failure(
      await createToolHandlers(client()).haven_submit({
        payment_id: 'pay_7710',
        signature: '0x' + '22'.repeat(65),
        settlement_scheme: 'erc7710',
      }),
    )
    expect(out.message).toMatch(/settle returned no payment_header/)
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool_omitted_reason).toBe(DETERMINISTIC)
  })

  // No backend body reaches these two: every receipt the SDK builds carries
  // `accepted` and a header. They are driven through the real retry method
  // with the incomplete receipt they guard against.
  it.each([
    ['no accepted x402 option', {}, /No accepted x402 option/],
    ['no x402 payment header', { accepted: PAYMENT_REQUIRED.accepts[0] }, /No x402 payment header/],
  ])('merchant-completion.ts — %s (retryRequest)', async (_label, receipt, message) => {
    stubBackend({})
    const completion = (client() as unknown as { merchantCompletion: { retryRequest: (...a: unknown[]) => Promise<unknown> } }).merchantCompletion
    const err = await caught(completion.retryRequest('https://merchant.test/paid', undefined, PAYMENT_REQUIRED, receipt))
    expectDeterministic(err, message)
  })

  it('x402-funding-leg.ts — no sign_hash from x402/authorize (authorizeX402, local key)', async () => {
    stubBackend({ 'POST /x402': { status: 201, json: { ...pendingIntent, sign_data: {} } } })
    const err = await caught(client({ delegateKey: DELEGATE_KEY }).authorizeX402(PAYMENT_REQUIRED as never))
    expectDeterministic(err, /No sign_hash returned/)
  })

  it('the mark survives the hosted discovery rebuild (mcp-context.ts withDiscoveryGuidance)', () => {
    const rebuilt = withDiscoveryGuidance(HavenApiError.deterministic('No sign_hash returned from x402/authorize', 500), 'https://merchant.test', null)
    expect(normalizeError(rebuilt).next_tool_omitted_reason).toBe(DETERMINISTIC)
  })

  it('payment-state.ts — pending_approval (202) and failed (502) are stated stops', async () => {
    // Reached only when the answer is not a recognisable payment state (no
    // payment_id, or a status this SDK has no phase for) — a recognisable one
    // throws HavenPaymentStateError and takes its own typed step first.
    for (const raw of [{ status: 'pending_approval' }, { status: 'failed' }, { payment_id: 'pay_1', status: 'some_future_status' }]) {
      const status = raw.status
      stubBackend({ 'POST /x402': { status: 200, json: raw } })
      const err = await caught(client().createX402Intent(PAYMENT_REQUIRED as never, { delegateAddress: '0x00000000000000000000000000000000000000d1' }))
      const out = normalizeError(err)
      expect(out.next_tool_omitted_reason, status).toBe(DETERMINISTIC)
    }
  })

  it('a genuine upstream 5xx with no recognised error_code stays transient (regression pin)', async () => {
    stubBackend({ 'POST /x402': { status: 500, json: { error: 'prepare_failed' } } })
    const err = await caught(client().createX402Intent(PAYMENT_REQUIRED as never, { delegateAddress: '0x00000000000000000000000000000000000000d1' }))
    const out = normalizeError(err)
    expect(out.next_action).toBe('retry_with_explicit_context')
    expect(out.next_tool_omitted_reason).toBe(RETRY_5XX)
  })
})

describe('#4470 review — the paths round 1 left untested', () => {
  it('haven_settle_mcp_tool\'s erc7710 settle answers a hang with the status read for args.payment_id (S1)', async () => {
    stubBackend({ 'POST /x402/pay_7710/settle': 'hang' })
    const out = failure(
      await createToolHandlers(client()).haven_settle_mcp_tool({
        payment_id: 'pay_7710',
        signature: '0x' + '22'.repeat(65),
        merchant_url: 'https://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: {},
      }),
    )
    expect(out.code).toBe('NO_ANSWER_OUTCOME_UNKNOWN')
    expect(out.next_action).toBe('check_status_later')
    expect(out.next_tool_name).toBe('haven_get_payment_status')
    expect(out.next_arguments).toEqual({ payment_id: 'pay_7710' })
  })

  it('the discovered-endpoint rebuild in quoteMcpToolCall keeps the cause (S4)', async () => {
    stubBackend({ 'GET /.well-known/haven-demo-merchant': { status: 200, json: { mcp_url: 'https://merchant.test/mcp' } } })
    const haven = client()
    vi.spyOn(haven, 'quoteMcpX402')
      .mockRejectedValueOnce(new HavenApiError('Expected an x402 quote response with HTTP 402, got HTTP 404.', 404))
      .mockRejectedValueOnce(HavenApiError.deterministic('No sign_hash returned from x402/authorize', 500))
    const err = await caught(quoteMcpToolCall(haven, { merchantUrl: 'https://merchant.test/base', toolName: 't', toolArguments: {} }))
    expect((err as Error).message).toContain('DISCOVERED endpoint')
    expect(normalizeError(err).next_tool_omitted_reason).toBe(DETERMINISTIC)
  })
})
