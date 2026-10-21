/**
 * The backend test suite's network net (#4217, quality scan 2026-10-21 C3).
 *
 * The rule: **a backend test must not dial the real network.** It came from
 * #3963's two `dev` reds (#3969, #3974), where a test reached a live host and
 * ran past vitest's 5000 ms `testTimeout` on the CI runner. Each was fixed at
 * its own site, and nothing enforced the rule afterwards: the scan's recorder
 * found two more files dialing `api.coingecko.com:443`, both green because the
 * price capture degrades to `null` by design. So a net that only REFUSES
 * would not have caught them — this one refuses AND fails the test.
 *
 * The rule, the net and how to add an exemption are documented in
 * `docs/contributing/testing-strategy.md` § *No real network (#4217)*; this
 * header records the mechanism.
 *
 * ## What it intercepts
 *
 * - **`net.Socket.prototype.connect`.** Every TCP client in Node goes through
 *   it: built-in `fetch` (undici's connector calls `net.connect` /
 *   `tls.connect`), `node:http` / `node:https` agents, `pg`, raw `net`. An
 *   IP-literal host never consults a lookup at all, so it is checked here,
 *   directly. A named host gets its lookup WRAPPED — the caller's own `lookup`
 *   option when it brings one (the SSRF guard pins its address that way,
 *   `ssrf-guard.ts`), else the system resolver — and the answer is checked,
 *   including the `all: true` array form `autoSelectFamily` asks for.
 * - **`dns.lookup` and `dns.promises.lookup`.** A slow NXDOMAIN opens no
 *   connection (#3969: the SSRF guard's own resolve step burned its 5 s
 *   deadline before any socket existed), so a connect-only net would never see
 *   it. Lookups of non-local names are refused BEFORE a query leaves.
 * - **`dns.resolveTxt` and `dns.promises.resolveTxt`.** c-ares queries go to
 *   the configured DNS server, not to the getaddrinfo path above; the catalog
 *   ownership proof (`catalog/ownership.ts`) is the one source caller. The rest
 *   of the c-ares `resolve*` family has no source caller and is NOT patched —
 *   add it here when one appears.
 *
 * ## What it allows
 *
 * - **Loopback by RESOLVED ADDRESS** — `127.0.0.0/8`, `::1`, their
 *   IPv4-mapped forms — plus the unspecified `0.0.0.0` / `::`, which the
 *   kernel routes to the local host (a server's `address()` answers `::` when
 *   it listens with no host). Not RFC1918, link-local or CGNAT: those are other
 *   machines. Matching the address, not the name, is what keeps the SSRF
 *   guard's real-transport tests green: their `.test` / `.invalid` hostnames
 *   are answered `127.0.0.1` by the guard's own pinning lookup.
 * - **Unix sockets** (`path` connections) — local by construction.
 * - **The run's database host** (`DATABASE_URL`), admitted by name. CI's is
 *   `localhost`, so this is a no-op there; it exists so a contributor whose
 *   Postgres lives on another host is not refused by their own configuration.
 * - **`NET_EXEMPTIONS`** — named files, each scoped to named hosts.
 *
 * System-resolver lookups of the reserved names `*.test`, `*.invalid` and
 * `*.example` (RFC 2606 / RFC 6761) are answered `ENOTFOUND` locally, not
 * refused: they can never resolve, so the answer is the one real DNS would
 * give, minus the query that can be slow (#3969). `*.localhost` and
 * `localhost` go to the resolver and are then held to the address rule.
 *
 * ## How a refusal becomes a red
 *
 * The connection fails with an `ECONNREFUSED`-coded error, so the code under
 * test takes its ordinary transport-failure branch — and the refusal is
 * RECORDED. Code that swallows the error (`recordRefusalFireAndForget`, a
 * price capture degrading to `null`) cannot hide it: `registerNetHooks()`
 * drains the record in `afterEach` (failing the test that was running) and
 * again in the file-level `afterAll` (failing the file for a dial that landed
 * after its test ended). Messages carry host and port only — never a path or
 * query, because RPC and bundler URLs carry API keys and CI logs are public.
 * The net only ever sees host and port, so that holds by construction.
 *
 * **The late-dial bound.** The file-level `afterAll` first yields for
 * `LATE_DIAL_WAIT_MS` (50 ms), or `KIT_FLUSH_WAIT_MS` (150 ms) when the kit's
 * analytics could post, on a timer that `vi.useFakeTimers()` cannot freeze.
 * A dial the file schedules within that window — a `setTimeout(0)`, a
 * `setImmediate`, a fire-and-forget write a few ticks deep — fails the file.
 * One that fires LATER than the window after the file's last hook is not
 * reliably seen: the file's hooks have all run, and its worker may already be
 * gone. That is the honest limit of a per-file net; a test that schedules
 * work that far out should await it.
 *
 * ## How it is installed
 *
 * Plain property assignment, not `vi.spyOn` / `vi.stubGlobal`: backend files
 * call `vi.restoreAllMocks()` and `vi.unstubAllGlobals()` routinely, and
 * either would quietly take a spy-based net down mid-file. Installation is
 * idempotent — state lives on `globalThis` under one symbol, and a second
 * install (a re-evaluated setup file, a non-isolated pool) is a no-op.
 *
 * Out of reach, by design: child processes (`spawnSync('npx', ['tsx', …])`
 * in `ops-probe-standalone.test.ts`) and `vitest.global-setup.ts`, which runs
 * in the main process before any worker exists. A child vitest
 * (`db-harness-schema-guard.test.ts`) loads `vitest.setup.ts` and is covered.
 * Also unpatched, with no source caller today: a `worker_threads` Worker (its
 * own realm, with its own `net`), UDP (`dgram`), and c-ares queries made
 * through a `new dns.Resolver()` / `new dns.promises.Resolver()` instance
 * rather than the module functions. Add them here when one appears.
 */
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseConnectionString } from 'pg-connection-string'
import { afterAll, afterEach, beforeEach, expect } from 'vitest'
import { resolveProbeRpcUrl } from '../../../rails/__tests__/helpers/enforcer-probe.js'

