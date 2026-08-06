import { describe, expect, it, vi } from 'vitest'
import { probeCatalogEntry, refreshCatalog, type CatalogRow } from '../merchant-catalog.js'

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

const X402_ENTRY = {
  resource_url: 'https://api.merchant.example/paid',
  protocol: 'http' as const,
  tool_name: null,
  rail: 'x402' as const,
}

const MCP_ENTRY = {
  resource_url: 'https://mcp.merchant.example/mcp',
  protocol: 'mcp' as const,
  tool_name: 'create_text',
  rail: 'x402' as const,
}

const MPP_ENTRY = {
  resource_url: 'https://api.merchant.example/mpp',
  protocol: 'http' as const,
  tool_name: null,
  rail: 'mpp' as const,
}

const X402_BODY = {
  x402Version: 2,
  accepts: [{
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '20000',
    payTo: '0x' + '11'.repeat(20),
    maxTimeoutSeconds: 300,
  }],
}

describe('probeCatalogEntry', () => {
  it('verifies an x402 merchant from the PAYMENT-REQUIRED header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': b64(X402_BODY) },
    }))

    const result = await probeCatalogEntry(X402_ENTRY, fetchMock as typeof fetch)
    expect(result).toEqual({
      ok: true,
      priceAtomic: '20000',
      priceDisplay: '$0.02 USDC',
      asset: 'USDC',
      network: 'eip155:8453',
      // A plain merchant omits assetTransferMethod → EIP-3009 by the exact-EVM default.
      assetTransferMethods: ['eip3009'],
    })
    expect(fetchMock).toHaveBeenCalledWith(X402_ENTRY.resource_url, { method: 'GET' })
  })

  it('verifies an x402 merchant from a JSON 402 body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(X402_BODY), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await probeCatalogEntry(X402_ENTRY, fetchMock as typeof fetch)
    expect(result.ok).toBe(true)
    expect(result.priceAtomic).toBe('20000')
  })

  it('captures erc7710 alongside eip3009 when the merchant advertises both', async () => {
    // Merchants keep the EIP-3009 option first for compatibility and add the
    // ERC-7710 option second, so the probe must scan every accepts[] entry.
    const body = {
      x402Version: 2,
      accepts: [
        { ...X402_BODY.accepts[0] },
        { ...X402_BODY.accepts[0], extra: { assetTransferMethod: 'erc7710' } },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': b64(body) },
    }))

    const result = await probeCatalogEntry(X402_ENTRY, fetchMock as typeof fetch)
    expect(result.assetTransferMethods).toEqual(['eip3009', 'erc7710'])
  })

  it('captures a single erc7710-only accepts option', async () => {
    const body = {
      x402Version: 2,
      accepts: [{ ...X402_BODY.accepts[0], extra: { assetTransferMethod: 'erc7710' } }],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': b64(body) },
    }))

    const result = await probeCatalogEntry(X402_ENTRY, fetchMock as typeof fetch)
    expect(result.assetTransferMethods).toEqual(['erc7710'])
  })

  it('does not report transfer methods for an MPP merchant', async () => {
    const challenge = {
      amount: { display: '0.01', atomic: '10000' },
      asset: { symbol: 'USDC' },
      network: { chainId: 8453 },
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 402,
      headers: { 'MACHINE-PAYMENT-CHALLENGE': b64(challenge) },
    }))

    const result = await probeCatalogEntry(MPP_ENTRY, fetchMock as typeof fetch)
    expect(result.ok).toBe(true)
    expect(result.assetTransferMethods).toBeUndefined()
  })

  it('probes MCP merchants with a tools/call envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(X402_BODY), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await probeCatalogEntry(MCP_ENTRY, fetchMock as typeof fetch)
    expect(result.ok).toBe(true)

    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ method: 'tools/call', params: { name: 'create_text' } })
  })

  it('verifies an MPP merchant from the MACHINE-PAYMENT-CHALLENGE header', async () => {
    const challenge = {
      amount: { display: '0.01', atomic: '10000' },
      asset: { symbol: 'USDC' },
      network: { chainId: 8453 },
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 402,
      headers: { 'MACHINE-PAYMENT-CHALLENGE': b64(challenge) },
    }))

    const result = await probeCatalogEntry(MPP_ENTRY, fetchMock as typeof fetch)
    expect(result).toEqual({
      ok: true,
      priceAtomic: '10000',
      priceDisplay: '$0.01 USDC',
      asset: 'USDC',
      network: 'eip155:8453',
    })
  })

  it('fails when the merchant does not answer 402', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    expect((await probeCatalogEntry(X402_ENTRY, fetchMock as typeof fetch)).ok).toBe(false)
  })

  it('fails when the challenge is unparsable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not json', { status: 402 }))
    expect((await probeCatalogEntry(X402_ENTRY, fetchMock as typeof fetch)).ok).toBe(false)
  })

  it('fails on network errors without throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await probeCatalogEntry(X402_ENTRY, fetchMock as typeof fetch)).ok).toBe(false)
  })
})

