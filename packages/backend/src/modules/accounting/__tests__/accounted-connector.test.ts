/**
 * Accounted connector unit tests (#3017, epic #3016) — fixture-backed, no DB.
 * The three fixtures are LIVE recordings from app.accounted.se with the test
 * key (redacted): one company, several companies, and the provider's 401
 * envelope. The cases map 1:1 to the acceptance list: single → `baseCurrency:
 * null` (null, never 'SEK' — the read path exposes no currency and inventing
 * one would let a future provider change read as a switch), several →
 * `MultiCompanyKeyError`, 401 → the `ProviderError` the generic flow maps to
 * `InvalidApiKeyError`. Plus the auth-refusal vs outage split and the wire
 * contract (bearer key, no un-asked-for headers, no key in any message).
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { AccountedConnector, MultiCompanyKeyError } from '../accounted-connector.js'
import { ACCOUNTED_API_BASE } from '../accounted-client.js'
import type { ProviderSecrets } from '../connector.js'
import { ProviderError } from '../provider.js'

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/accounted/${name}`, import.meta.url), 'utf8'))
}

/** A fetch double that answers every call with the given status + JSON body and records requests. */
function fetchReturning(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), headers: init?.headers ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** A fetch double whose every call rejects — the outage shape. */
function fetchFailing(message: string) {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

const SECRETS: ProviderSecrets = { apiKey: 'test-accounted-key-unit' }
const SINGLE = (await fixture('companies.json')) as { data: { id: string; name: string }[] }

describe('AccountedConnector.getCompanyInfo (#3017)', () => {
  it('one company → the company from the live fixture, baseCurrency NULL (never a guessed SEK)', async () => {
    const { impl, calls } = fetchReturning(200, SINGLE)
    const info = await new AccountedConnector(impl).getCompanyInfo(SECRETS)
    expect(info).toEqual({
      externalCompanyId: SINGLE.data[0].id,
      name: SINGLE.data[0].name,
      baseCurrency: null,
    })
    // The one company read path: GET /api/v1/companies on the pinned host.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${ACCOUNTED_API_BASE}/api/v1/companies`)
  })

  it('several companies → MultiCompanyKeyError (409 MULTI_COMPANY_KEY at the route)', async () => {
    const { impl } = fetchReturning(200, await fixture('companies-multi.json'))
    const err = await new AccountedConnector(impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MultiCompanyKeyError)
    const multi = err as MultiCompanyKeyError
    expect(multi.code).toBe('MULTI_COMPANY_KEY')
    expect(multi.count).toBe(2)
    // The user answer is in the message: a key scoped to ONE company.
    expect(multi.message).toMatch(/2 companies/)
    expect(multi.message).toMatch(/one company/)
  })

  it('401 (the live envelope) → ProviderError with status 401 — what the flow maps to InvalidApiKeyError', async () => {
    const { impl } = fetchReturning(401, await fixture('error-401.json'))
    const err = await new AccountedConnector(impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).status).toBe(401)
    expect((err as ProviderError).provider).toBe('accounted')
  })

  it('zero companies → a key verdict (401), not a silent connect', async () => {
    const { impl } = fetchReturning(200, { data: [], meta: { request_id: 'req_x', api_version: '2026-05-12' } })
    const err = await new AccountedConnector(impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).status).toBe(401)
  })

  it('auth refusal vs outage: a 403 is a key verdict, a 5xx and a network error are NOT', async () => {
    const refused = await new AccountedConnector(fetchReturning(403, { error: { code: 'INSUFFICIENT_SCOPE' } }).impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(ProviderError)
    expect((refused as ProviderError).status).toBe(403)

    const outage = await new AccountedConnector(fetchReturning(503, { error: { code: 'UNAVAILABLE' } }).impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(outage).toBeInstanceOf(ProviderError)
    expect((outage as ProviderError).status).toBe(503)

    const down = await new AccountedConnector(fetchFailing('ECONNRESET'))
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(down).toBeInstanceOf(ProviderError)
    expect((down as ProviderError).status).toBe(0)
    expect((down as ProviderError).message).toMatch(/Could not reach Accounted/)
  })

  it('wire contract: bearer key + Accept, NO Gnubok-Version header (the spec declares no header params)', async () => {
    const { impl, calls } = fetchReturning(200, SINGLE)
    await new AccountedConnector(impl).getCompanyInfo(SECRETS)
    expect(calls[0].headers.Authorization).toBe(`Bearer ${SECRETS.apiKey}`)
    expect(calls[0].headers.Accept).toBe('application/json')
    expect(Object.keys(calls[0].headers)).not.toContain('Gnubok-Version')
  })

  it('no error message ever carries the key', async () => {
    const cases: Promise<unknown>[] = [
      new AccountedConnector(fetchReturning(401, await fixture('error-401.json')).impl)
        .getCompanyInfo(SECRETS)
        .catch((e: unknown) => e),
      new AccountedConnector(fetchReturning(503, { error: { code: 'UNAVAILABLE' } }).impl)
        .getCompanyInfo(SECRETS)
        .catch((e: unknown) => e),
      new AccountedConnector(fetchFailing('ECONNRESET'))
        .getCompanyInfo(SECRETS)
        .catch((e: unknown) => e),
    ]
    for (const err of await Promise.all(cases)) {
      expect((err as Error).message).not.toContain(SECRETS.apiKey)
    }
  })
})
