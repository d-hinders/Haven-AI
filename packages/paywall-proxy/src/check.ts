/**
 * The pre-flight check (#5008): `node dist/index.js check`.
 *
 * Before any real traffic, it tells a developer whether the deployment will
 * work. It prints one line per check — `ok`, `fail`, `skipped` or
 * `not verified`, and a reason in words — and exits non-zero when any check
 * fails. It never prints a secret, and it never prints an error's `message`:
 * viem errors embed the URL and x402 errors embed a response excerpt, so every
 * line is built from an error's class and a status code only.
 *
 * The checks, and the code each one reuses rather than reimplements:
 *
 * 1. **Settings** — `loadConfig` (`config.ts`), the same refusal startup makes,
 *    with its `ConfigError.problems` printed one line each. When settings are
 *    invalid, checks 3–6 print `skipped (settings invalid)`; the products check
 *    still runs when `PRODUCTS_FILE` is set.
 * 2. **Products file** — `loadProductsFile` (`products.ts`), with
 *    `ProductsFileError.problems`.
 * 3. **RPC** — `eth_chainId` on the configured (or #5006-defaulted) node,
 *    compared with `config.chain.chainId`. A wrong chain fails; an unreachable
 *    node fails naming the host only, because a provider URL can embed a key.
 * 4. **Coinbase key** — a local signing dry run (`preflightCdpSecret`,
 *    `merchant-payments/src/cdp.ts`, #5060), then `createCdpFacilitator` and one
 *    `getSupported()`, which `@coinbase/x402` signs a CDP JWT for. The dry run
 *    builds the same auth header with no network call, so a secret that cannot
 *    sign — the `.env.example` placeholder, or well-formed junk — fails locally
 *    and is named for what it is. Builder check (#5008): CDP answers a
 *    well-formed but wrong key with 401 on `GET …/supported`, so a success here
 *    is an authenticated success. The check also confirms the facilitator lists
 *    `exact` on the configured network.
 * 5. **Sales key** — `POST {HAVEN_SALES_URL}/merchant/sales` with the key and
 *    the body `{}`. The route's auth runs as an `onRequest` hook, before
 *    Fastify's schema validation, so an invalid key answers 401 and a valid one
 *    answers 400 `invalid_request` — the key was accepted and nothing was
 *    written. `backend/src/routes/__tests__/merchant-sales.db.test.ts` pins that
 *    ordering, so a future reordering turns red there and not on a merchant's
 *    machine.
 * 6. **Store and outbox** — `openSqliteConsumedPaymentStore` is not read-only
 *    (it creates the file and schema and clears reservation hashes), so `check`
 *    does not open the store with it. It checks that `PAYMENTS_DB`'s directory
 *    exists and is writable, and, when the file exists, that it can take and
 *    release the same exclusive lock. A held lock fails with the one-process
 *    rule `report-sale` follows. A missing file reports `ok (will be created at
 *    <path>)`, so a mistyped path is visible and no ledger is created there.
 *    The outbox gets the same directory check, and its depth is read when the
 *    file exists — never replayed, never changed.
 *
 * `check` makes no call that can move money or settle: no verify, no settle, no
 * sale record. It runs with the proxy stopped and does not replace `/healthz`,
 * which stays the running proxy's readiness probe.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { createPublicClient, http } from 'viem'
import {
  CDP_SECRET_CANNOT_SIGN,
  CdpSecretError,
  createCdpFacilitator,
  preflightCdpSecret,
  type CdpFacilitator,
  type SaleReportOutcome,
} from '@haven_ai/merchant-payments'
import { ConfigError, loadConfig, type ProxyConfig } from './config.js'
import { loadProductsFile, ProductsFileError } from './products.js'
import { openSalesOutbox } from './sales-outbox.js'
import type { SalesSettings } from './sales.js'
import { StoreLockedError } from './sqlite-store.js'

// Loaded through `require`, as `sqlite-store.ts` does: the bundler rewrites a
// bare `node:sqlite` import to `sqlite`, which does not exist.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

/** One check's answer: `ok`, `fail`, `skipped` or `not verified`, and why. */
export type CheckStatus = 'ok' | 'fail' | 'skipped' | 'not verified'

