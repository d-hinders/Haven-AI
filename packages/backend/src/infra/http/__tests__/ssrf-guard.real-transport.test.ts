/**
 * Real-transport SSRF guard tests (#3741).
 *
 * `ssrf-guard.test.ts` injects a fake `transport` into every `safeGetText` /
 * `safePostJson` call, so none of the controls that live on the actual socket
 * was ever executed: not the `lookup`-hook connection pinning, not the byte
 * cap, not the deadline. The two "coverage" tests there assert a value passed
 * TO a fake, which a broken transport passes just as eagerly.
 *
 * This file runs the exported real `httpsTransport` against local TLS servers
 * on the loopback, so each control is observed through the socket it governs:
 *
 *   - a server that DRIPS the body (the socket is never idle) is cut off by
 *     the wall-clock deadline, measured with Date.now() in the test — the
 *     pre-#3741 transport hung here forever, because its only deadline was
 *     the socket IDLE timeout;
 *   - a server that overshoots the byte cap is refused and the connection is
 *     torn down at the cap, proven by how few of the intended chunks the
 *     server managed to write;
 *   - a request whose URL names an unresolvable host still lands on the
 *     checked address — the `lookup` hook is what connects, and the server
 *     confirms the peer address from its own side.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import net from 'node:net'
import type { RequestListener } from 'node:http'

import { DEFAULT_MAX_BYTES, httpsTransport, type PinnedRequest } from '../ssrf-guard.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TLS_OPTIONS = {
  key: readFileSync(path.join(FIXTURES, 'ssrf-guard-local-tls-key.pem')),
  cert: readFileSync(path.join(FIXTURES, 'ssrf-guard-local-tls-cert.pem')),
}

/** A local https server whose sockets are force-closed on `close()` — a lingering drip interval must never hang the worker. */
interface LocalServer {
  port: number
  close(): Promise<void>
}

