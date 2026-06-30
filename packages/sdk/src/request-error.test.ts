import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'

const baseUrl = 'https://haven.example'
const haven = () => new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

function errorResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status })
}

// getAgent() goes through the shared request() path, so it exercises the error
// message construction for any non-ok response.
describe('request() surfaces backend `details` in the error message (#684)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('combines the generic error with the backend details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      errorResponse(502, {
        success: false,
        error: 'On-chain execution failed',
        details: 'transfer amount exceeds allowance',
      }),
    )
    await expect(haven().getAgent()).rejects.toThrow(
      'On-chain execution failed: transfer amount exceeds allowance',
    )
  })

  it('falls back to the error alone when there are no details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      errorResponse(400, { error: 'Bad request' }),
    )
    await expect(haven().getAgent()).rejects.toThrow('Bad request')
  })

  it('stringifies object-shaped details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      errorResponse(422, { error: 'Validation failed', details: { field: 'amount' } }),
    )
    await expect(haven().getAgent()).rejects.toThrow('Validation failed: {"field":"amount"}')
  })
})
