/**
 * #2341 / #4754 — an x402 v2 payload sends the v2 header name ALONE, and the
 * request stays under the merchant's header-size limit.
 *
 * **#4754 (owner decision 2026-11-09)** extended the #2341 rule below from
 * erc7710 to every v2 payload. The #2361 extensions echo had grown EIP-3009
 * headers to 5–6.5 KB, and Anchor answered HTTP 431 to one sent under both
 * names after funding. Only an x402 v1 payload (no `accepted`, no echo) keeps
 * both names now; the second describe block pins the version table.
 *
 * ## What this exists to catch (the #2341 history)
 *
 * #2289 fixed a real outage by setting both wire names on every merchant
 * retry. On the EIP-3009 bridge that looked free at the time: the header was
 * a signature plus a six-field authorization.
 *
 * On erc7710 it broke everything. That header carries the whole
 * `[child, budget]` delegation chain plus the UserOperation — kilobytes — so
 * sending it twice pushed the request past the server header-size limit and
 * merchants answered **HTTP 431 Request Header Fields Too Large**. Every
 * erc7710 scenario in the money-flow QA run failed, and on the hosted path the
 * funding leg had already moved user funds when the 431 landed
 * (`MERCHANT_REJECTED_AFTER_FUNDING`) — the #2288 defect class, reintroduced
 * by #2288's own fix on the other scheme.
 *
 * ## Why the assertion is by SCHEME, not by byte count
 *
 * An erc7710 payload is always `x402Version: 2` (the backend's
 * `encodeXPaymentHeader` hardcodes it), and a merchant that can redeem a
 * delegation chain is by construction running x402 v2 plus the MetaMask
 * erc7710 extension — it reads `PAYMENT-SIGNATURE`. The legacy alias cannot
 * help it and can only cost the request. A byte threshold would be an
 * arbitrary number that changes behaviour silently near its own edge.
 *
 * The size test below is therefore a CONSEQUENCE check, not the rule: it
 * proves the scheme rule actually buys the bytes back, which a name-only
 * assertion would not. It fails if the duplicate ever returns, whatever the
 * mechanism. It does NOT reproduce the 431 — its fixture is a conservative
 * lower bound on a real payload, and the assertion says only what that
 * fixture supports. The live evidence for the threshold is the QA run.
 *
 * ## Why unit tests missed this in the first place
 *
 * Every #2289 test used a short placeholder string as the header, so no test
 * in the repository ever measured a REQUEST. The fixture merchant answered on
 * names alone. The defect lived entirely in a dimension the suite did not
 * look at, which is why this file asserts on realistic sizes.
 */
import { describe, expect, it, vi } from 'vitest'
import { McpMerchantTransport } from './mcp-merchant-transport.js'
import { encodeBase64Json } from './base64.js'
import {
  X402_LEGACY_PAYMENT_HEADER_NAME,
  X402_PAYMENT_HEADER_NAME,
  x402PaymentHeaderNamesFor,
  x402RetryHeadersFor,
  x402PaymentHeaderNamesSent,
  x402PaymentHeaderSchemeOf,
  x402V2PaymentEnvelope,
} from './x402.js'

const URL_ = 'https://merchant.test/mcp'

/** Node's default server limit for the whole request header block. */
const NODE_DEFAULT_MAX_HEADER_SIZE = 16_384

function transportWithCapture() {
  const seen: Headers[] = []
  const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
    seen.push(new Headers(init.headers))
    return new Response('ok')
  })
  return { transport: new McpMerchantTransport({ fetch }), seen }
}

/** Bytes this header block would put on the wire, `Name: value\r\n` each. */
function headerBlockBytes(headers: Headers): number {
  let total = 0
  headers.forEach((value, name) => {
    total += Buffer.byteLength(`${name}: ${value}\r\n`, 'utf8')
  })
  return total
}

const addr = `0x${'12'.repeat(20)}`
const sig = `0x${'ab'.repeat(65)}`

/**
 * A realistic erc7710 header: two delegations, three caveats each, a
 * UserOperation with real-sized callData and paymaster data. Deliberately
 * built rather than stubbed short — a short fixture is exactly what let this
 * ship.
 */