describe('refreshCatalog', () => {
  function rowFor(overrides: Partial<CatalogRow>): CatalogRow {
    return {
      id: 'cat-1',
      name: 'n', description: 'd', category: 'c',
      resource_url: 'https://api.merchant.example/paid',
      rail: 'x402', protocol: 'http', tool_name: null,
      price_display: null, price_atomic: null, asset: null, network: null,
      asset_transfer_methods: null,
      status: 'active', verified_at: null, consecutive_failures: 0,
      created_at: '', updated_at: '',
      ...overrides,
    }
  }

  it('refreshes reachable entries and clears their failure streak', async () => {
    const queries: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push([sql, values])
        if (sql.startsWith('SELECT')) {
          return { rows: [rowFor({ id: 'cat-live', consecutive_failures: 2 })] }
        }
        return { rows: [] }
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(X402_BODY) } }),
    )

    const result = await refreshCatalog(db, fetchMock as typeof fetch)
    expect(result).toEqual({ verified: 1, degraded: 0 })

    const liveUpdate = queries.find(([sql, v]) => sql.includes(`status = 'active'`) && v?.[0] === 'cat-live')
    expect(liveUpdate?.[0]).toContain('consecutive_failures = 0')
    expect(liveUpdate?.[0]).toContain('asset_transfer_methods = COALESCE($6, asset_transfer_methods)')
    expect(liveUpdate?.[1]).toEqual(['cat-live', '20000', '$0.02 USDC', 'USDC', 'eip155:8453', 'eip3009'])
  })

  it('does not degrade an entry on a single transient miss (hysteresis)', async () => {
    const queries: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push([sql, values])
        if (sql.startsWith('SELECT')) {
          return { rows: [rowFor({ id: 'cat-dead', resource_url: 'https://dead.example/x' })] }
        }
        return { rows: [] }
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }))

    const result = await refreshCatalog(db, fetchMock as typeof fetch)
    // First miss: counted but still active — no spurious warning.
    expect(result).toEqual({ verified: 0, degraded: 0 })
    const update = queries.find(([sql, v]) => v?.[0] === 'cat-dead')
    expect(update?.[1]).toEqual(['cat-dead', 1, 'active'])
  })

  it('degrades only after the failure streak crosses the threshold', async () => {
    const queries: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push([sql, values])
        if (sql.startsWith('SELECT')) {
          // Already missed twice; this run is the third consecutive miss.
          return { rows: [rowFor({ id: 'cat-dead', resource_url: 'https://dead.example/x', consecutive_failures: 2 })] }
        }
        return { rows: [] }
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }))

    const result = await refreshCatalog(db, fetchMock as typeof fetch)
    expect(result).toEqual({ verified: 0, degraded: 1 })
    const update = queries.find(([sql, v]) => v?.[0] === 'cat-dead')
    expect(update?.[1]).toEqual(['cat-dead', 3, 'degraded'])
  })

  it('skips delisted entries entirely', async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.startsWith('SELECT')) {
          expect(sql).toContain(`status != 'delisted'`)
          return { rows: [] }
        }
        throw new Error('no updates expected')
      },
    }
    const result = await refreshCatalog(db, vi.fn() as unknown as typeof fetch)
    expect(result).toEqual({ verified: 0, degraded: 0 })
  })
})
