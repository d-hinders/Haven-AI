/**
 * VIES client (#3332) — pure-unit by construction: the SSRF guard's own two
 * I/O seams (transport, resolver) are injected, so every branch here runs
 * without a network. The bar this file is written to: outage-shaped
 * responses (timeouts, non-200, malformed bodies, every recorded VIES
 * failure code) must NEVER resolve to `invalid` — that is the one
 * distinction the owner decision on #3332 turns on.
 */
import { describe, expect, it } from 'vitest'
import type { PinnedRequest, PinnedResponse, PinnedTransport, ResolvedAddress } from '../../../infra/http/ssrf-guard.js'
import { checkVatWithVies, viesRequestForVatNumber } from '../vies-client.js'

const publicResolver = async (): Promise<ResolvedAddress[]> => [{ address: '93.184.216.34', family: 4 }]

function transportReturning(response: PinnedResponse): PinnedTransport {
  return async () => response
}

function jsonResponse(body: unknown, status = 200): PinnedResponse {
  return { status, location: null, body: JSON.stringify(body) }
}

/**
 * RECORDED responses, captured live on 2026-09-27 from the Commission's
 * production endpoint and its test service (`check-vat-test-service`, which
 * answers fixed shapes for fixed numbers). Every one came back HTTP 200.
 * Name/address are replaced with placeholders; the client never reads them.
 */
const RECORDED = {
  valid: {
    countryCode: 'DE', vatNumber: '100', requestDate: '2026-09-26T22:21:10.535Z', valid: true,
    requestIdentifier: '', name: '<name>', address: '<address>',
  },
  invalid: {
    countryCode: 'DE', vatNumber: '200', requestDate: '2026-09-26T22:21:10.652Z', valid: false,
    requestIdentifier: '', name: '---', address: '---',
  },
  // The production endpoint's success shape carries extra trader* fields.
  productionValid: {
    countryCode: 'SE', vatNumber: '556703748501', requestDate: '2026-09-26T22:21:24.395Z', valid: true,
    requestIdentifier: '', name: '<name>', address: '<address>', traderName: '---', traderStreet: '---',
    traderPostalCode: '---', traderCity: '---',
  },
  failure: (error: string) => ({ actionSucceed: false, errorWrappers: [{ error }] }),
}

describe('checkVatWithVies (#3332)', () => {
  it('a recorded valid answer is valid', async () => {
    const result = await checkVatWithVies('DE', '100', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse(RECORDED.valid)),
    })
    expect(result).toEqual({ status: 'valid', reason: null })
  })

  it("the production endpoint's valid shape (extra trader* fields) is valid", async () => {
    const result = await checkVatWithVies('SE', '556703748501', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse(RECORDED.productionValid)),
    })
    expect(result.status).toBe('valid')
  })

  it('a recorded valid: false is invalid — the one real "no"', async () => {
    const result = await checkVatWithVies('DE', '200', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse(RECORDED.invalid)),
    })
    expect(result).toEqual({ status: 'invalid', reason: null })
  })

  it.each([
    'SERVICE_UNAVAILABLE', 'MS_UNAVAILABLE', 'TIMEOUT', 'VAT_BLOCKED', 'GLOBAL_MAX_CONCURRENT_REQ',
    'MS_MAX_CONCURRENT_REQ', 'INVALID_INPUT', 'INVALID_REQUESTER_INFO',
  ])('the recorded failure %s is not_verifiable, never invalid', async (code) => {
    const result = await checkVatWithVies('DE', '300', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse(RECORDED.failure(code))),
    })
    expect(result).toEqual({ status: 'not_verifiable', reason: code })
  })

  it('an unrecognised failure code is not_verifiable, not invalid (never guesses a new code means "no")', async () => {
    const result = await checkVatWithVies('DE', '300', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse(RECORDED.failure('SOME_FUTURE_CODE'))),
    })
    expect(result).toEqual({ status: 'not_verifiable', reason: 'SOME_FUTURE_CODE' })
  })

  it('actionSucceed: false with no usable errorWrappers is not_verifiable', async () => {
    for (const body of [{ actionSucceed: false }, { actionSucceed: false, errorWrappers: [] }, { actionSucceed: false, errorWrappers: [{}] }]) {
      const result = await checkVatWithVies('DE', '300', {
        resolver: publicResolver,
        transport: transportReturning(jsonResponse(body)),
      })
      expect(result.status).toBe('not_verifiable')
    }
  })

  it('a failure body that also carries valid: false is still not_verifiable — the failure wins', async () => {
    const result = await checkVatWithVies('DE', '300', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse({ ...RECORDED.failure('MS_UNAVAILABLE'), valid: false })),
    })
    expect(result.status).toBe('not_verifiable')
  })

  it('the pre-verification guessed shape ({ isValid }) is NOT accepted — a drift reads as not_verifiable', async () => {
    const result = await checkVatWithVies('DE', '100', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse({ isValid: true })),
    })
    expect(result).toEqual({ status: 'not_verifiable', reason: 'malformed_response' })
  })

  it('a non-200 HTTP status is not_verifiable', async () => {
    const result = await checkVatWithVies('DE', '811569869', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse(RECORDED.invalid, 503)),
    })
    expect(result).toEqual({ status: 'not_verifiable', reason: 'http_503' })
  })

  it('a malformed (non-JSON) body is not_verifiable', async () => {
    const result = await checkVatWithVies('DE', '811569869', {
      resolver: publicResolver,
      transport: transportReturning({ status: 200, location: null, body: '<html>not json</html>' }),
    })
    expect(result).toEqual({ status: 'not_verifiable', reason: 'malformed_response' })
  })

  it('a JSON body with neither valid nor a failure shape is not_verifiable', async () => {
    const result = await checkVatWithVies('DE', '811569869', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse({ requestDate: '2026-01-01' })),
    })
    expect(result).toEqual({ status: 'not_verifiable', reason: 'malformed_response' })
  })

  it('a JSON array (not an object) is not_verifiable', async () => {
    const result = await checkVatWithVies('DE', '811569869', {
      resolver: publicResolver,
      transport: transportReturning(jsonResponse([1, 2, 3])),
    })
    expect(result.status).toBe('not_verifiable')
  })

  it('a transport timeout is not_verifiable, never invalid', async () => {
    // The guard's own timeout is enforced INSIDE the real transport (it hands
    // the remaining budget down as `req.timeoutMs`); a fake transport
    // simulates the outcome by returning the same `SsrfRefusal` shape the
    // real one would once it gives up.
    const result = await checkVatWithVies('DE', '811569869', {
      resolver: publicResolver,
      transport: async (req) => ({ ok: false, reason: 'timeout', detail: `no response within ${req.timeoutMs}ms` }),
    })
    expect(result.status).toBe('not_verifiable')
  })

  it('a DNS failure (the resolver throwing) is not_verifiable', async () => {
    const result = await checkVatWithVies('DE', '811569869', {
      resolver: async () => {
        throw new Error('ENOTFOUND')
      },
      transport: transportReturning(jsonResponse(RECORDED.valid)),
    })
    expect(result.status).toBe('not_verifiable')
  })

  it('never throws — every branch resolves', async () => {
    await expect(
      checkVatWithVies('DE', '811569869', {
        resolver: publicResolver,
        transport: async () => {
          throw new Error('socket reset')
        },
      }),
    ).resolves.toMatchObject({ status: 'not_verifiable' })
  })
})