/** The backend package root — test paths in messages and exemptions are relative to it. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** The doc that states the rule; every failure message points at it. */
export const NET_RULE_DOC = 'docs/contributing/testing-strategy.md § "No real network (#4217)"'

export interface NetExemption {
  /** The test file, relative to `packages/backend`, with `/` separators. */
  file: string
  /** Why this file may dial, and what the dial proves. */
  reason: string
  /**
   * The hosts this file may reach, read at dial time so an env override
   * (`HAVEN_ENFORCER_PROBE_RPC_URL`) is honoured. Every other host is refused
   * inside this file exactly as anywhere else.
   */
  hosts: () => readonly string[]
}

/**
 * The ONE list of files allowed to dial the real network, each scoped to the
 * hosts it needs. Add an entry only for a test whose point IS the live
 * dial, and justify it in the PR body. `mm-sdk-analytics.api.cx.metamask.io`
 * (the smart-accounts kit's analytics) never belongs here: the owner decided
 * it goes off (#4216).
 */
export const NET_EXEMPTIONS: readonly NetExemption[] = [
  {
    file: 'src/routes/__tests__/non-custody-onchain-enforcer.contract.test.ts',
    reason:
      'Proves CASP Red Line #4 against the caveat enforcers DEPLOYED on Base Sepolia (#2004) by ' +
      "eth_call'ing them; the live RPC IS the proof, and in CI an unreachable RPC must fail the " +
      'job (decideProbeMode → fail-ci), never skip it. Scoped to the RPC host, not the file: with ' +
      'CI unset the same file would otherwise also post the kit analytics.',
    hosts: () => [new URL(resolveProbeRpcUrl()).hostname],
  },
]

/** One refused dial or lookup, as recorded — host and port only, by construction. */
export interface NetRefusal {
  host: string
  port: number | null
  /** Which interception point saw it. */
  via: 'connect' | 'dns.lookup' | 'dns.promises.lookup' | 'dns.resolveTxt' | 'dns.promises.resolveTxt'
  /**
   * `name`: refused on the hostname, before any resolver was consulted (a
   * system-resolver name that is not local or admitted). `address`: refused
   * on the address — an IP-literal host, or what a lookup answered.
   */
  stage: 'name' | 'address'
  /** The test file running when it was recorded, relative to the package root. */
  testFile: string | null
  /** The test running when it was recorded; `null` between tests or in a hook. */
  testName: string | null
}