export interface CheckLine {
  /** The check's name, as the line prints it. */
  name: string
  status: CheckStatus
  /** The reason in words. Never a secret, never an error's message. */
  reason: string
  /** Extra lines printed under this one: a `ConfigError`'s or `ProductsFileError`'s problems. */
  details?: readonly string[]
}

export interface CheckReport {
  lines: readonly CheckLine[]
  /** 1 when any check failed, 0 otherwise. `skipped` and `not verified` do not fail. */
  exitCode: number
}

/** The names, in the order they print. */
export const CHECK_NAMES = ['settings', 'products', 'rpc', 'coinbase key', 'sales key', 'store', 'outbox'] as const

/** The checks that need a valid configuration, and so print `skipped (settings invalid)`. */
const NEEDS_SETTINGS = ['rpc', 'coinbase key', 'sales key', 'store', 'outbox'] as const

/** One RPC read's deadline. A node that cannot answer `eth_chainId` in this is unreachable. */
export const RPC_CHECK_TIMEOUT_MS = 10_000
/** One facilitator call's deadline. `getSupported`'s own default is 90 s; `check` is a pre-flight. */
export const FACILITATOR_CHECK_TIMEOUT_MS = 15_000
/** One Sales probe's deadline. */
export const SALES_CHECK_TIMEOUT_MS = 15_000

/** The two `error_code`s that mean Haven's route accepted the key and refused the empty body. */
const ACCEPTED_KEY_CODES: ReadonlySet<string> = new Set(['invalid_request', 'invalid_record'])

export interface CheckDeps {
  /** Builds the facilitator. Tests inject a fake; the real one is built from the credentials. */
  createFacilitator?: (credentials: { apiKeyId: string; apiKeySecret: string }) => Promise<CdpFacilitator>
  /**
   * #5060: the local signing dry run, before `getSupported`. Tests inject a
   * fake; the real one signs a CDP JWT with no network call.
   */
  preflight?: (credentials: { apiKeyId: string; apiKeySecret: string }) => Promise<void>
  /** Reads `eth_chainId`. Tests inject a fake; the real one is a viem client. */
  readChainId?: (rpcUrl: string) => Promise<number>
  /** The Sales probe's `fetch`. Tests inject a fake. */
  fetch?: typeof fetch
  /** Where the lines go. Default `console.log`. */
  print?: (line: string) => void
}

/** `name: status (reason)`, or `name: status` when there is no reason. */
export function formatCheckLine(line: CheckLine): string {
  return line.reason === '' ? `${line.name}: ${line.status}` : `${line.name}: ${line.status} (${line.reason})`
}

/** The lines `check` prints, in order: each check's line, then its details indented. */
export function formatCheckReport(report: CheckReport): string[] {
  const out: string[] = []
  for (const line of report.lines) {
    out.push(formatCheckLine(line))
    for (const detail of line.details ?? []) out.push(`  ${detail}`)
  }
  return out
}

/** An error's class only: a driver or transport message is not ours to print next to a key. */
function errorName(err: unknown): string {
  return err instanceof Error && err.name ? err.name : 'UnknownError'
}

/** The host of a URL, and nothing else: a provider URL can embed a key in its path or userinfo. */
function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    return parsed.host
  } catch {
    return undefined
  }
}

/**
 * The status a facilitator HTTP error carries in its message
 * (`Facilitator getSupported failed (401): …`). Only the number is read; the
 * message itself is never printed, because it embeds a response excerpt.
 */
function facilitatorStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined
  const match = /failed \((\d{3})\)/.exec(err.message)
  return match ? Number(match[1]) : undefined
}

/** Why a directory cannot hold a file, or `undefined` when it can. */
function directoryProblem(dir: string): string | undefined {
  let stats
  try {
    stats = statSync(dir)
  } catch {
    return `the directory ${dir} does not exist`
  }
  if (!stats.isDirectory()) return `${dir} is not a directory`
  try {
    accessSync(dir, constants.W_OK)
  } catch {
    return `the directory ${dir} is not writable`
  }
  return undefined
}