function erc7710Header(): string {
  const delegation = (n: number) => ({
    delegate: addr,
    delegator: addr,
    authority: `0x${'00'.repeat(32)}`,
    salt: `0x${n.toString(16).padStart(64, '0')}`,
    signature: sig,
    caveats: [
      { enforcer: addr, terms: `0x${'cd'.repeat(96)}`, args: '0x' },
      { enforcer: addr, terms: `0x${'ef'.repeat(64)}`, args: '0x' },
      { enforcer: addr, terms: `0x${'11'.repeat(32)}`, args: '0x' },
    ],
  })
  return encodeBase64Json({
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    accepted: {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      payTo: addr,
      maxTimeoutSeconds: 300,
      asset: addr,
      extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [addr] },
    },
    payload: {
      delegationChain: [delegation(1), delegation(2)],
      userOperation: {
        sender: addr,
        nonce: '0x1',
        callData: `0x${'22'.repeat(400)}`,
        paymasterAndData: `0x${'33'.repeat(200)}`,
        signature: sig,
      },
    },
  })
}

/**
 * The x402 v2 EIP-3009 shape. Since #4754 it gets `PAYMENT-SIGNATURE` alone:
 * every v2 payload does, whatever its scheme.
 */
function eip3009Header(): string {
  return encodeBase64Json({
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      payTo: addr,
      maxTimeoutSeconds: 300,
      asset: addr,
      extra: { name: 'USD Coin', version: '2' },
    },
    payload: {
      signature: sig,
      authorization: {
        from: addr, to: addr, value: '10000',
        validAfter: '0', validBefore: '99999999999', nonce: `0x${'aa'.repeat(32)}`,
      },
    },
  })
}

/**
 * The x402 v1 shape — the library's v1 encoding, which the SDK and the signer
 * return as-is when the challenge is `x402Version < 2`. No `accepted`, no
 * extensions echo; keeps BOTH names (#4754).
 */
function v1Header(): string {
  return encodeBase64Json({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: sig,
      authorization: {
        from: addr, to: addr, value: '10000',
        validAfter: '0', validBefore: '99999999999', nonce: `0x${'bb'.repeat(32)}`,
      },
    },
  })
}