interface NetState {
  refusals: NetRefusal[]
  admittedHosts: Set<string>
  /**
   * The test between the net's own `beforeEach` and `afterEach`, or `null`.
   * Tracked here because vitest's `currentTestName` is not cleared when a
   * test ends, and a late dial must not be blamed on the last test to run.
   */
  runningTest: string | null
}

const STATE_KEY = Symbol.for('haven.backend.test-network-net')

type GlobalWithNet = typeof globalThis & { [STATE_KEY]?: NetState }

function state(): NetState {
  const g = globalThis as GlobalWithNet
  const existing = g[STATE_KEY]
  if (!existing) throw new Error('test network net: used before installTestNetworkNet()')
  return existing
}

// ── Address and name policy (pure) ──────────────────────────────────────────

const LOCAL_ADDRESSES = new net.BlockList()
LOCAL_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
LOCAL_ADDRESSES.addAddress('0.0.0.0', 'ipv4')
LOCAL_ADDRESSES.addAddress('::1', 'ipv6')
LOCAL_ADDRESSES.addAddress('::', 'ipv6')

/**
 * Is this address the local machine? Loopback and unspecified only.
 * `BlockList` matches an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`,
 * `::ffff:7f00:1`) against the IPv4 rules, so the mapped forms need no
 * parsing of our own. Anything that is not an IP literal is `false`.
 */
