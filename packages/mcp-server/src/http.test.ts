import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createHostedHttpServer } from './http.js'

let server: Server | null = null
let baseUrl = ''

async function start(): Promise<void> {
  server = createHostedHttpServer({ logger: () => {} })
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server!.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
}

beforeEach(start)

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
})

describe('hosted HTTP server — CORS', () => {
  // The Haven dashboard probes tools/list from the browser as a connect
  // sanity check. Without CORS headers the browser blocks the response and
  // a working bearer looks indistinguishable from a broken one.

  it('responds to OPTIONS preflight with 204 and Access-Control headers', async () => {
    const res = await fetch(`${baseUrl}/v1`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.haven.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/)
    const allowed = res.headers.get('access-control-allow-headers') ?? ''
    expect(allowed.toLowerCase()).toContain('authorization')
    expect(allowed.toLowerCase()).toContain('content-type')
  })

  it('includes Access-Control-Allow-Origin on the 401 from a missing bearer', async () => {
    // Browser-side test-connection probes without a token should still expose
    // the auth-error JSON so the dashboard can render "Token rejected" rather
    // than a generic CORS failure.
    const res = await fetch(`${baseUrl}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.haven.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('returns 204 with CORS headers even on an unknown path', async () => {
    const res = await fetch(`${baseUrl}/nope`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.haven.example' },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