describe('#2341 — erc7710 sends the v2 name alone', () => {
  it('an erc7710 delivery carries PAYMENT-SIGNATURE and NOT the legacy alias', async () => {
    const { transport, seen } = transportWithCapture()
    const header = erc7710Header()
    await transport.deliverPayment(URL_, undefined, header)

    expect(seen[0].get(X402_PAYMENT_HEADER_NAME)).toBe(header)
    expect(
      seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME),
      'erc7710 is always x402 v2; the legacy alias cannot help such a merchant ' +
        'and duplicating a delegation-chain header is what produced HTTP 431.',
    ).toBeNull()
  })

  it('an x402 v2 EIP-3009 delivery carries PAYMENT-SIGNATURE alone (#4754); a v1 delivery keeps BOTH', async () => {
    const { transport, seen } = transportWithCapture()
    const header = eip3009Header()
    await transport.deliverPayment(URL_, undefined, header)

    expect(seen[0].get(X402_PAYMENT_HEADER_NAME)).toBe(header)
    expect(
      seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME),
      'owner decision 2026-11-09 (#4754): a v2 payload goes out under the v2 name ' +
        'alone — the #2361 extensions echo made doubling it answer HTTP 431 after funding.',
    ).toBeNull()

    const v1 = v1Header()
    await transport.deliverPayment(URL_, undefined, v1)
    expect(seen[1].get(X402_PAYMENT_HEADER_NAME)).toBe(v1)
    expect(
      seen[1].get(X402_LEGACY_PAYMENT_HEADER_NAME),
      'a v1 payload keeps the legacy name — lenient v1 merchants read only X-PAYMENT.',
    ).toBe(v1)
  })

  it('the erc7710 request carries the header ONCE, saving kilobytes off the block', async () => {
    const { transport, seen } = transportWithCapture()
    const header = erc7710Header()

    // Non-vacuity: a fixture too small to matter would pass this test while
    // proving nothing. A real erc7710 header is kilobytes.
    expect(header.length).toBeGreaterThan(4_000)

    await transport.deliverPayment(URL_, { headers: { 'Content-Type': 'application/json' } }, header)

    // Tie the bytes to the NAME decision. Without this the byte assertions
    // below pass under a mutation that restores the duplicate — the doubled
    // block is still under 16 KB for this deliberately conservative fixture,
    // so size alone cannot tell the two apart. Counting the value is what
    // makes this test fail for the right reason.
    let carryingTheHeader = 0
    seen[0].forEach((value) => { if (value === header) carryingTheHeader += 1 })
    expect(
      carryingTheHeader,
      'the erc7710 payment header must appear on exactly ONE header name; ' +
        'carrying it twice is the HTTP 431 defect.',
    ).toBe(1)

    const sent = headerBlockBytes(seen[0])
    const ifDuplicated = sent + Buffer.byteLength(
      `${X402_LEGACY_PAYMENT_HEADER_NAME}: ${header}\r\n`, 'utf8',
    )

    expect(sent).toBeLessThan(NODE_DEFAULT_MAX_HEADER_SIZE)
    // The claim that matters, and the only size claim this fixture actually
    // supports: dropping the duplicate saves KILOBYTES off the request, and
    // that saving is what closed the gap to the limit. This fixture is a
    // deliberate LOWER BOUND — it does not by itself exceed 16 KB when
    // duplicated, and asserting that it did would be a claim the evidence
    // does not carry. The live 431 came from a real payload larger than this
    // one plus the full MCP header block; what is provable here is the
    // mechanism and its magnitude, not the exact threshold crossing.
    expect(ifDuplicated - sent).toBeGreaterThan(4_000)
    expect(ifDuplicated).toBeGreaterThan(sent)
  })

  it('a stale legacy header on the caller init is DELETED, not left behind', async () => {
    const { transport, seen } = transportWithCapture()
    const header = erc7710Header()
    await transport.deliverPayment(
      URL_,
      { headers: { [X402_LEGACY_PAYMENT_HEADER_NAME]: 'stale-superseded-authorization' } },
      header,
    )
    // Not sending a name is not the same as leaving whatever was there. A
    // stale X-PAYMENT left in place is a superseded authorization we chose not
    // to overwrite — worse than the duplicate this change removes.
    expect(seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME)).toBeNull()
  })

  it('an unreadable header falls back to BOTH names — the #2289 behaviour', () => {
    // Haven builds this value itself, so a parse failure means something is
    // already wrong. The conservative answer keeps v1 merchants working rather
    // than guessing at a size problem we cannot confirm.
    expect(x402PaymentHeaderNamesFor('not-base64-json')).toEqual([
      X402_PAYMENT_HEADER_NAME,
      X402_LEGACY_PAYMENT_HEADER_NAME,
    ])
  })

  it('the evidence record names exactly what the request sent', () => {
    // The audit trail is derived from the same decision, so it cannot claim a
    // legacy header that never went on the wire.
    expect(x402PaymentHeaderNamesSent(erc7710Header())).toBe(X402_PAYMENT_HEADER_NAME)
    expect(x402PaymentHeaderNamesSent(eip3009Header())).toBe(X402_PAYMENT_HEADER_NAME)
    expect(x402PaymentHeaderNamesSent(v1Header())).toBe(
      `${X402_PAYMENT_HEADER_NAME}, ${X402_LEGACY_PAYMENT_HEADER_NAME}`,
    )
  })

  // #3727: the ready-made retry headers — keys from the LIVE name rule,
  // values always the header verbatim.
  it('x402RetryHeadersFor carries every name the rule puts on the wire, each valued with the header', () => {
    expect(x402RetryHeadersFor(erc7710Header())).toEqual({
      [X402_PAYMENT_HEADER_NAME]: erc7710Header(),
    })
    expect(x402RetryHeadersFor(eip3009Header())).toEqual({
      [X402_PAYMENT_HEADER_NAME]: eip3009Header(),
    })
    expect(x402RetryHeadersFor(v1Header())).toEqual({
      [X402_PAYMENT_HEADER_NAME]: v1Header(),
      [X402_LEGACY_PAYMENT_HEADER_NAME]: v1Header(),
    })
    // Derived from the same function the request path uses, not a copy of it:
    // the keys ARE the rule's answer for the same payload.
    expect(Object.keys(x402RetryHeadersFor(erc7710Header()))).toEqual(
      x402PaymentHeaderNamesFor(erc7710Header()),
    )
    expect(Object.keys(x402RetryHeadersFor(eip3009Header()))).toEqual(
      x402PaymentHeaderNamesFor(eip3009Header()),
    )
    expect(Object.keys(x402RetryHeadersFor(v1Header()))).toEqual(
      x402PaymentHeaderNamesFor(v1Header()),
    )
  })
})

const BOTH = [X402_PAYMENT_HEADER_NAME, X402_LEGACY_PAYMENT_HEADER_NAME]
const V2_ONLY = [X402_PAYMENT_HEADER_NAME]