/** `sqlite-store.ts`'s busy rule, kept here because `check` must not open the store with its opener. */
function isBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { errcode?: number }).errcode
  return code === 5 || code === 6 || /database is locked|SQLITE_BUSY/i.test(err.message)
}

/**
 * Take and release the same exclusive lock `openSqliteConsumedPaymentStore`
 * takes at startup, without creating the file, the schema or clearing a
 * reservation hash. A running proxy holds the lock, so this fails with
 * `StoreLockedError` — the one-process rule `report-sale` follows.
 */
function probeExclusiveLock(path: string): void {
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA locking_mode=EXCLUSIVE')
    // The startup write's lock, without the write: takes it now, or fails with SQLITE_BUSY.
    db.exec('BEGIN EXCLUSIVE')
    db.exec('COMMIT')
  } catch (err) {
    if (isBusy(err)) throw new StoreLockedError()
    throw err
  } finally {
    try {
      db?.close()
    } catch {
      // already unusable
    }
  }
}

/** The default `eth_chainId` read: one viem client, no retries, a short deadline. */
async function readChainId(rpcUrl: string): Promise<number> {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: RPC_CHECK_TIMEOUT_MS, retryCount: 0 }) })
  return client.getChainId()
}

/** Check 1: the same `loadConfig` startup calls, with its problems printed one line each. */
function checkSettings(env: Readonly<Record<string, string | undefined>>): {
  line: CheckLine
  config?: ProxyConfig
} {
  try {
    return { line: { name: 'settings', status: 'ok', reason: '' }, config: loadConfig(env) }
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    const count = err.problems.length
    return {
      line: {
        name: 'settings',
        status: 'fail',
        reason: `${count} problem${count === 1 ? '' : 's'}`,
        details: err.problems,
      },
    }
  }
}

/** Check 2: the same `loadProductsFile` startup calls. Runs whenever `PRODUCTS_FILE` is set. */
function checkProducts(env: Readonly<Record<string, string | undefined>>): CheckLine {
  const path = env.PRODUCTS_FILE?.trim()
  if (!path) return { name: 'products', status: 'skipped', reason: 'PRODUCTS_FILE is not set' }
  try {
    const products = loadProductsFile(path)
    const ids = products.map((product) => product.id).join(', ')
    return {
      name: 'products',
      status: 'ok',
      reason: `${products.length} product${products.length === 1 ? '' : 's'}: ${ids}`,
    }
  } catch (err) {
    if (!(err instanceof ProductsFileError)) throw err
    const count = err.problems.length
    return {
      name: 'products',
      status: 'fail',
      reason: `${count} problem${count === 1 ? '' : 's'}`,
      details: err.problems,
    }
  }
}

/** Check 3: `eth_chainId` against the configured chain. The host only, never the URL. */
async function checkRpc(config: ProxyConfig, read: (rpcUrl: string) => Promise<number>): Promise<CheckLine> {
  const host = hostOf(config.rpcUrl)
  if (host === undefined) return { name: 'rpc', status: 'fail', reason: 'RPC_URL is not an http(s) URL' }
  try {
    const chainId = await read(config.rpcUrl)
    if (chainId !== config.chain.chainId) {
      return {
        name: 'rpc',
        status: 'fail',
        reason: `the node at ${host} reports chain ${chainId}, not ${config.chain.chainId}`,
      }
    }
    return { name: 'rpc', status: 'ok', reason: `${config.chain.network} at ${host}` }
  } catch (err) {
    return { name: 'rpc', status: 'fail', reason: `the node at ${host} did not answer (${errorName(err)})` }
  }
}

