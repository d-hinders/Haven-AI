import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchUnsignedTaxDeclaration,
  resolveTaxDeclarationHeader,
  X_TAX_DECLARATION_HEADER,
  withTaxDeclarationHeader,
} from './client-tax-declaration.js'
import { verifyTaxDeclarationSignature } from './tax-declaration.js'
import { addressFromKey } from './edge-signing.js'
import { HavenApiError } from './types.js'
import type { X402PaymentOption } from './types.js'

// Throwaway well-known key (Hardhat account #0). Never a real key.
const DELEGATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const eip3009Option: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
}

const erc7710Option: X402PaymentOption = {
  ...eip3009Option,
  extra: { assetTransferMethod: 'erc7710' },
}

const declaration = {
  version: 'x402-tax-1',
  jurisdiction: 'DE',
  taxableStatus: 'TAXABLE_PERSON',
  taxId: 'DE123456789',
  validUntil: 1790912400000,
}

/** A client stub over an in-memory route table — no HTTP. */
function stubClient(routes: Record<string, unknown>) {
  return {
    getAgent: async () => ({ id: 'agent_1' }),
    get: async <T>(path: string): Promise<T> => {
      if (path in routes) return routes[path] as T
      throw new HavenApiError(`no route ${path}`, 404)
    },
  }
}

describe('fetchUnsignedTaxDeclaration (#3427)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the agent id, then the agent-key content endpoint', async () => {
    const client = stubClient({
      '/agents/agent_1/tax-declaration': { available: true, declaration },
    })
    const result = await fetchUnsignedTaxDeclaration(client)
    expect(result).toEqual({ available: true, declaration })
  })

  it('maps every closed unavailability reason through', async () => {
    for (const reason of ['feature_disabled', 'disabled', 'no_company_details', 'vies_not_valid'] as const) {
      const client = stubClient({
        '/agents/agent_1/tax-declaration': { available: false, reason },
      })
      expect(await fetchUnsignedTaxDeclaration(client)).toEqual({ available: false, reason })
    }
  })

  it('an off-contract body throws rather than being guessed into a declaration', async () => {
    const client = stubClient({
      '/agents/agent_1/tax-declaration': { hello: true },
    })
    await expect(fetchUnsignedTaxDeclaration(client)).rejects.toThrow(HavenApiError)
  })
})

describe('resolveTaxDeclarationHeader (#3427)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('signs the available content through the edge builder and returns the header value', async () => {
    const client = stubClient({
      '/agents/agent_1/tax-declaration': { available: true, declaration },
    })
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const resolved = await resolveTaxDeclarationHeader(client, {
      accepted: eip3009Option,
      delegateKey: DELEGATE_KEY,
    })
    if (resolved.header === undefined) throw new Error('expected a header')
    const decoded = JSON.parse(Buffer.from(resolved.header, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(decoded.version).toBe(declaration.version)
    expect(decoded.taxId).toBe(declaration.taxId)
    expect(decoded.principalId).toBe(`did:pkh:eip155:8453:${DELEGATE_ADDRESS}`)
    expect(typeof decoded.signature).toBe('string')
    // The decoded signature recovers to the delegate EOA (the §2.2 rule).
    const { signature, principalId, principalAttributionHash, ...rest } = decoded as never as Record<string, string>
    expect(
      verifyTaxDeclarationSignature(
        { ...rest, principalId, principalAttributionHash } as never,
        signature,
        DELEGATE_ADDRESS,
      ),
    ).toBe(true)
    // The audit trail logs the taxId being signed (threat-model residual).
    const logged = stderr.mock.calls.map((c) => String(c[0])).join('')
    expect(logged).toContain('DE123456789')
  })

  it('an erc7710 accepted option returns no header WITHOUT touching the endpoint', async () => {
    const get = vi.fn(async () => {
      throw new Error('endpoint must not be read on erc7710')
    })
    const resolved = await resolveTaxDeclarationHeader(
      { getAgent: async () => ({ id: 'agent_1' }), get },
      { accepted: erc7710Option, delegateKey: DELEGATE_KEY },
    )
    expect(resolved.header).toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  })

  it('the endpoint answering "not available" proceeds without the header', async () => {
    const client = stubClient({
      '/agents/agent_1/tax-declaration': { available: false, reason: 'disabled' },
    })
    const resolved = await resolveTaxDeclarationHeader(client, {
      accepted: eip3009Option,
      delegateKey: DELEGATE_KEY,
    })
    expect(resolved.header).toBeUndefined()
  })

  it('a 404 from the content endpoint (older backend) proceeds without the header', async () => {
    const client = stubClient({}) // no route → 404
    const resolved = await resolveTaxDeclarationHeader(client, {
      accepted: eip3009Option,
      delegateKey: DELEGATE_KEY,
    })
    expect(resolved.header).toBeUndefined()
  })

  it('a network failure on the content endpoint proceeds without the header too', async () => {
    const resolved = await resolveTaxDeclarationHeader(
      {
        getAgent: async () => {
          throw new Error('haven down')
        },
        get: async () => {
          throw new Error('unreachable')
        },
      },
      { accepted: eip3009Option, delegateKey: DELEGATE_KEY },
    )
    expect(resolved.header).toBeUndefined()
  })
})

describe('withTaxDeclarationHeader — the attach site', () => {
  it('sets the X-Tax-Declaration header on the init', () => {
    const init = withTaxDeclarationHeader({ method: 'POST' }, 'abc.def')
    expect(new Headers(init.headers).get('X-Tax-Declaration')).toBe('abc.def')
    expect(init.method).toBe('POST')
  })

  it('leaves an init without headers undefined-shaped and deletes a stale value', () => {
    expect(withTaxDeclarationHeader(undefined, undefined)).toEqual({})
    const stale = withTaxDeclarationHeader(
      { headers: { [X_TAX_DECLARATION_HEADER]: 'stale' } },
      undefined,
    )
    expect(new Headers(stale.headers).has(X_TAX_DECLARATION_HEADER)).toBe(false)
  })
})