async function listenTls(handler: RequestListener): Promise<LocalServer> {
  const server = https.createServer(TLS_OPTIONS, handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function pinnedRequest(overrides: Partial<PinnedRequest> & { url: URL }): PinnedRequest {
  return {
    address: '127.0.0.1',
    family: 4,
    timeoutMs: 1_000,
    maxBytes: DEFAULT_MAX_BYTES,
    method: 'GET',
    body: null,
    headers: {},
    ...overrides,
  }
}

// The transport builds its request from `PinnedRequest` alone — there is no
// seam to hand it a CA bundle — so the loopback connections in this file trust
// the fixture's self-signed cert the standard way. The prior value is
// restored so nothing leaks into other files on the same worker.
const priorTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED

beforeAll(() => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
})

afterAll(() => {
  if (priorTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTlsReject
})

describe('httpsTransport against a real local server (#3741)', () => {
  it('completes a real round trip — the positive control for everything below', async () => {
    const server = await listenTls((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-proof': 'yes' })
      res.end('pinned')
    })
    const result = await httpsTransport(
      pinnedRequest({ url: new URL(`https://real-transport.test:${server.port}/x`) }),
    )
    await server.close()
    // A success is the bare PinnedResponse — only refusals carry `ok: false`.
    expect(result).toMatchObject({ status: 200, body: 'pinned' })
    expect('ok' in result && result.ok === false).toBe(false)
    expect((result as { headers: Record<string, string> }).headers['x-proof']).toBe('yes')
  })

  it('refuses a body that drips slower than the deadline with `timeout`, within the deadline plus a small tolerance', async () => {
    // The socket is NEVER idle 400ms — a byte lands every 50ms — so the
    // `timeout:` option passed to https.request (the pre-#3741 "deadline")
    // can never fire. Only the wall-clock total deadline ends this request,
    // and the measured elapsed time is the assertion.
    const deadlineMs = 400
    const server = await listenTls((req, res) => {
      res.writeHead(200)
      res.write('x')
      const drip = setInterval(() => res.write('x'), 50)
      res.on('close', () => clearInterval(drip))
    })
    const started = Date.now()
    const result = await httpsTransport(
      pinnedRequest({ url: new URL(`https://drip.test:${server.port}/x`), timeoutMs: deadlineMs }),
    )
    const elapsed = Date.now() - started
    await server.close()
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect((result as { detail: string }).detail).toContain('total budget')
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 50)
    expect(elapsed).toBeLessThan(deadlineMs + 250)
  })

  it('refuses a body over the byte cap with `response_too_large`, and the read stops at the cap', async () => {
    const CHUNK_BYTES = 256
    const TOTAL_CHUNKS = 512 // 128 KiB intended against a 1 KiB cap.
    let chunksWritten = 0
    const server = await listenTls((req, res) => {
      res.writeHead(200)
      res.write(Buffer.alloc(CHUNK_BYTES, 0x61))
      chunksWritten = 1
      // Drip the rest — if the client kept reading, this would run for
      // ~5 seconds; the assertion below proves it did not.
      const drip = setInterval(() => {
        if (chunksWritten >= TOTAL_CHUNKS) {
          clearInterval(drip)
          return
        }
        res.write(Buffer.alloc(CHUNK_BYTES, 0x61))
        chunksWritten += 1
      }, 10)
      // The client tears the socket down at the cap; the interval stops with
      // it. A few extra chunks may land in kernel buffers before the reset
      // arrives, so the bound is slack — but it must stay near the cap and
      // far below everything the server intended to send.
      res.on('close', () => clearInterval(drip))
    })
    const started = Date.now()
    const result = await httpsTransport(
      pinnedRequest({ url: new URL(`https://firehose.test:${server.port}/x`), timeoutMs: 5_000, maxBytes: 1_024 }),
    )
    const elapsed = Date.now() - started
    await server.close()
    expect(result).toMatchObject({ ok: false, reason: 'response_too_large' })
    expect((result as { detail: string }).detail).toContain('1024')
    // The refusal arrives long before the full body would have been sent —
    // the read stopped at the cap rather than buffering its way through it.
    expect(elapsed).toBeLessThan((TOTAL_CHUNKS * CHUNK_BYTES * 10) / 1_000)
    expect(chunksWritten).toBeLessThan(32)
    expect(chunksWritten).toBeLessThan(TOTAL_CHUNKS)
  })

  it('connects to the CHECKED address through the lookup hook — the hostname is never resolved', async () => {
    // `ssrf-pinning-probe.invalid` resolves to nothing anywhere: if the
    // transport ever consulted real DNS for the connect, this would refuse
    // with ENOTFOUND instead of proving the pin. That is the resolution-time /
    // connect-time split the hook exists to close — a resolver that answers
    // one address to the check and another to the connect cannot win here,
    // because the connect goes to the address the check validated.
    let peerAddress: string | null = null
    const server = await listenTls((req, res) => {
      peerAddress = req.socket.remoteAddress ?? null
      res.writeHead(200)
      res.end('pinned')
    })
    const result = await httpsTransport(
      pinnedRequest({ url: new URL(`https://ssrf-pinning-probe.invalid:${server.port}/x`) }),
    )
    await server.close()
    expect(result).toMatchObject({ status: 200, body: 'pinned' })
    expect('ok' in result && result.ok === false).toBe(false)
    expect(peerAddress).toBe('127.0.0.1')
  })

  it('aborts at the total deadline when the connection never completes — connect time is inside the budget', async () => {
    // A raw TCP listener that accepts and never speaks TLS: the request can
    // neither succeed nor fail on its own, so only the wall clock can end it.
    // This pins the timer to BEFORE the connect — a deadline armed at first
    // response byte would let a black-holed connect hang forever.
    const deadlineMs = 400
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const started = Date.now()
    const result = await httpsTransport(
      pinnedRequest({ url: new URL(`https://blackhole.test:${port}/x`), timeoutMs: deadlineMs }),
    )
    const elapsed = Date.now() - started
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 50)
    expect(elapsed).toBeLessThan(deadlineMs + 250)
  })
})
