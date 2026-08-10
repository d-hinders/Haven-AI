import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHavenIdentity, fetchX402SignContext } from './sign-context.js'

const IDENTITY = { api_key: 'sk_agent_test_1263', api_url: 'https://haven.test/' }

describe('loadHavenIdentity (#1263)', () => {
  it('reads identity.json next to the signer credential file and strips trailing slash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-sign-ctx-'))
    try {
      await writeFile(join(dir, 'identity.json'), JSON.stringify(IDENTITY))
      const identity = await loadHavenIdentity(join(dir, 'signer.json'))
      expect(identity).toEqual({ apiKey: 'sk_agent_test_1263', apiUrl: 'https://haven.test' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null — never throws — for missing/partial identity or no path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-sign-ctx-'))
    try {
      expect(await loadHavenIdentity(undefined)).toBeNull()
      expect(await loadHavenIdentity(join(dir, 'signer.json'))).toBeNull()
      await writeFile(join(dir, 'identity.json'), JSON.stringify({ api_key: 'sk_x' }))
      expect(await loadHavenIdentity(join(dir, 'signer.json'))).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('fetchX402SignContext (#1263)', () => {
  const identity = { apiKey: 'sk_agent_test_1263', apiUrl: 'https://haven.test' }

  it('GETs the sign-context with the bearer credential and returns the exact payload', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url)
      seenAuth = (init?.headers as Record<string, string>).Authorization
      return new Response(
        JSON.stringify({
          payment_id: 'pay_1263',
          sign_data: { hash: '0x' + 'ab'.repeat(32), typed_data: { primaryType: 'X' } },
          x402_expected: { payment_id: 'pay_1263' },
        }),
        { status: 200 },
      )
    }) as typeof fetch
    const ctx = await fetchX402SignContext(identity, 'pay_1263', fetchImpl)
    expect(seenUrl).toBe('https://haven.test/x402/pay_1263/sign-context')
    expect(seenAuth).toBe('Bearer sk_agent_test_1263')
    expect(ctx.payloadHash).toBe('0x' + 'ab'.repeat(32))
    expect(ctx.typedData).toEqual({ primaryType: 'X' })
  })

  it('maps a 410 to an error naming the re-quote step', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'Payment window expired' }), { status: 410 })) as typeof fetch
    await expect(fetchX402SignContext(identity, 'pay_x', fetchImpl)).rejects.toThrow(
      /expired.*idempotency key/is,
    )
  })

  it('refuses a response missing the signing payload, naming the fallback', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ payment_id: 'pay_x' }), { status: 200 })) as typeof fetch
    await expect(fetchX402SignContext(identity, 'pay_x', fetchImpl)).rejects.toThrow(
      /typed_data_b64/,
    )
  })
})
