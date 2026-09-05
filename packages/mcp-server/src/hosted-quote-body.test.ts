import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HavenClient } from '@haven_ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHostedMcpServer } from './tools.js'

/**
 * `haven_quote_x402` can quote a body-bearing paywall (#2366).
 *
 * The gap this closes was measured, not theorised: the hosted tool built its
 * `RequestInit` from `method` and `headers` only, so a POST paywall whose 402
 * depends on the request payload was probed with an EMPTY body — `POST /paid ::`
 * — and the quote described a request the caller never made. #2348 made that
 * refuse rather than lie, which was right and is not undone here; what changes
 * is that the question is now answerable.
 *
 * ## Why these go over the real transport
 *
 * The MCP SDK strips undeclared keys **before** a handler runs (#2312), so a
 * test that called the handler directly would pass whether or not `body` is in
 * the schema — it would be asserting its own fixture. Every assertion here
 * therefore travels client → `InMemoryTransport` → server, which is the only
 * arrangement that can tell a declared argument from an accepted one. That is
 * the acceptance criterion this issue states, and it is the reason the tool
 * ever shipped with the gap.
 */

const seen: { url: string; init?: RequestInit }[] = []

function stubFetch() {
  seen.length = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    seen.push({ url, init })
    // A 402 shaped enough for the SDK's quote path to parse.
    return {
      ok: false,
      status: 402,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '1000',
            resource: url,
            payTo: `0x${'ab'.repeat(20)}`,
            asset: `0x${'cd'.repeat(20)}`,
            maxTimeoutSeconds: 60,
          },
        ],
      }),
      text: async () => '',
    } as unknown as Response
  })
}

async function connectedClient() {
  const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
  const server = buildHostedMcpServer(haven)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'hosted-quote-body-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

async function quote(args: Record<string, unknown>) {
  const client = await connectedClient()
  try {
    return (await client.callTool({ name: 'haven_quote_x402', arguments: args })) as {
      isError?: boolean
      content?: { type: string; text?: string }[]
    }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err) }] }
  }
}

/** The paywall probe, as distinct from any Haven API call the tool also makes. */
const probe = () => seen.find((call) => call.url.includes('merchant.test'))

beforeEach(stubFetch)
afterEach(() => vi.unstubAllGlobals())

describe('haven_quote_x402 — body reaches the paywall (#2366)', () => {
  it('sends the body verbatim on the probe', async () => {
    await quote({
      url: 'https://merchant.test/paid',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"query":"weather"}',
    })
    expect(probe()?.init?.method).toBe('POST')
    expect(probe()?.init?.body).toBe('{"query":"weather"}')
  })

  it('is ACCEPTED by the strict schema rather than refused', async () => {
    // The half a handler-level test cannot see: `body` has to be declared for
    // the SDK to pass it through at all, and the tool is on the strict list,
    // so an undeclared key is a refusal rather than a silent strip.
    const result = await quote({
      url: 'https://merchant.test/paid',
      method: 'POST',
      body: '{"a":1}',
    })
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? ''
    expect(text).not.toMatch(/unrecognized_keys|Input validation error/i)
  })

  it('distinguishes an EMPTY body from no body at all', async () => {
    // The distinction the old code could not make, and the reason it lied: a
    // paywall that varies on POST-with-no-payload is answering a different
    // request from one with no body. `!== undefined` rather than truthiness.
    await quote({ url: 'https://merchant.test/paid', method: 'POST', body: '' })
    expect(probe()?.init?.body).toBe('')

    stubFetch()
    await quote({ url: 'https://merchant.test/paid', method: 'POST' })
    expect(probe()?.init?.body).toBeUndefined()
  })

  it('still quotes a plain GET with no body', async () => {
    // Positive control for the shape that always worked, so a regression in
    // the common case cannot hide behind the new one passing.
    await quote({ url: 'https://merchant.test/paid' })
    expect(probe()).toBeDefined()
    expect(probe()?.init?.body).toBeUndefined()
  })

  it('does not infer a content type the caller did not send', async () => {
    // The local surface sets the body verbatim and leaves headers to the
    // caller. Guessing here would make the hosted probe a different request
    // from the local one for identical arguments, which is the divergence
    // this issue exists to reduce.
    await quote({ url: 'https://merchant.test/paid', method: 'POST', body: 'raw' })
    const headers = probe()?.init?.headers as Record<string, string> | undefined
    expect(headers?.['content-type'] ?? headers?.['Content-Type']).toBeUndefined()
  })
})
