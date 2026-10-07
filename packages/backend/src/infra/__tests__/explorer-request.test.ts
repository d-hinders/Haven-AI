/**
 * Explorer request plumbing: every request identifies itself, Blockscout v2
 * carries the configured key on every cursor hop, and a refused request's
 * error names what the explorer said — prod Base history reads failed with
 * a bare "403" that could not be told apart from a missing key or an edge
 * block.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>()
  return { config: { ...actual.config, blockscoutApiKey: 'bs-test-key' } }
})

import { EXPLORER_ERROR_BODY_MAX, fetchNormalTransactions } from '../explorer-api.js'

const ACCOUNT = '0x135a9215604711AC70d970e12Caa812c53537EF4'

function okPage(next: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ items: [], next_page_params: next }),
  } as Response)
}

function refused(status: number, body: string) {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  } as Response)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('explorer request plumbing (Blockscout v2, chain 8453)', () => {
  it('sends a User-Agent and the apikey on every cursor hop', async () => {
    const fetchMock = vi.fn((input: string | URL, _init?: RequestInit) =>
      String(input).includes('block_number=') ? okPage(null) : okPage({ block_number: 5, index: 0 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await fetchNormalTransactions(8453, ACCOUNT)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchMock.mock.calls) {
      expect(new URL(String(input)).searchParams.get('apikey')).toBe('bs-test-key')
      const headers = init?.headers as Record<string, string>
      expect(headers['User-Agent']).toMatch(/^Haven-Backend\//)
    }
  })

  it("puts a single-line excerpt of the refusal body in the error", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => refused(403, '<html>\n  <title>Attention Required! | Cloudflare</title>\n</html>')),
    )

    await expect(fetchNormalTransactions(8453, ACCOUNT)).rejects.toThrow(
      'Blockscout v2 error (chain 8453): 403 — <html> <title>Attention Required! | Cloudflare</title> </html>',
    )
  })

  it('caps the excerpt at EXPLORER_ERROR_BODY_MAX characters', async () => {
    vi.stubGlobal('fetch', vi.fn(() => refused(403, 'x'.repeat(EXPLORER_ERROR_BODY_MAX + 50))))

    const err = (await fetchNormalTransactions(8453, ACCOUNT).catch((e: unknown) => e)) as Error
    expect(err.message).toBe(`Blockscout v2 error (chain 8453): 403 — ${'x'.repeat(EXPLORER_ERROR_BODY_MAX)}…`)
  })

  it('keeps the bare status when the body cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 403 } as Response)))

    await expect(fetchNormalTransactions(8453, ACCOUNT)).rejects.toThrow(/^Blockscout v2 error \(chain 8453\): 403$/)
  })
})