/** Check 4: the local signing dry run, then one authenticated `getSupported()`, and `exact` on the configured network. */
async function checkCoinbaseKey(
  config: ProxyConfig,
  build: (credentials: { apiKeyId: string; apiKeySecret: string }) => Promise<CdpFacilitator>,
  preflight: (credentials: { apiKeyId: string; apiKeySecret: string }) => Promise<void>,
): Promise<CheckLine> {
  // #5060: the dry run first. It makes no network call, and it catches both the
  // `.env.example` placeholder and well-formed junk, which a format check misses.
  try {
    await preflight(config.cdp)
  } catch (err) {
    return {
      name: 'coinbase key',
      status: 'fail',
      reason: err instanceof CdpSecretError ? err.message : `CDP_API_KEY_SECRET cannot sign a request (${errorName(err)})`,
    }
  }
  let facilitator: CdpFacilitator
  try {
    facilitator = await build(config.cdp)
  } catch (err) {
    // A malformed secret fails here, during JWT signing, with no network call.
    return {
      name: 'coinbase key',
      status: 'fail',
      reason: `the Coinbase client could not be built (${errorName(err)})`,
    }
  }
  if (typeof facilitator.getSupported !== 'function') {
    return {
      name: 'coinbase key',
      status: 'not verified',
      reason: 'the facilitator client has no getSupported, so the key was not exercised',
    }
  }
  try {
    const supported = await facilitator.getSupported()
    const exact = supported.kinds.some(
      (kind) => kind.scheme === 'exact' && kind.network === config.chain.network,
    )
    if (!exact) {
      return {
        name: 'coinbase key',
        status: 'fail',
        reason: `the facilitator does not list exact on ${config.chain.network}`,
      }
    }
    return { name: 'coinbase key', status: 'ok', reason: `exact on ${config.chain.network}` }
  } catch (err) {
    const status = facilitatorStatus(err)
    if (status === 401 || status === 403) {
      return { name: 'coinbase key', status: 'fail', reason: `the facilitator refused the key (${status})` }
    }
    if (status !== undefined) {
      return { name: 'coinbase key', status: 'fail', reason: `the facilitator answered ${status}` }
    }
    if (err instanceof Error && err.name === 'UserInputValidationError') {
      // #5060: the same case as the dry run's, for a client that signs lazily.
      return { name: 'coinbase key', status: 'fail', reason: CDP_SECRET_CANNOT_SIGN }
    }
    return {
      name: 'coinbase key',
      status: 'fail',
      reason: `the facilitator did not answer (${errorName(err)})`,
    }
  }
}

/** The `error_code` (or `error`) of a JSON answer, or `undefined` when the body is not JSON. */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as Record<string, unknown>
    if (typeof body.error_code === 'string') return body.error_code
    if (typeof body.error === 'string') return body.error
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Check 5: `POST {HAVEN_SALES_URL}/merchant/sales` with the key and the body
 * `{}`. Auth runs before validation, so 401 is a refused key and 400 with
 * Haven's `error_code` is an accepted key. Nothing is written either way.
 */
async function checkSalesKey(settings: SalesSettings, doFetch: typeof fetch): Promise<CheckLine> {
  const host = hostOf(settings.havenBaseUrl) ?? 'HAVEN_SALES_URL'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SALES_CHECK_TIMEOUT_MS)
  try {
    const response = await doFetch(`${settings.havenBaseUrl.replace(/\/+$/, '')}/merchant/sales`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.merchantKey}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    const status = response.status
    if (status === 401) {
      return {
        name: 'sales key',
        status: 'fail',
        reason: 'the key is missing, wrong or revoked, or its account is no longer a merchant account',
      }
    }
    if (status === 403) return { name: 'sales key', status: 'fail', reason: 'Sales is off for the account' }
    if (status === 429) return { name: 'sales key', status: 'not verified', reason: 'rate limited' }
    if (status === 400) {
      const code = await errorCodeOf(response)
      if (code !== undefined && ACCEPTED_KEY_CODES.has(code)) {
        return { name: 'sales key', status: 'ok', reason: 'the key was accepted' }
      }
      return {
        name: 'sales key',
        status: 'fail',
        reason: "HAVEN_SALES_URL is not Haven's API origin (400 without Haven's error_code)",
      }
    }
    if (status >= 200 && status < 300) {
      return {
        name: 'sales key',
        status: 'fail',
        reason: 'the route accepted an empty record, which it should refuse',
      }
    }
    return {
      name: 'sales key',
      status: 'fail',
      reason: `HAVEN_SALES_URL is not Haven's API origin (${status})`,
    }
  } catch (err) {
    return { name: 'sales key', status: 'fail', reason: `Haven at ${host} did not answer (${errorName(err)})` }
  } finally {
    clearTimeout(timer)
  }
}

