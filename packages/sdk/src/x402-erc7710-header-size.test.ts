/**
 * #2341 — erc7710 sends the v2 header name ALONE, and the request stays under
 * the merchant's header-size limit.
 *
 * ## What this exists to catch
 *
 * #2289 fixed a real outage by setting both wire names on every merchant
 * retry. On the EIP-3009 bridge that is right and must not change: the header
 * is a signature plus a six-field authorization, duplicating it costs nothing,
 * and lenient v1-only merchants exist.
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
  x402PaymentHeaderNamesSent,
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

/** The EIP-3009 shape: small, and still gets BOTH names. */
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

  it('an EIP-3009 delivery still carries BOTH — the #2289 fix is untouched', async () => {
    const { transport, seen } = transportWithCapture()
    const header = eip3009Header()
    await transport.deliverPayment(URL_, undefined, header)

    expect(seen[0].get(X402_PAYMENT_HEADER_NAME)).toBe(header)
    expect(
      seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME),
      'lenient v1-only merchants are real and this is the path the #2288 ' +
        'CoinGecko purchase used. Narrowing this would trade one outage for another.',
    ).toBe(header)
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
    expect(x402PaymentHeaderNamesSent(eip3009Header())).toBe(
      `${X402_PAYMENT_HEADER_NAME}, ${X402_LEGACY_PAYMENT_HEADER_NAME}`,
    )
  })
})