/**
 * #3332 review B1 — the request SHAPE bug, verified live against the
 * production endpoint on 2026-09-27: sending the VAT number's own prefix
 * INSIDE `vatNumber` (and/or the company's `country` instead of that prefix)
 * makes VIES answer `valid:false`/`INVALID_INPUT` for numbers that answer
 * `valid:true` in the correct shape. `viesRequestForVatNumber` is the fix;
 * these tests pin its pure derivation AND capture the actual transport
 * request body a real service-path call (`checkVatWithVies` fed the derived
 * values) produces — the same seam `modules/owner-profile/service.ts`'s
 * `runViesCheck` calls through.
 */
describe('viesRequestForVatNumber (#3332 review B1)', () => {
  it('a Swedish number: countryCode from the prefix, vatNumber without it', () => {
    expect(viesRequestForVatNumber('SE556703748501')).toEqual({ countryCode: 'SE', vatNumber: '556703748501' })
  })

  it('a mismatched-country number: the VAT prefix wins, never the company country', () => {
    // The company's `country` field never reaches this function at all — it
    // takes only the stored VAT number, so a DE-prefixed number always maps
    // to DE regardless of what country the owner's company details say.
    expect(viesRequestForVatNumber('DE811569869')).toEqual({ countryCode: 'DE', vatNumber: '811569869' })
  })

  it('Greece: the VAT prefix GR maps to VIES\'s own EL country code', () => {
    expect(viesRequestForVatNumber('GR094014201')).toEqual({ countryCode: 'EL', vatNumber: '094014201' })
  })

  it('Northern Ireland: XI is already VIES\'s own country code, no mapping', () => {
    expect(viesRequestForVatNumber('XI123456789')).toEqual({ countryCode: 'XI', vatNumber: '123456789' })
  })
})

describe('checkVatWithVies request body, through the real service path (#3332 review B1)', () => {
  function capturingTransport(): { transport: PinnedTransport; requests: PinnedRequest[] } {
    const requests: PinnedRequest[] = []
    const transport: PinnedTransport = async (req) => {
      requests.push(req)
      return { status: 200, location: null, body: JSON.stringify({ valid: true }) }
    }
    return { transport, requests }
  }

  it('SE556703748501 → {countryCode:"SE", vatNumber:"556703748501"} on the wire', async () => {
    const { transport, requests } = capturingTransport()
    const { countryCode, vatNumber } = viesRequestForVatNumber('SE556703748501')
    await checkVatWithVies(countryCode, vatNumber, { resolver: publicResolver, transport })
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0].body ?? '')).toEqual({ countryCode: 'SE', vatNumber: '556703748501' })
  })

  it('a VAT prefix that differs from the company country still sends the VAT prefix as countryCode', async () => {
    const { transport, requests } = capturingTransport()
    const { countryCode, vatNumber } = viesRequestForVatNumber('DE811569869')
    // The company's own `country` ('SE', say) never enters this call at all.
    await checkVatWithVies(countryCode, vatNumber, { resolver: publicResolver, transport })
    expect(JSON.parse(requests[0].body ?? '')).toEqual({ countryCode: 'DE', vatNumber: '811569869' })
  })

  it('a Greek VAT number sends countryCode "EL", never "GR"', async () => {
    const { transport, requests } = capturingTransport()
    const { countryCode, vatNumber } = viesRequestForVatNumber('GR094014201')
    await checkVatWithVies(countryCode, vatNumber, { resolver: publicResolver, transport })
    expect(JSON.parse(requests[0].body ?? '')).toEqual({ countryCode: 'EL', vatNumber: '094014201' })
  })
})