export function isLocalAddress(address: string): boolean {
  const bare = stripBrackets(address).split('%')[0] ?? ''
  const family = net.isIP(bare)
  if (family === 0) return false
  return LOCAL_ADDRESSES.check(bare, family === 6 ? 'ipv6' : 'ipv4')
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Lowercased, bracket-free, without a trailing root dot. */
export function normalizeHost(host: string): string {
  return stripBrackets(host.trim().toLowerCase()).replace(/\.$/, '')
}

/** RFC 2606 / RFC 6761 names that can never resolve. */
const RESERVED_SUFFIXES = ['.test', '.invalid', '.example']

export function isReservedName(host: string): boolean {
  const h = normalizeHost(host)
  return RESERVED_SUFFIXES.some((suffix) => h.endsWith(suffix) || h === suffix.slice(1))
}

export function isLoopbackName(host: string): boolean {
  const h = normalizeHost(host)
  return h === 'localhost' || h.endsWith('.localhost')
}

/** The exemption covering `testFile`, if any. */
export function exemptionFor(testFile: string | null): NetExemption | undefined {
  if (testFile === null) return undefined
  return NET_EXEMPTIONS.find((e) => e.file === testFile)
}

/** May `testFile` reach `host` under `NET_EXEMPTIONS`? */
export function isExemptDial(testFile: string | null, host: string): boolean {
  const exemption = exemptionFor(testFile)
  if (!exemption) return false
  const h = normalizeHost(host)
  return exemption.hosts().some((allowed) => normalizeHost(allowed) === h)
}

/**
 * Would the smart-accounts kit post analytics in this environment? Mirrors the
 * kit's own `isAnalyticsDisabled` (the only opt-out it has: `CI` or
 * `DO_NOT_TRACK` set to `1` / `yes` / `true`). `vitest.setup.ts` first loads
 * #4216's `src/telemetry/kit-analytics-off.ts`, which sets `DO_NOT_TRACK=1`, so
 * this is `false` in every ordinary file and the longer flush wait below costs
 * nothing. It can still be `true` in a file that strips the opt-out
 * (`delete process.env.DO_NOT_TRACK`, or `process.env = { … }` without it;
 * backend tests do replace `process.env`), and that is the case the longer
 * wait exists for: the kit could then latch ON and post on its batch timer.
 */
export function kitAnalyticsMayPost(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = (v: string | undefined) => v === '1' || ['yes', 'true'].includes((v ?? '').toLowerCase())
  return !(on(env.CI) || on(env.DO_NOT_TRACK))
}

/**
 * The kit batches its posts on a 100 ms timer (`Sender`, `baseTimeoutMs`), so
 * a post caused by a file's last test can land after that test's `afterEach`.
 * The file-level `afterAll` waits this long instead of `LATE_DIAL_WAIT_MS`
 * when the kit could post at all (`kitAnalyticsMayPost`) — with #4216's
 * opt-out loaded, only in a file that removed it.
 */
export const KIT_FLUSH_WAIT_MS = 150

/**
 * How long the file-level `afterAll` always yields before its last drain, so
 * a dial scheduled a tick after the file's last test (`setTimeout(0)`,
 * `setImmediate`, a fire-and-forget write) is recorded and fails the file.
 * Without it a `DO_NOT_TRACK=1` run never yielded, and such a dial was lost.
 */
export const LATE_DIAL_WAIT_MS = 50

// ── Recording ───────────────────────────────────────────────────────────────

function currentTest(): { testFile: string | null; testName: string | null } {
  let testPath: string | undefined
  try {
    testPath = expect.getState().testPath
  } catch {
    // Outside a vitest worker — no attribution.
  }
  const testFile = testPath ? path.relative(PACKAGE_ROOT, testPath).split(path.sep).join('/') : null
  return { testFile, testName: (globalThis as GlobalWithNet)[STATE_KEY]?.runningTest ?? null }
}

function formatHostPort(host: string, port: number | null): string {
  const h = net.isIPv6(stripBrackets(host)) ? `[${stripBrackets(host)}]` : host
  return port === null ? `${h} (lookup)` : `${h}:${port}`
}

/** The error the code under test sees. Host and port only. */
export class TestNetworkRefusalError extends Error {
  readonly code = 'ECONNREFUSED'
  constructor(refusal: Pick<NetRefusal, 'host' | 'port'>) {
    super(
      `test network net (#4217): refused ${formatHostPort(refusal.host, refusal.port)} — ` +
        `a backend test must not dial the real network (${NET_RULE_DOC})`,
    )
    this.name = 'TestNetworkRefusalError'
  }
}

function record(
  host: string,
  port: number | null,
  via: NetRefusal['via'],
  stage: NetRefusal['stage'],
): TestNetworkRefusalError {
  const refusal: NetRefusal = { host: normalizeHost(host), port, via, stage, ...currentTest() }
  state().refusals.push(refusal)
  return new TestNetworkRefusalError(refusal)
}

/** Remove and return every refusal recorded so far. */
export function takeRefusals(): NetRefusal[] {
  const s = state()
  const taken = s.refusals
  s.refusals = []
  return taken
}

/** The failure message for a batch of refusals. Host and port only. */
export function formatRefusals(refusals: readonly NetRefusal[], when: 'test' | 'file'): string {
  const lines = refusals.map((r) => {
    const where = r.testName ? `during "${r.testName}"` : 'outside any test (in a hook, between tests or after the last one)'
    return `  - ${formatHostPort(r.host, r.port)} via ${r.via}, in ${r.testFile ?? '(unknown file)'} ${where}`
  })
  const lead =
    when === 'test'
      ? `test network net (#4217): this test dialed the real network (${refusals.length} refused):`
      : `test network net (#4217): a dial landed after its test ended (${refusals.length} refused) — failing the file:`
  return [
    lead,
    ...lines,
    'The dial was refused, and failing here is what stops code that swallows the error from',
    'hiding it. Stub the seam the dial goes through (vi.mock of the module that fetches), or',
    'point it at a loopback server. A file whose point IS the live dial goes in NET_EXEMPTIONS',
    `(src/infra/__tests__/helpers/test-network-net.ts), scoped to its host. See ${NET_RULE_DOC}.`,
  ].join('\n')
}

// ── Policy applied at each interception point ──────────────────────────────

function admitted(host: string): boolean {
  const h = normalizeHost(host)
  return state().admittedHosts.has(h) || isExemptDial(currentTest().testFile, h)
}

type NameVerdict = 'resolve' | 'not-found' | 'refuse'

/** Before a system-resolver query leaves: may this name be looked up? */
function systemNameVerdict(host: string): NameVerdict {
  const h = normalizeHost(host)
  if (net.isIP(h) !== 0) return 'resolve' // a literal is answered locally, no query
  if (isLoopbackName(h) || admitted(h)) return 'resolve'
  if (isReservedName(h)) return 'not-found'
  return 'refuse'
}

function notFound(host: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${host}`)
  err.code = 'ENOTFOUND'
  err.syscall = 'getaddrinfo'
  return err
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void
type LookupFn = (hostname: string, options: unknown, callback: LookupCallback) => unknown

function addressesOf(address: unknown): string[] {
  if (Array.isArray(address)) return address.map((a: { address: string }) => a.address)
  return typeof address === 'string' ? [address] : []
}

/**
 * Wrap a lookup used by `connect`. `system` is true when the caller brought no
 * lookup of its own, which is when the name policy applies; the RESOLVED
 * ADDRESS is checked either way.
 */
function guardConnectLookup(inner: LookupFn, system: boolean, port: number | null): LookupFn {
  return function havenNetConnectLookup(this: unknown, hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options as LookupCallback
      options = {}
    }
    if (system) {
      const verdict = systemNameVerdict(hostname)
      if (verdict === 'not-found') {
        process.nextTick(callback, notFound(hostname))
        return undefined
      }
      if (verdict === 'refuse') {
        process.nextTick(callback, record(hostname, port, 'connect', 'name'))
        return undefined
      }
    }
    return inner.call(this, hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family)
      const addresses = addressesOf(address)
      if (admitted(hostname) || (addresses.length > 0 && addresses.every(isLocalAddress))) {
        return callback(null, address, family)
      }
      return callback(record(hostname, port, 'connect', 'address'))
    })
  }
}

/** Wrap a standalone system lookup (`dns.lookup`) with the name policy. */
function guardSystemLookup(inner: LookupFn, via: NetRefusal['via']): LookupFn {
  return function havenNetLookup(this: unknown, hostname, options, callback) {
    if (typeof hostname !== 'string') return inner.call(this, hostname, options, callback)
    if (typeof options === 'function') {
      callback = options as LookupCallback
      options = {}
    }
    const verdict = systemNameVerdict(hostname)
    if (verdict === 'resolve') return inner.call(this, hostname, options, callback)
    const err = verdict === 'not-found' ? notFound(hostname) : record(hostname, null, via, 'name')
    process.nextTick(callback, err)
    return {}
  }
}

/** Wrap a promise-returning resolver (`dns.promises.lookup`, `resolveTxt`) with the name policy. */
function guardPromiseResolver<A extends unknown[], R>(
  inner: (hostname: string, ...rest: A) => Promise<R>,
  via: NetRefusal['via'],
  allowLocalNames: boolean,
): (hostname: string, ...rest: A) => Promise<R> {
  return async function havenNetResolve(hostname, ...rest) {
    if (typeof hostname !== 'string') return await inner(hostname, ...rest)
    const verdict = allowLocalNames ? systemNameVerdict(hostname) : resolverVerdict(hostname)
    if (verdict === 'resolve') return await inner(hostname, ...rest)
    throw verdict === 'not-found' ? notFound(hostname) : record(hostname, null, via, 'name')
  }
}

/**
 * c-ares queries (`resolveTxt`) go to the configured DNS server even for
 * `localhost`, so only an admitted name may be queried; reserved names are
 * answered `ENOTFOUND` locally, everything else is refused.
 */
function resolverVerdict(host: string): NameVerdict {
  if (admitted(host)) return 'resolve'
  return isReservedName(host) ? 'not-found' : 'refuse'
}

type ResolveTxtCallback = (err: NodeJS.ErrnoException | null, records: string[][]) => void

function guardCallbackResolveTxt(
  inner: (hostname: string, callback: ResolveTxtCallback) => unknown,
): (hostname: string, callback: ResolveTxtCallback) => unknown {
  return function havenNetResolveTxt(this: unknown, hostname, callback) {
    if (typeof hostname !== 'string') return inner.call(this, hostname, callback)
    const verdict = resolverVerdict(hostname)
    if (verdict === 'resolve') return inner.call(this, hostname, callback)
    const err = verdict === 'not-found' ? notFound(hostname) : record(hostname, null, 'dns.resolveTxt', 'name')
    process.nextTick(callback, err, [])
    return {}
  }
}

interface NormalizedConnectOptions {
  host?: string
  port?: number | string
  path?: string
  lookup?: LookupFn
}
type NormalizedArgs = [NormalizedConnectOptions, ((...a: unknown[]) => void) | null]

const normalizeArgs = (net as unknown as { _normalizeArgs(args: unknown[]): NormalizedArgs })._normalizeArgs

// ── Installation ────────────────────────────────────────────────────────────

/** The host the run's real-DB harness connects to, admitted by name. */
export function databaseHost(url: string | undefined): string | null {
  if (!url) return null
  try {
    const host = parseConnectionString(url).host
    if (!host || host.startsWith('/')) return null // unset, or a Unix socket directory
    return normalizeHost(host)
  } catch {
    return null
  }
}

/**
 * Install the net in this worker. Idempotent: the second and later calls only
 * return. Call before anything opens a connection — `vitest.setup.ts` does it
 * first thing after the env defaults that name the database.
 */
export function installTestNetworkNet(env: NodeJS.ProcessEnv = process.env): void {
  const g = globalThis as GlobalWithNet
  if (g[STATE_KEY]) return

  const admittedHosts = new Set<string>()
  const dbHost = databaseHost(env.DATABASE_URL)
  if (dbHost !== null) admittedHosts.add(dbHost)
  g[STATE_KEY] = { refusals: [], admittedHosts, runningTest: null }

  const systemLookup = dns.lookup as unknown as LookupFn
  const originalConnect = net.Socket.prototype.connect

  net.Socket.prototype.connect = function havenNetConnect(this: net.Socket, ...args: unknown[]) {
    const normalized: NormalizedArgs = Array.isArray(args[0])
      ? (args[0] as unknown as NormalizedArgs)
      : normalizeArgs(args)
    const [options, cb] = normalized
    // A Unix socket or named pipe: local by construction.
    if (options.path !== undefined && options.path !== null) {
      return originalConnect.apply(this, args as Parameters<typeof originalConnect>)
    }
    const host = options.host ?? 'localhost'
    const port = options.port === undefined ? null : Number(options.port)

    if (net.isIP(stripBrackets(host)) !== 0) {
      if (admitted(host) || isLocalAddress(host)) {
        return originalConnect.apply(this, args as Parameters<typeof originalConnect>)
      }
      const err = record(host, port, 'connect', 'address')
      process.nextTick(() => this.destroy(err))
      return this
    }

    const guarded: NormalizedConnectOptions = {
      ...options,
      lookup: guardConnectLookup(options.lookup ?? systemLookup, options.lookup === undefined, port),
    }
    const next = normalizeArgs(cb ? [guarded, cb] : [guarded])
    return originalConnect.call(this, next as unknown as Parameters<typeof originalConnect>[0])
  } as typeof originalConnect

  dns.lookup = guardSystemLookup(systemLookup, 'dns.lookup') as unknown as typeof dns.lookup
  dns.promises.lookup = guardPromiseResolver(
    dns.promises.lookup.bind(dns.promises) as (h: string, ...r: unknown[]) => Promise<unknown>,
    'dns.promises.lookup',
    true,
  ) as unknown as typeof dns.promises.lookup
  dns.resolveTxt = guardCallbackResolveTxt(
    dns.resolveTxt as unknown as (h: string, cb: ResolveTxtCallback) => unknown,
  ) as unknown as typeof dns.resolveTxt
  dns.promises.resolveTxt = guardPromiseResolver(
    dns.promises.resolveTxt.bind(dns.promises),
    'dns.promises.resolveTxt',
    false,
  )
  // ESM named imports of a builtin (`import { lookup } from 'node:dns'`) are
  // snapshots; this re-syncs them to the patched properties.
  syncBuiltinESMExports()
}

/** Is the net installed in this worker? */
export function isTestNetworkNetInstalled(): boolean {
  return (globalThis as GlobalWithNet)[STATE_KEY] !== undefined
}

/**
 * Turn recorded refusals into reds. Registered once per test FILE by
 * `vitest.setup.ts`, so the hooks sit in each file's root suite and — being
 * registered first — run LAST in vitest's stack order, after the file's own
 * cleanup has had its chance to dial.
 */
export function registerNetHooks(): void {
  beforeEach(() => {
    state().runningTest = expect.getState().currentTestName ?? null
  })
  afterEach(() => {
    state().runningTest = null
    const refusals = takeRefusals()
    if (refusals.length > 0) throw new Error(formatRefusals(refusals, 'test'))
  })
  afterAll(async () => {
    // Always yield, so a dial scheduled a tick after the last test lands
    // before the final drain. `node:timers/promises`, not the global
    // `setTimeout`: a file that leaves `vi.useFakeTimers()` on would freeze
    // the global one and hang this hook until `hookTimeout`.
    await sleep(kitAnalyticsMayPost() ? KIT_FLUSH_WAIT_MS : LATE_DIAL_WAIT_MS)
    const refusals = takeRefusals()
    if (refusals.length > 0) throw new Error(formatRefusals(refusals, 'file'))
  })
}
