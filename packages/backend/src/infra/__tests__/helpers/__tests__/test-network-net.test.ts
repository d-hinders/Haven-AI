/**
 * The backend test network net (#4217) — its policy, each interception point,
 * and the hook that turns a swallowed dial into a red.
 *
 * Every probe below that the net must refuse dials a PUBLIC host on port 443.
 * The port is deliberate: `fetch` refuses its own bad-port list (`:1`, …)
 * before a socket exists, which would read as "refused" with the net removed —
 * a false pass. Each refusal is drained by the test that caused it
 * (`takeRefusals`), so the net's own `afterEach` stays green; the one test
 * that leaves its refusal in place does so on purpose, under `it.fails`.
 *
 * With the net removed, the refusal probes reach the real network and their
 * `takeRefusals()` assertions go red — that is the mutation this file is
 * meant to fail under.
 */
import dns from 'node:dns'
import { lookup as namedLookup } from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveProbeRpcUrl } from '../../../../rails/__tests__/helpers/enforcer-probe.js'
import {
  databaseHost,
  formatRefusals,
  installTestNetworkNet,
  isExemptDial,
  isLocalAddress,
  isLoopbackName,
  isReservedName,
  isTestNetworkNetInstalled,
  kitAnalyticsMayPost,
  NET_EXEMPTIONS,
  takeRefusals,
  TestNetworkRefusalError,
} from '../test-network-net.js'

const THIS_FILE = 'src/infra/__tests__/helpers/__tests__/test-network-net.test.ts'
const CONTRACT_FILE = 'src/routes/__tests__/non-custody-onchain-enforcer.contract.test.ts'
const ANALYTICS_HOST = 'mm-sdk-analytics.api.cx.metamask.io'

/** Await a socket's first `connect` or `error`, whichever comes first. */
function settle(socket: net.Socket): Promise<'connected' | Error> {
  return new Promise((resolve) => {
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', (err) => resolve(err))
  })
}

function httpsGet(url: string): Promise<'ok' | Error> {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      res.resume()
      resolve('ok')
    })
    req.on('error', (err) => resolve(err))
  })
}

