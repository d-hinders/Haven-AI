/**
 * With `BLOCKSCOUT_API_KEY` unset the Blockscout v2 reads stay anonymous:
 * no `apikey` param at all (an empty one would be a different request), and
 * nothing is redacted from a refusal's diagnosis.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>()
  return { config: { ...actual.config, blockscoutApiKey: '', alchemyHistoryApiKey: '' } }
})

import { alchemyHistoryEndpoint, fetchNormalTransactions } from '../explorer-api.js'

const ACCOUNT = '0x135a9215604711AC70d970e12Caa812c53537EF4'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('anonymous Blockscout v2 reads (no BLOCKSCOUT_API_KEY)', () => {
  it('stays on Blockscout when ALCHEMY_HISTORY_API_KEY is unset', () => {
    expect(alchemyHistoryEndpoint(8453)).toBeNull()
    expect(alchemyHistoryEndpoint(84532)).toBeNull()
  })

  it('sends no apikey param', async () => {
    const fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [], next_page_params: null }),
      } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    await fetchNormalTransactions(8453, ACCOUNT)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has('apikey')).toBe(false)
  })

  it('leaves the refusal body unredacted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('API key required') } as Response),
      ),
    )

    await expect(fetchNormalTransactions(8453, ACCOUNT)).rejects.toThrow(
      /^Blockscout v2 error \(chain 8453\): 403 — API key required$/,
    )
  })
})