describe('#4754 — the header names follow x402Version', () => {
  it.each([
    ['x402Version 2, EIP-3009 accepted', { x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453' } }, V2_ONLY],
    ['x402Version 3 (a later v2+ version)', { x402Version: 3, accepted: { scheme: 'exact', network: 'eip155:8453' } }, V2_ONLY],
    ['x402Version 2 with no accepted', { x402Version: 2, payload: {} }, V2_ONLY],
    ['x402Version 2 with an array accepted', { x402Version: 2, accepted: [] }, V2_ONLY],
    ['x402Version 1', { x402Version: 1, scheme: 'exact', network: 'base', payload: {} }, BOTH],
    ['no x402Version', { accepted: { scheme: 'exact', network: 'eip155:8453' } }, BOTH],
    ['a string x402Version', { x402Version: '2', accepted: { scheme: 'exact', network: 'eip155:8453' } }, BOTH],
    ['a non-finite x402Version', { x402Version: null, payload: {} }, BOTH],
  ])('%s', (_label, payload, expected) => {
    expect(x402PaymentHeaderNamesFor(encodeBase64Json(payload))).toEqual(expected)
  })

  it('a non-finite x402Version (raw JSON 1e999 → Infinity) falls back to BOTH names', () => {
    const raw = Buffer.from('{"x402Version":1e999,"accepted":{"scheme":"exact","network":"eip155:8453"}}', 'utf8').toString('base64')
    expect(x402PaymentHeaderNamesFor(raw)).toEqual(BOTH)
  })

  it('an erc7710 payload keeps the v2 name alone even without a readable version (#2341)', () => {
    const decoded = JSON.parse(Buffer.from(erc7710Header(), 'base64').toString('utf8')) as Record<string, unknown>
    delete decoded.x402Version
    expect(x402PaymentHeaderNamesFor(encodeBase64Json(decoded))).toEqual(V2_ONLY)
  })

  it('a real v2 EIP-3009 header whose challenge echoes a ≥5 KB bazaar block goes on the wire ONCE', async () => {
    // Built through the real envelope, so the #2361 extensions echo is what
    // makes it large — the mechanism behind the 2026-11-09 Anchor 431.
    const bazaar = {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: { chain: 'ethereum', calldata_hex: `0x${'ab'.repeat(68)}` } },
        output: { type: 'json', example: { rows: Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}`, name: `pool ${i}`, value: `${i}`.repeat(20) })) } },
      },
      schema: { type: 'object', description: 'x'.repeat(800) },
    }
    const accepted = {
      scheme: 'exact', network: 'eip155:8453', amount: '1000', payTo: addr, maxTimeoutSeconds: 300,
      asset: addr, extra: { name: 'USD Coin', version: '2' },
    }
    const envelope = x402V2PaymentEnvelope(
      { x402Version: 2, resource: { url: 'https://merchant.test/v1/decode' }, extensions: { bazaar } } as never,
      accepted as never,
      {
        signature: sig,
        authorization: { from: addr, to: addr, value: '1000', validAfter: '0', validBefore: '99999999999', nonce: `0x${'cc'.repeat(32)}` },
      },
    )
    const header = encodeBase64Json(envelope)
    // Non-vacuity: the fixture must be in the size class that answered 431.
    expect(header.length).toBeGreaterThan(5_000)

    const { transport, seen } = transportWithCapture()
    await transport.deliverPayment(URL_, { headers: { 'Content-Type': 'application/json' } }, header)
    let carrying = 0
    seen[0].forEach((value) => { if (value === header) carrying += 1 })
    expect(carrying, 'a v2 EIP-3009 header carried twice is the #4754 HTTP 431').toBe(1)
    expect(Object.keys(x402RetryHeadersFor(header))).toEqual(V2_ONLY)
  })

  it('x402PaymentHeaderSchemeOf reads the scheme from the payload, never from the name count', () => {
    expect(x402PaymentHeaderSchemeOf(erc7710Header())).toBe('erc7710')
    // One name on the wire, still EIP-3009 — the inference #4754 removed.
    expect(x402PaymentHeaderNamesFor(eip3009Header())).toEqual(V2_ONLY)
    expect(x402PaymentHeaderSchemeOf(eip3009Header())).toBe('eip3009')
    // No readable accepted reads as EIP-3009, the pre-#4754 answer.
    expect(x402PaymentHeaderSchemeOf(v1Header())).toBe('eip3009')
    expect(x402PaymentHeaderSchemeOf('not-base64-json')).toBe('eip3009')
  })
})