async function listenLocal(host: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => res.end('local'))
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('policy (pure)', () => {
  it('admits loopback and unspecified addresses only — not private, link-local or CGNAT', () => {
    const local = ['127.0.0.1', '127.8.9.10', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]', '0.0.0.0', '::']
    const remote = ['8.8.8.8', '1.1.1.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', 'fe80::1', 'fc00::1', '::ffff:8.8.8.8', '2606:4700::1111', 'localhost', 'example.com']
    expect(local.filter((a) => !isLocalAddress(a))).toEqual([])
    expect(remote.filter((a) => isLocalAddress(a))).toEqual([])
  })

  it('names: reserved TLDs never resolve, *.localhost is loopback, example.com is neither', () => {
    expect(['merchant.test', 'ssrf-probe.invalid', 'shop.example', 'TEST', 'x.test.'].filter((h) => !isReservedName(h))).toEqual([])
    expect(['example.com', 'stuck.example.com', 'testing.dev', 'api.coingecko.com'].filter(isReservedName)).toEqual([])
    expect(['localhost', 'app.localhost', 'LOCALHOST.'].filter((h) => !isLoopbackName(h))).toEqual([])
    expect(['localhost.example.com', 'mylocalhost'].filter(isLoopbackName)).toEqual([])
  })

  it('has exactly one exemption: the contract test, scoped to its RPC host', () => {
    expect(NET_EXEMPTIONS.map((e) => e.file)).toEqual([CONTRACT_FILE])
    const rpcHost = new URL(resolveProbeRpcUrl()).hostname
    expect(isExemptDial(CONTRACT_FILE, rpcHost)).toBe(true)
    // Scoped to the host, not the file:
    expect(isExemptDial(CONTRACT_FILE, 'api.coingecko.com')).toBe(false)
    expect(isExemptDial(CONTRACT_FILE, ANALYTICS_HOST)).toBe(false)
    // …and to the file, not the host:
    expect(isExemptDial(THIS_FILE, rpcHost)).toBe(false)
    expect(isExemptDial(null, rpcHost)).toBe(false)
  })

  it('follows an RPC override, so the exempt host is whatever resolveProbeRpcUrl() returns', () => {
    vi.stubEnv('HAVEN_ENFORCER_PROBE_RPC_URL', 'https://base-sepolia.example-rpc.io/v2/KEY')
    try {
      expect(isExemptDial(CONTRACT_FILE, 'base-sepolia.example-rpc.io')).toBe(true)
      expect(isExemptDial(CONTRACT_FILE, 'sepolia.base.org')).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('never exempts the kit analytics host, for any listed file', () => {
    for (const exemption of NET_EXEMPTIONS) {
      expect(exemption.hosts().map((h) => h.toLowerCase())).not.toContain(ANALYTICS_HOST)
    }
  })

  it('mirrors the kit analytics opt-out inputs (CI / DO_NOT_TRACK = 1 | yes | true)', () => {
    expect(kitAnalyticsMayPost({})).toBe(true)
    expect(kitAnalyticsMayPost({ CI: 'true' })).toBe(false)
    expect(kitAnalyticsMayPost({ DO_NOT_TRACK: '1' })).toBe(false)
    expect(kitAnalyticsMayPost({ DO_NOT_TRACK: 'YES' })).toBe(false)
    expect(kitAnalyticsMayPost({ DO_NOT_TRACK: '0', CI: '' })).toBe(true)
    // The suite runs with the kit's opt-out in effect: vitest.setup.ts loads
    // #4216's kit-analytics-off first, which sets DO_NOT_TRACK=1. Asserted
    // with CI removed, because GitHub Actions' CI=true would make this pass
    // with that import deleted.
    expect(kitAnalyticsMayPost({ ...process.env, CI: undefined })).toBe(false)
  })

  it('admits the database host by name, and ignores a Unix-socket directory', () => {
    expect(databaseHost('postgres://haven:haven@localhost:5432/haven')).toBe('localhost')
    expect(databaseHost('postgres://u:p@DB.internal:5432/x?options=-c%20search_path%3Dtest_w1')).toBe('db.internal')
    expect(databaseHost('postgres://u@/x?host=/var/run/postgresql')).toBeNull()
    expect(databaseHost(undefined)).toBeNull()
  })

  it('formats a refusal as host and port only', () => {
    const message = formatRefusals(
      [{ host: 'rpc.example-provider.io', port: 443, via: 'connect', stage: 'name', testFile: THIS_FILE, testName: 'a test' }],
      'test',
    )
    expect(message).toContain('rpc.example-provider.io:443 via connect, in ' + THIS_FILE + ' during "a test"')
    expect(new TestNetworkRefusalError({ host: '::ffff:8.8.8.8', port: 443 }).message).toContain('[::ffff:8.8.8.8]:443')
    expect(new TestNetworkRefusalError({ host: 'x.io', port: 443 }).code).toBe('ECONNREFUSED')
  })
})

describe('interception (live, in this worker)', () => {
  it('is installed by vitest.setup.ts, and a second install is a no-op', () => {
    expect(isTestNetworkNetInstalled()).toBe(true)
    const connect = net.Socket.prototype.connect
    const lookup = dns.lookup
    installTestNetworkNet()
    expect(net.Socket.prototype.connect).toBe(connect)
    expect(dns.lookup).toBe(lookup)
    expect(connect.name).toBe('havenNetConnect')
  })

  it('refuses fetch to a public host on 443, with host and port only in the error', async () => {
    const err = await fetch('https://example.com/v1/secret-path?apikey=SECRET4217').catch((e: unknown) => e)
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(TestNetworkRefusalError)
    const cause = (err as { cause: Error }).cause
    expect(cause.message).toContain('example.com:443')
    expect(cause.message).not.toMatch(/SECRET4217|secret-path/)
    // stage 'name': refused on the hostname before any resolver ran — so the
    // result does not depend on what this machine's DNS answers, and a slow
    // NXDOMAIN (#3969) can never cost a test its timeout.
    expect(takeRefusals()).toMatchObject([
      { host: 'example.com', port: 443, via: 'connect', stage: 'name', testFile: THIS_FILE },
    ])
  })

  it('refuses https.get to a public host on 443', async () => {
    const result = await httpsGet('https://example.com/')
    expect(result).toBeInstanceOf(TestNetworkRefusalError)
    expect(takeRefusals()).toMatchObject([{ host: 'example.com', port: 443, via: 'connect' }])
  })

  it('refuses fetch to a public IP literal on 443 — no lookup happens, so connect itself checks', async () => {
    const err = await fetch('https://1.1.1.1/').catch((e: unknown) => e)
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(TestNetworkRefusalError)
    expect(takeRefusals()).toMatchObject([{ host: '1.1.1.1', port: 443, via: 'connect', stage: 'address' }])
  })

  it('refuses an IPv4-mapped public address and a private one', async () => {
    expect(await settle(net.connect({ host: '::ffff:8.8.8.8', port: 443 }))).toBeInstanceOf(TestNetworkRefusalError)
    expect(await settle(net.connect(443, '192.168.1.1'))).toBeInstanceOf(TestNetworkRefusalError)
    expect(takeRefusals().map((r) => `${r.host}:${r.port}`)).toEqual(['::ffff:8.8.8.8:443', '192.168.1.1:443'])
  })

  it("checks the answer of a caller's own lookup, in both the single and the all:true form", async () => {
    const publicAnswer = (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
      if (opts.all) cb(null, [{ address: '93.184.215.14', family: 4 }])
      else cb(null, '93.184.215.14', 4)
    }
    for (const autoSelectFamily of [true, false]) {
      const socket = net.connect({ host: 'pinned.example', port: 443, lookup: publicAnswer as never, autoSelectFamily })
      expect(await settle(socket)).toBeInstanceOf(TestNetworkRefusalError)
    }
    // A MIXED answer is refused too: one public address in the set is enough,
    // because autoSelectFamily may connect to any of them.
    const mixedAnswer = (_h: string, _opts: unknown, cb: (...a: unknown[]) => void) =>
      cb(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '93.184.215.14', family: 4 },
      ])
    const mixed = net.connect({ host: 'mixed.example', port: 443, lookup: mixedAnswer as never, autoSelectFamily: true })
    expect(await settle(mixed)).toBeInstanceOf(TestNetworkRefusalError)
    expect(takeRefusals()).toMatchObject([
      { host: 'pinned.example', port: 443, stage: 'address' },
      { host: 'pinned.example', port: 443, stage: 'address' },
      { host: 'mixed.example', port: 443, stage: 'address' },
    ])
  })

  it("admits a caller's lookup that pins a loopback address for an unresolvable name (the SSRF guard's shape)", async () => {
    const server = await listenLocal('127.0.0.1')
    try {
      const pinLoopback = (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        if (opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }])
        else cb(null, '127.0.0.1', 4)
      }
      const socket = net.connect({ host: 'ssrf-pinning-probe.invalid', port: server.port, lookup: pinLoopback as never })
      expect(await settle(socket)).toBe('connected')
    } finally {
      await server.close()
    }
    expect(takeRefusals()).toEqual([])
  })

  it('admits loopback by name and by address, IPv4 and IPv6', async () => {
    const server = await listenLocal('::')
    try {
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        const res = await fetch(`http://${host}:${server.port}/`)
        expect(await res.text()).toBe('local')
      }
    } finally {
      await server.close()
    }
    expect(takeRefusals()).toEqual([])
  })

  it('admits a Unix socket', async () => {
    const socketPath = path.join(os.tmpdir(), `net-4217-${process.pid}.sock`)
    fs.rmSync(socketPath, { force: true })
    const server = net.createServer((s) => s.end())
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      expect(await settle(net.connect({ path: socketPath }))).toBe('connected')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(socketPath, { force: true })
    }
    expect(takeRefusals()).toEqual([])
  })

  it('refuses a system-resolver lookup of a public name before any query leaves (#3969: a slow NXDOMAIN opens no socket)', async () => {
    const viaCallback = await new Promise<Error | null>((resolve) => dns.lookup('stuck.example.com', (err) => resolve(err)))
    const viaNamed = await new Promise<Error | null>((resolve) => namedLookup('stuck.example.com', { all: true }, (err) => resolve(err)))
    const viaPromise = await dns.promises.lookup('stuck.example.com').catch((e: unknown) => e)
    for (const err of [viaCallback, viaNamed, viaPromise]) expect(err).toBeInstanceOf(TestNetworkRefusalError)
    expect(takeRefusals().map((r) => r.via)).toEqual(['dns.lookup', 'dns.lookup', 'dns.promises.lookup'])
  })

  it('refuses resolveTxt (c-ares), callback and promise forms', async () => {
    const viaCallback = await new Promise<Error | null>((resolve) => dns.resolveTxt('_haven.example.com', (err) => resolve(err)))
    const viaPromise = await dns.promises.resolveTxt('_haven.example.com').catch((e: unknown) => e)
    for (const err of [viaCallback, viaPromise]) expect(err).toBeInstanceOf(TestNetworkRefusalError)
    expect(takeRefusals().map((r) => r.via)).toEqual(['dns.resolveTxt', 'dns.promises.resolveTxt'])
  })

  it('answers reserved names ENOTFOUND locally, without recording a refusal', async () => {
    const lookupErr = await new Promise<NodeJS.ErrnoException | null>((resolve) => dns.lookup('merchant.example', (err) => resolve(err)))
    expect(lookupErr?.code).toBe('ENOTFOUND')
    const fetchErr = await fetch('https://merchant.test/x').catch((e: unknown) => e)
    expect((fetchErr as { cause?: NodeJS.ErrnoException }).cause?.code).toBe('ENOTFOUND')
    const txtErr = (await dns.promises.resolveTxt('_haven.shop.invalid').catch((e: unknown) => e)) as NodeJS.ErrnoException
    expect(txtErr.code).toBe('ENOTFOUND')
    expect(takeRefusals()).toEqual([])
  })

  it('survives vi.restoreAllMocks() and vi.unstubAllGlobals(), which backend files call routinely', async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    expect(net.Socket.prototype.connect.name).toBe('havenNetConnect')
    expect(await settle(net.connect(443, '8.8.8.8'))).toBeInstanceOf(TestNetworkRefusalError)
    expect(takeRefusals()).toHaveLength(1)
  })
})

describe('a swallowed dial is a red, not a swallow', () => {
  let failure: string[] = []

  // `it.fails` passes only if the test FAILS. The body cannot fail on its own
  // — it swallows the error, the way `recordRefusalFireAndForget` does — so
  // the only thing that can fail it is the net's `afterEach` (vitest flips
  // `fails` after the afterEach hooks have run). Remove the hook and this goes
  // red as "Expect test to fail".
  it.fails('fails the test whose code under test swallowed the connection error', async () => {
    onTestFinished(({ task }) => {
      failure = (task.result?.errors ?? []).map((e) => String(e.message))
    })
    await fetch('https://example.com/v1/secret-path?apikey=SECRET4217').catch(() => undefined)
  })

  it("…and the failure names the host, port and test file — never the URL's path or query", () => {
    expect(failure).toHaveLength(1)
    expect(failure[0]).toContain('example.com:443 via connect')
    expect(failure[0]).toContain(THIS_FILE)
    expect(failure[0]).toContain('fails the test whose code under test swallowed the connection error')
    expect(failure[0]).not.toMatch(/SECRET4217|secret-path/)
  })
})
