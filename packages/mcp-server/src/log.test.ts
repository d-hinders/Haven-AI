import { describe, it, expect, vi } from 'vitest'
import {
  createHostedHttpServer,
  type AccessLogEntry,
  deriveToolName,
} from './index.js'

describe('deriveToolName', () => {
  it('returns the tool name from a tools/call envelope', () => {
    expect(
      deriveToolName({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'haven_pay', arguments: { token: 'USDC' } },
      }),
    ).toBe('haven_pay')
  })

  it('returns undefined for handshake / list / other methods', () => {
    expect(deriveToolName({ method: 'tools/list' })).toBeUndefined()
    expect(deriveToolName({ method: 'initialize' })).toBeUndefined()
  })

  it('returns undefined for malformed bodies', () => {
    expect(deriveToolName(undefined)).toBeUndefined()
    expect(deriveToolName(null)).toBeUndefined()
    expect(deriveToolName('not-json')).toBeUndefined()
    expect(deriveToolName({ method: 'tools/call', params: {} })).toBeUndefined()
    expect(deriveToolName({ method: 'tools/call', params: { name: 42 } })).toBeUndefined()
  })
})

describe('access logging', () => {
  it('emits a structured entry per request without leaking the Authorization header', async () => {
    const entries: AccessLogEntry[] = []
    const logger = (e: AccessLogEntry): void => {
      entries.push(e)
    }

    const server = createHostedHttpServer({ logger })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port

    const SECRET = 'sk_agent_secret_must_not_leak'

    // 401 path: no Authorization → we should still get an access-log line, and
    // the header value (any token) must never appear in any logged entry.
    await fetch(`http://127.0.0.1:${port}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    await new Promise<void>((resolve) => server.close(() => resolve()))

    expect(entries.length).toBeGreaterThanOrEqual(1)
    const entry = entries[entries.length - 1]
    expect(entry.method).toBe('POST')
    expect(entry.path).toBe('/v1')
    expect(typeof entry.status).toBe('number')
    expect(typeof entry.ms).toBe('number')
    // Strongest custody check: the secret never appears anywhere in the log.
    expect(JSON.stringify(entries)).not.toContain(SECRET)
    expect(JSON.stringify(entries)).not.toContain('Authorization')
  })

  it('responds 200 to HEAD /healthz so uptime monitors and CDNs are happy', async () => {
    const server = createHostedHttpServer({ logger: () => {} })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port

    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'HEAD' })
    expect(res.status).toBe(200)

    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('attributes a tools/call entry to its tool name', async () => {
    const entries: AccessLogEntry[] = []
    const logger = vi.fn((e: AccessLogEntry) => {
      entries.push(e)
    })

    const server = createHostedHttpServer({ logger })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port

    await fetch(`http://127.0.0.1:${port}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk_agent_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'haven_pay', arguments: {} },
      }),
    })

    await new Promise<void>((resolve) => server.close(() => resolve()))

    // The call will fail downstream (no real backend), but the log line is
    // still attributed to the right tool name by metadata alone.
    const callEntries = entries.filter((e) => e.path === '/v1')
    expect(callEntries.some((e) => e.tool === 'haven_pay')).toBe(true)
  })
})