/** Check 6a: the store's directory, and the exclusive lock when the file already exists. */
function checkStore(path: string): CheckLine {
  const problem = directoryProblem(dirname(path))
  if (problem !== undefined) return { name: 'store', status: 'fail', reason: problem }
  if (!existsSync(path)) return { name: 'store', status: 'ok', reason: `will be created at ${path}` }
  try {
    probeExclusiveLock(path)
    return { name: 'store', status: 'ok', reason: `the file at ${path} can take the exclusive lock` }
  } catch (err) {
    if (err instanceof StoreLockedError) {
      return { name: 'store', status: 'fail', reason: 'in use by a running proxy; stop it first' }
    }
    return { name: 'store', status: 'fail', reason: `the file at ${path} could not be opened (${errorName(err)})` }
  }
}

/** Check 6b: the outbox's directory, and its depth when the file already exists. */
function checkOutbox(path: string): CheckLine {
  const problem = directoryProblem(dirname(path))
  if (problem !== undefined) return { name: 'outbox', status: 'fail', reason: problem }
  if (!existsSync(path)) return { name: 'outbox', status: 'ok', reason: `will be created at ${path}` }
  try {
    // Opening the outbox only reads it; `queue`, `release`, `remove` and
    // `replay` are what write, and `check` calls none of them. The `send` below
    // is never reached.
    const outbox = openSalesOutbox({
      path,
      send: async (): Promise<SaleReportOutcome> => ({ outcome: 'gave_up', status: null, code: null, attempts: 0 }),
      log: () => {},
    })
    const depth = outbox.depth()
    return {
      name: 'outbox',
      status: 'ok',
      reason: depth === 0 ? `empty at ${path}` : `${depth} record${depth === 1 ? '' : 's'} waiting at ${path}`,
    }
  } catch (err) {
    return { name: 'outbox', status: 'fail', reason: `the file at ${path} could not be read (${errorName(err)})` }
  }
}

/** Every check, in order. Never throws: each check answers with its own line. */
export async function runChecks(
  env: Readonly<Record<string, string | undefined>>,
  deps: CheckDeps = {},
): Promise<CheckReport> {
  const lines: CheckLine[] = []
  const { line: settingsLine, config } = checkSettings(env)
  lines.push(settingsLine)
  lines.push(checkProducts(env))

  if (config === undefined) {
    for (const name of NEEDS_SETTINGS) {
      lines.push({ name, status: 'skipped', reason: 'settings invalid' })
    }
  } else {
    const read = deps.readChainId ?? readChainId
    const build =
      deps.createFacilitator ??
      ((credentials: { apiKeyId: string; apiKeySecret: string }) =>
        createCdpFacilitator(credentials, { timeoutMs: FACILITATOR_CHECK_TIMEOUT_MS }))
    const preflight = deps.preflight ?? preflightCdpSecret
    const doFetch = deps.fetch ?? fetch

    lines.push(await checkRpc(config, read))
    lines.push(await checkCoinbaseKey(config, build, preflight))
    lines.push(
      config.sales === undefined
        ? { name: 'sales key', status: 'skipped', reason: 'HAVEN_MERCHANT_KEY is not set' }
        : await checkSalesKey(config.sales, doFetch),
    )
    lines.push(checkStore(config.paymentsDb))
    lines.push(
      config.sales === undefined
        ? { name: 'outbox', status: 'skipped', reason: 'HAVEN_MERCHANT_KEY is not set' }
        : checkOutbox(config.sales.outboxPath),
    )
  }

  return { lines, exitCode: lines.some((line) => line.status === 'fail') ? 1 : 0 }
}

/**
 * `node dist/index.js check`. Prints one line per check and returns the process
 * exit code: 1 when any check failed, 0 otherwise, 2 for an argument it does
 * not take.
 */
export async function runCheckCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CheckDeps = {},
): Promise<number> {
  if (args.length > 0) {
    console.error('check takes no arguments.')
    return 2
  }
  const print = deps.print ?? ((line: string) => console.log(line))
  const report = await runChecks(env, deps)
  for (const line of formatCheckReport(report)) print(line)
  return report.exitCode
}
