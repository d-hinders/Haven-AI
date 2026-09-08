import { parseArgs, helpText, type ParsedArgs } from './args.js'
import { createCliApi, CliApiError, type CliApi } from './api.js'
import { createSessionStore, type Session, type SessionStore } from './session.js'
import { chainName, table, truncateAddress } from './format.js'
import { toCsv } from './csv.js'
import { EXIT, HavenCliError, UsageError, toFailure, type ExitCode } from './errors.js'
import { createOutput, type Output } from './output.js'
import { HAVEN_AGENT_RUNBOOK_MD } from './agent-guidance-text.js'
import { sessionExpiry } from './token.js'
import { parseTokenAmount } from './amount.js'
import {
  isRefusal,
  nodeSpawner,
  relayLine,
  runConnector,
  type ConnectorOutcome,
  type Spawner,
} from './connect-runner.js'

// Hosted Haven backend. Override with `--api <url>` or HAVEN_API_URL (e.g. a
// local backend at http://localhost:3001, or your own domain once self-hosted).
export const DEFAULT_API = 'https://havenbackend-production-8a00.up.railway.app'
// Self-reported CLI version. Owned by scripts/release-bump.mjs, which rewrites
// the string literal below on every release — keep it a bare quoted literal.
export const CLI_VERSION = '0.1.36-alpha.0'

export interface RunDeps {
  sessionStore?: SessionStore
  /** Build an API client; injected so tests can stub the backend. */
  makeApi?: (baseUrl: string, token?: string) => CliApi
  promptPassword?: () => Promise<string>
  /** #2526: injected so the device poll loop is testable without real time. */
  sleep?: (ms: number) => Promise<void>
  /** #2527: injected so `--run` is testable without spawning a real process. */
  spawner?: Spawner
  out?: (line: string) => void
  err?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

interface ResolvedDeps {
  sessionStore: SessionStore
  makeApi: (baseUrl: string, token?: string) => CliApi
  promptPassword: () => Promise<string>
  sleep: (ms: number) => Promise<void>
  spawner: Spawner
  out: (line: string) => void
  err: (line: string) => void
  env: NodeJS.ProcessEnv
  /** Set once `--json` is known; every command writes through it. */
  o: Output
}

/**
 * Every command this CLI dispatches, as data (#2525).
 *
 * The table-driven contract test in `json-contract.test.ts` iterates THIS list
 * and asserts each command's `--json` refusal is one JSON object on stdout, so
 * a command added to `dispatch` without adding it here is not covered. Its
 * ceiling, stated plainly: the test proves the listed commands honour the
 * contract, not that the list is complete. A drift test below pins the list
 * against `dispatch`'s own switch to close that gap by execution.
 */
export const COMMANDS = [
  'login', 'logout', 'whoami', 'guide',
  'wallets list', 'wallets balances', 'wallets rename', 'wallets funding',
  'agents list', 'agents show', 'agents pause', 'agents resume', 'agents revoke',
  'agents rotate-key', 'agents rename', 'agents connect',
  'budget show', 'budget grant', 'budget revoke',
  'activity list', 'activity export',
  'catalog list',
  'contacts list', 'contacts add', 'contacts remove',
] as const

// ── Backend response shapes (subset the CLI needs) ──────────────────
interface Safe { id: string; safe_address: string; chain_id: number; name: string; is_default: boolean }
interface Allowance { token_symbol: string; allowance_amount: string; reset_period_min: number }
interface Agent { id: string; name: string; status: string; allowances?: Allowance[] }
interface Balance { symbol: string; formatted: string; balance: string }
interface Txn {
  hash: string; direction: 'in' | 'out'; valueFormatted: string; asset: string
  source?: string; timestamp: number; safeName?: string
  from?: string; to?: string; isError?: boolean
  tokenSymbol?: string; tokenAddress?: string; chainId?: number; safeAddress?: string
  agentName?: string; paymentFlowStatus?: string | null; activityType?: string
}
interface CatalogEntry { name: string; category: string; rail: string; price_display?: string | null; status: string }
interface Contact { id: string; name: string; address: string }
interface BalanceToken { symbol: string; address: string | null; decimals: number }
interface CreateSetupResponse {
  setup_id: string
  status: string
  approval_url: string
  expires_at: string
  connector_command: string
  connector_package: string
  setup_prompt: string
}
interface SetupStatus {
  setup_id: string
  status: string
  agent_id: string | null
  approval_url: string
  expires_at: string
}

/** `GET /user/safes/:safeId/funding` — the wire shape the route documents. */
interface FundingResponse {
  account_address: string
  chain: { id: number; name: string; explorer_url: string }
  tokens: {
    symbol: string
    address: string
    decimals: number
    balance_human: string
    minimum_useful_human: string | null
  }[]
  native: { symbol: string; balance_human: string; needed: boolean }
  funded: boolean
  faucet_url?: string
}

/** Entry point. Returns a process exit code; never throws for expected errors. */
export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`))
  const err = deps.err ?? ((l: string) => process.stderr.write(`${l}\n`))

  // `--json` has to be known before anything can be emitted, including a parse
  // failure's own message. Scanning argv for the flag is deliberate: parseArgs
  // throws on a bad line, and a refusal that ignored --json because the parse
  // failed would break the contract exactly when a caller most needs it.
  const json = argv.includes('--json')
  const o = createOutput(json, out, err)

  const d: ResolvedDeps = {
    sessionStore: deps.sessionStore ?? createSessionStore(),
    makeApi: deps.makeApi ?? ((baseUrl, token) => createCliApi({ baseUrl, token })),
    promptPassword: deps.promptPassword ?? (() => Promise.reject(new Error('No password input available'))),
    sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    spawner: deps.spawner ?? nodeSpawner,
    out,
    err,
    env: deps.env ?? process.env,
    o,
  }

  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    return fail(d, new UsageError(e instanceof Error ? e.message : String(e), 'Run `haven --help`.'))
  }

  if (args.flags.version) {
    o.data({ version: CLI_VERSION }, () => CLI_VERSION)
    return EXIT.ok
  }
  if (args.flags.help || !args.command) {
    o.data({ help: helpText() }, () => helpText())
    return EXIT.ok
  }

  try {
    return await dispatch(args, d)
  } catch (e) {
    return fail(d, e)
  }
}

/** The single exit: one failure object, one exit code, read off one decision. */
function fail(d: ResolvedDeps, err: unknown): ExitCode {
  const failure = toFailure(err)
  d.o.failure(failure)
  return failure.exit
}

async function dispatch(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const key = args.sub ? `${args.command} ${args.sub}` : args.command
  switch (key) {
    case 'guide': return cmdGuide(args, d)
    case 'login': return cmdLogin(args, d)
    case 'logout': return cmdLogout(args, d)
    case 'whoami': return cmdWhoami(args, d)
    case 'wallets list': return cmdWalletsList(args, d)
    case 'wallets balances': return cmdWalletsBalances(args, d)
    case 'wallets funding': return cmdWalletsFunding(args, d)
    case 'agents list': return cmdAgentsList(args, d)
    case 'agents show': return cmdAgentsShow(args, d)
    case 'agents connect': return cmdAgentsConnect(args, d)
    case 'agents pause': return cmdAgentLifecycle(args, d, 'pause')
    case 'agents resume': return cmdAgentLifecycle(args, d, 'resume')
    case 'agents revoke': return cmdAgentRevoke(args, d)
    case 'agents rotate-key': return cmdAgentRotateKey(args, d)
    case 'agents rename': return cmdAgentRename(args, d)
    case 'budget show': return cmdBudgetShow(args, d)
    case 'budget grant': return cmdBudgetGrant(args, d)
    case 'budget revoke': return cmdBudgetRevoke(args, d)
    case 'wallets rename': return cmdWalletRename(args, d)
    case 'activity list': return cmdActivityList(args, d)
    case 'activity export': return cmdActivityExport(args, d)
    case 'catalog list': return cmdCatalogList(args, d)
    case 'contacts list': return cmdContactsList(args, d)
    case 'contacts add': return cmdContactsAdd(args, d)
    case 'contacts remove': return cmdContactsRemove(args, d)
    default:
      throw new UsageError(`Unknown command: ${key}.`, 'Run `haven --help` for the command list.')
  }
}

function baseUrlFor(args: ParsedArgs, d: ResolvedDeps, session: Session | null): string {
  return args.flags.api ?? session?.apiBaseUrl ?? d.env.HAVEN_API_URL ?? DEFAULT_API
}

async function authed(args: ParsedArgs, d: ResolvedDeps): Promise<{ session: Session; api: CliApi }> {
  const session = await d.sessionStore.load()
  // Status 401 so a missing local session and a rejected one produce the same
  // code and the same advice — from the caller's side they are one situation.
  if (!session) throw new CliApiError('Not authenticated.', 401)
  return { session, api: d.makeApi(baseUrlFor(args, d, session), session.token) }
}

function emit(d: ResolvedDeps, _json: boolean, data: unknown, human: () => string): void {
  d.o.data(data, human)
}

// ── Guide ───────────────────────────────────────────────────────────

/**
 * Print the agent onboarding runbook — the same text served at
 * `/for-agents.md` (#2523). Offline by construction: the string is compiled in,
 * so an agent with no session and no network still gets the instructions that
 * tell it what to do about exactly that.
 */
async function cmdGuide(_args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  d.o.data({ ok: true, format: 'markdown', content: HAVEN_AGENT_RUNBOOK_MD }, () => HAVEN_AGENT_RUNBOOK_MD)
  return EXIT.ok
}

// ── Auth ────────────────────────────────────────────────────────────

interface DeviceStart {
  device_code: string
  user_code: string
  verification_url: string
  expires_in: number
  interval: number
}

/**
 * Browser-approved login (#2526), the DEFAULT for `haven login`.
 *
 * The reason this is the default and the password path is not: an agent drives
 * this CLI, and an agent must never hold its user's password. The cold-test
 * agent correctly refused to type one. This asks the human instead — the agent
 * pastes a link, and every signature stays with the person.
 *
 * Under `--json` the first object is emitted BEFORE polling starts, so an agent
 * can hand its user the link immediately rather than after the flow completes.
 */
async function deviceLogin(args: ParsedArgs, d: ResolvedDeps, baseUrl: string): Promise<number> {
  const api = d.makeApi(baseUrl)
  const label = d.env.HAVEN_CLIENT_LABEL ?? `Haven CLI on ${d.env.HOSTNAME ?? 'this machine'}`
  const start = await api.post<DeviceStart>('/auth/device/start', { client_label: label })

  const deadline = Date.now() + start.expires_in * 1000
  // Emitted first, not last: the whole point is that the agent can pass the
  // link on while the poll runs. `device_code` is #2618: without it, the
  // `--no-wait` object had nothing an agent could feed to
  // `haven login --poll` — the resume command existed on the flag parser and
  // nowhere an agent could reach it.
  d.o.data(
    {
      ok: true,
      verification_url: start.verification_url,
      user_code: start.user_code,
      device_code: start.device_code,
      interval: start.interval,
      expires_at: new Date(deadline).toISOString(),
    },
    () =>
      `Open ${start.verification_url}\nand approve the code ${start.user_code}.\n` +
      `It expires in ${Math.round(start.expires_in / 60)} minutes.`,
  )

  if (args.flags.noWait) return EXIT.ok

  // #2618: under --json, ten minutes of polling defeats the point of the
  // flag — an agent that expected to regain control sat out its whole turn.
  // --json now defaults to a SHORT wait (30 s, the issue's figure): still
  // long enough to catch a human who approves right away, short enough that
  // the agent gets a pending object instead of a blocked turn. An explicit
  // --no-wait keeps its documented immediate return, and human prose mode
  // keeps the full wait the flow always had.
  const jsonWaitMs = args.flags.json ? 30_000 : start.expires_in * 1000
  const waitUntil = Date.now() + jsonWaitMs

  // The server names the interval; the client does not invent one. `slow_down`
  // widens it, which is the only backoff signal this flow has.
  let interval = start.interval * 1000
  for (;;) {
    if (Date.now() >= deadline) {
      throw new HavenCliError('The code expired before it was approved.', EXIT.notAuthenticated)
    }
    if (Date.now() >= waitUntil) {
      // Time out at the CLIENT's deadline, not the code's: emit the pending
      // object carrying the device code so `haven login --poll
      // <device_code>` can pick the flow up — nothing is lost, exit 3
      // (not_authenticated: "keep the flow, you are just not signed in yet").
      d.o.data(
        { status: 'pending', device_code: start.device_code, retry_after: Math.round(interval / 1000) },
        () => 'Still waiting for approval — run the same command again to keep waiting.',
      )
      return EXIT.notAuthenticated
    }
    await d.sleep(interval)
    let res: { token: string; user: Session['user'] } | null = null
    try {
      res = await api.post<{ token: string; user: Session['user'] }>('/auth/device/token', {
        device_code: start.device_code,
      })
    } catch (err) {
      const code = deviceErrorCode(err)
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') {
        interval += 5000
        continue
      }
      if (code === 'access_denied') {
        throw new HavenCliError('The request was denied.', EXIT.refused)
      }
      if (code === 'expired_token') {
        throw new HavenCliError('The code expired before it was approved.', EXIT.notAuthenticated)
      }
      throw err
    }
    await d.sessionStore.save({ token: res.token, apiBaseUrl: baseUrl, user: res.user })
    emit(
      d,
      args.flags.json,
      { ok: true, email: res.user.email, expires_at: sessionExpiry(res.token), user: res.user, apiBaseUrl: baseUrl },
      () => `Signed in as ${res!.user.email}.`,
    )
    return EXIT.ok
  }
}

/** The RFC 8628 error slug in a 400 body, or null. */
function deviceErrorCode(err: unknown): string | null {
  const body = (err as { body?: { error?: unknown } } | undefined)?.body
  return typeof body?.error === 'string' ? body.error : null
}

/**
 * #2618: the suggested gap between `haven login --poll` rounds, in seconds.
 * Mirrors what the backend's device start has named in `interval` so far —
 * the CLI never invents a different number, and one poll round per invocation
 * keeps the request rate at whatever the caller's retry loop chooses.
 */
const POLL_RETRY_AFTER_SECONDS = 5

/**
 * ONE poll round of the device flow (#2618) — the second command of the
 * non-blocking sequence `login --json --no-wait`, then `login --poll
 * <device_code>`. The blocking loop cannot serve an agent that must return
 * promptly, and killing it loses the code; this performs the poll the loop
 * WOULD have done and hands the outcome straight back as an exit code:
 * 0 approved (session saved, same success object as the blocking path),
 * 3 pending (a `{ status, device_code, retry_after }` object — poll again),
 * 4 denied. The server answers `expired_token` for an unknown code too, so
 * that also exits 3: expired means start over, and 3 is "not signed in".
 */
async function devicePollOnce(
  args: ParsedArgs,
  d: ResolvedDeps,
  baseUrl: string,
  deviceCode: string,
): Promise<number> {
  const api = d.makeApi(baseUrl)
  let res: { token: string; user: Session['user'] } | null = null
  try {
    res = await api.post<{ token: string; user: Session['user'] }>('/auth/device/token', {
      device_code: deviceCode,
    })
  } catch (err) {
    // Same slug mapping as the blocking loop above — one flow, one vocabulary.
    const code = deviceErrorCode(err)
    if (code === 'authorization_pending') {
      d.o.data(
        { status: 'pending', device_code: deviceCode, retry_after: POLL_RETRY_AFTER_SECONDS },
        () => 'Not approved yet — poll again shortly.',
      )
      return EXIT.notAuthenticated
    }
    if (code === 'slow_down') {
      // The server is saying the same thing the blocking loop's widening is:
      // back off. The next round should wait LONGER than the named interval.
      d.o.data(
        {
          status: 'pending',
          device_code: deviceCode,
          retry_after: POLL_RETRY_AFTER_SECONDS + 5,
        },
        () => 'Polling too fast — wait a moment longer, then poll again.',
      )
      return EXIT.notAuthenticated
    }
    if (code === 'access_denied') {
      throw new HavenCliError('The request was denied.', EXIT.refused)
    }
    if (code === 'expired_token') {
      throw new HavenCliError('The code expired before it was approved.', EXIT.notAuthenticated)
    }
    throw err
  }
  await d.sessionStore.save({ token: res.token, apiBaseUrl: baseUrl, user: res.user })
  emit(
    d,
    args.flags.json,
    { ok: true, email: res.user.email, expires_at: sessionExpiry(res.token), user: res.user, apiBaseUrl: baseUrl },
    () => `Signed in as ${res!.user.email}.`,
  )
  return EXIT.ok
}

async function cmdLogin(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  // #2618: the resume step of the non-blocking sequence. `--poll` takes the
  // device code the `--no-wait` (or timed-out `--json`) object carried and
  // performs exactly ONE round against POST /auth/device/token — see
  // `devicePollOnce`. It cannot be combined with the password path: a poll
  // belongs to a started device flow, and silently starting a login instead
  // would look like the flow was resumed when it was not.
  if (args.flags.poll) {
    return devicePollOnce(args, d, baseUrlFor(args, d, null), args.flags.poll)
  }
  const email = args.flags.email ?? d.env.HAVEN_EMAIL
  // #2526: the browser flow is the DEFAULT. `--email` (or HAVEN_EMAIL) keeps
  // the password path for a human who wants it — it is not removed, it is no
  // longer what an agent gets by asking for `login`.
  if (!email) {
    return deviceLogin(args, d, baseUrlFor(args, d, null))
  }
  const password = d.env.HAVEN_PASSWORD ?? (await d.promptPassword())
  if (!password) {
    throw new UsageError('A password is required.', 'Set HAVEN_PASSWORD for a non-interactive run.')
  }
  const baseUrl = baseUrlFor(args, d, null)
  const api = d.makeApi(baseUrl)
  const res = await api.post<{ token: string; user: Session['user'] }>('/auth/login', { email, password })
  await d.sessionStore.save({ token: res.token, apiBaseUrl: baseUrl, user: res.user })
  // The issue specifies { ok, email, expires_at }; `user` and `apiBaseUrl` stay
  // because they were already the shape and dropping them would break a script
  // that reads them for no gain. Neither the password nor the token is echoed —
  // `expires_at` is derived from the token, never the token itself.
  emit(
    d,
    args.flags.json,
    { ok: true, email: res.user.email, expires_at: sessionExpiry(res.token), user: res.user, apiBaseUrl: baseUrl },
    () => `Signed in as ${res.user.email}.`,
  )
  return EXIT.ok
}

async function cmdLogout(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  await d.sessionStore.clear()
  emit(d, args.flags.json, { ok: true, signed_out: true }, () => 'Signed out.')
  return EXIT.ok
}

async function cmdWhoami(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { session, api } = await authed(args, d)
  const user = await api.get<Session['user']>('/auth/me')
  // The four fields #2525 asks for — id, email, session expiry, api url — laid
  // over the profile the route already returned, so nothing a caller reads
  // today disappears. `expires_at` is null when the token carries no readable
  // `exp`, which is a fact worth reporting rather than an error.
  emit(
    d,
    args.flags.json,
    { ...user, id: user.id, email: user.email, expires_at: sessionExpiry(session.token), api_url: session.apiBaseUrl },
    () => `${user.email}${user.name ? ` (${user.name})` : ''}`,
  )
  return EXIT.ok
}

// ── Wallets ─────────────────────────────────────────────────────────

async function cmdWalletsList(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const { safes } = await api.get<{ safes: Safe[] }>('/user/safes')
  emit(d, args.flags.json, safes, () =>
    safes.length === 0
      ? 'No Haven wallets yet.'
      : table(
          ['NAME', 'NETWORK', 'ADDRESS', 'DEFAULT'],
          safes.map((s) => [s.name, chainName(s.chain_id), truncateAddress(s.safe_address), s.is_default ? '✓' : '']),
        ),
  )
  return EXIT.ok
}

async function cmdWalletsBalances(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const { safes } = await api.get<{ safes: Safe[] }>('/user/safes')
  const safe = pickSafe(safes, args.flags.safe)
  if (!safe) {
    if (args.flags.safe) throw new UsageError(`No wallet matches "${args.flags.safe}".`)
    throw new CliApiError('No Haven wallet found.', 404)
  }
  const { balances } = await api.get<{ balances: Balance[] }>(
    `/balances/${safe.safe_address}?chain_id=${safe.chain_id}`,
  )
  emit(d, args.flags.json, { safe: safe.name, chainId: safe.chain_id, balances }, () =>
    [
      `${safe.name} · ${chainName(safe.chain_id)} · ${truncateAddress(safe.safe_address)}`,
      balances.length === 0
        ? '  (no balances)'
        : table(['TOKEN', 'BALANCE'], balances.map((b) => [b.symbol, b.formatted])),
    ].join('\n'),
  )
  return EXIT.ok
}

function pickSafe(safes: Safe[], ref?: string): Safe | undefined {
  if (!ref) return safes.find((s) => s.is_default) ?? safes[0]
  const lower = ref.toLowerCase()
  return safes.find((s) => s.id === ref || s.safe_address.toLowerCase() === lower)
}

// ── Wallet funding (#2534) ──────────────────────────────────────────

/**
 * The paste-ready funding instruction, read from the backend.
 *
 * The endpoint is the source; this command renders it. Every number in the
 * prose — the minimum to send, the address, the explorer link — comes out of
 * the response, so the CLI, the dashboard's funding card and the backend's
 * own docs cannot drift apart: `@haven_ai/core` owns the constants, the
 * route composes them, and nothing here repeats one. Prose mode prints the
 * sentence an agent hands to its human; `--json` prints the response object
 * itself, so a machine that wants to relay fields rather than a sentence has
 * the same facts in the same place.
 *
 * `--wait` polls until `funded` flips — how a turn actually waits out a human
 * moving money — with elapsed time visible so nobody stares at a silent
 * terminal. It exits 0 once funded and 1 on timeout (elapsed time in the
 * message); it never sends anything, never touches a faucet — this is
 * read-only facts for the human to act on, whatever the flag.
 */
async function cmdWalletsFunding(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const { safes } = await api.get<{ safes: Safe[] }>('/user/safes')
  const safe = pickSafe(safes, args.flags.safe)
  if (!safe) {
    if (args.flags.safe) throw new UsageError(`No wallet matches "${args.flags.safe}".`)
    throw new CliApiError('No Haven wallet found.', 404)
  }
  // The endpoint is keyed by safe ID and resolves ownership itself — the
  // address/chain in the response are the route's answer, not ours to compose.
  const funding = await api.get<FundingResponse>(`/user/safes/${safe.id}/funding`)

  if (!args.flags.wait) {
    emitFunding(d, funding)
    return EXIT.ok
  }

  // ── `--wait`: poll until the human's transfer lands ────────────────
  const started = Date.now()
  // The poll interval, injectable so tests can run the loop without real time.
  const pollMs = Number(d.env.HAVEN_FUNDING_POLL_MS ?? '5000')
  // A default cap, not a guess about the user's patience: two hours covers a
  // bank-transfer detour, and `HAVEN_FUNDING_WAIT_MS` shortens it for tests.
  const waitMs = Number(d.env.HAVEN_FUNDING_WAIT_MS ?? String(2 * 60 * 60 * 1000))
  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(waitMs) || waitMs <= 0) {
    throw new UsageError('HAVEN_FUNDING_POLL_MS / HAVEN_FUNDING_WAIT_MS must be positive numbers of milliseconds')
  }
  let current = funding
  for (;;) {
    // The cap is checked BEFORE each poll, so a zero-length wait exits without
    // ever calling the endpoint twice.
    const spent = Date.now() - started
    if (spent >= waitMs) {
      throw new HavenCliError(
        `Still not funded after ${elapsedLabel(spent)} — the transfer may not have landed yet. Check the explorer link, then re-run.`,
        EXIT.failed,
      )
    }
    await d.sleep(pollMs)
    current = await api.get<FundingResponse>(`/user/safes/${safe.id}/funding`)
    if (current.funded) break
    d.o.note(`Still waiting after ${elapsedLabel(Date.now() - started)} — funded: no.`)
  }
  d.o.note(`Account shows funded after ${elapsedLabel(Date.now() - started)}.`)
  emitFunding(d, current)
  return EXIT.ok
}

/** One renderer, both modes: prose carries the paste-ready sentence. */
function emitFunding(d: ResolvedDeps, funding: FundingResponse): void {
  emit(d, d.o.json, funding, () => {
    const token = funding.tokens.find((t) => t.minimum_useful_human !== null)
    const asset = token
      ? `at least ${token.minimum_useful_human} ${token.symbol}`
      : funding.native.needed
        ? funding.native.symbol
        : 'USDC'
    const gas = funding.native.needed
      ? ` plus ${funding.native.symbol} for gas`
      : ' — no gas token needed; Haven sponsors it'
    const faucet = funding.faucet_url !== undefined ? ` faucet: ${funding.faucet_url},` : ''
    return [
      `Send ${asset} on ${funding.chain.name} to ${funding.account_address}${gas}.`,
      `Explorer: ${funding.chain.explorer_url}.${faucet ? faucet.slice(0, -1) : ''}`,
      funding.funded ? 'The account already counts as funded.' : 'Nothing has arrived yet.',
    ].join('\n')
  })
}

/** `83s` → `1m23s` → `1h02m` — the poll line and the timeout message share it. */
function elapsedLabel(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

// ── Agents & budget ─────────────────────────────────────────────────

async function cmdAgentsList(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const { agents } = await api.get<{ agents: Agent[] }>('/agents')
  emit(d, args.flags.json, agents, () =>
    agents.length === 0
      ? 'No agents yet.'
      : table(
          ['ID', 'NAME', 'STATUS', 'BUDGETS'],
          agents.map((a) => [a.id, a.name, a.status, budgetSummary(a.allowances)]),
        ),
  )
  return EXIT.ok
}

async function cmdAgentsShow(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) throw new UsageError('Usage: haven agents show <id>')
  const { api } = await authed(args, d)
  const agent = await api.get<Agent>(`/agents/${id}`)
  emit(d, args.flags.json, agent, () =>
    [
      `${agent.name}  [${agent.status}]`,
      `id: ${agent.id}`,
      `budget: ${budgetSummary(agent.allowances)}`,
    ].join('\n'),
  )
  return EXIT.ok
}

/**
 * The one command that prints a delegation hash (#2612).
 *
 * `budget revoke` takes a hash as its second argument, and until this existed
 * NO `haven` command printed one — while the README and the revoke usage error
 * both said `haven agents show` did. It does not: that response carries the
 * allowances projection and has no hash field at all. Both now point here, and
 * a test asserts this literal appears in the README AND that running it emits
 * a hash, so the instruction and the output cannot drift apart again.
 */
export const HASH_DISCOVERY_HINT = 'haven budget show <agentId> --hashes'

async function cmdBudgetShow(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) throw new UsageError('Usage: haven budget show <agentId> [--hashes]')
  const { api } = await authed(args, d)

  // #2612: a DIFFERENT read, deliberately behind a flag. The hashes live on
  // GET /agents/:id/delegations, not on the agent's allowances projection, and
  // `budget show --json` has emitted a bare allowances array since the first
  // CLI scaffold — adding a second shape to that array would break every
  // existing consumer of it.
  if (args.flags.hashes) {
    const { delegations } = await api.get<{ delegations: DelegationRow[] }>(`/agents/${id}/delegations`)
    emit(d, args.flags.json, delegations, () =>
      delegations.length === 0
        ? `No delegations on agent ${id}.`
        : table(
            ['DELEGATION HASH', 'STATUS', 'VERSION'],
            delegations.map((r) => [r.delegation_hash, r.status, String(r.version)]),
          ),
    )
    return EXIT.ok
  }

  const agent = await api.get<Agent>(`/agents/${id}`)
  const allowances = agent.allowances ?? []
  emit(d, args.flags.json, allowances, () =>
    allowances.length === 0
      ? `${agent.name} has no configured budget.`
      : table(
          ['TOKEN', 'AMOUNT', 'RESETS'],
          allowances.map((a) => [a.token_symbol, a.allowance_amount, resetLabel(a.reset_period_min)]),
        ),
  )
  return EXIT.ok
}

function budgetSummary(allowances?: Allowance[]): string {
  if (!allowances || allowances.length === 0) return '—'
  return allowances.map((a) => `${a.allowance_amount} ${a.token_symbol}`).join(', ')
}

// ── Budget grant/revoke (#2539, C3) — construct-and-hand-off ────────────────
//
// Both commands CONSTRUCT a signature request and print a dashboard link the
// human signs in the browser. The CLI never signs and never calls activate —
// that is the whole safety property of this slice, and the reason the backend
// allow-list can carry build + revoke-prepare at all.

/** The POST /agents/:id/delegations/build response the CLI consumes (#2539). */
interface DelegationBuild {
  delegation_hash: string
  version: number
  /** The same value as delegation_hash — one identifier, no new column. */
  build_id: string
  typed_data_hash: string
  signing_url: string
}

/** One row of GET /agents/:id/delegations (#2539's --wait reads these). */
interface DelegationRow {
  delegation_hash: string
  version: number
  status: 'pending' | 'active' | 'replaced' | 'revoked'
}

/** The POST /agents/:id/delegations/:hash/revoke prepare response (#2539). */
interface RevocationPrepare {
  signature_scheme?: 'eip712_userop' | 'webauthn_userop'
  /** Dashboard revoke link, built by the backend from its own FRONTEND_URL. */
  revocation_url?: string
}

/** How long `--wait` polls before giving up. */
const BUDGET_WAIT_TIMEOUT_S = 15 * 60
const BUDGET_WAIT_INTERVAL_MS = 5_000

/**
 * `haven budget grant` — construct the budget delegation, hand the signature
 * to the human (#2539).
 *
 * Calls the build route with the owner_cli session, stores nothing itself,
 * and prints the signing link the backend built. `--wait` polls the agent's
 * delegation list for the returned hash to reach `active`, which converges
 * because the build is idempotent within its expiry: the dashboard form's own
 * rebuild of the same grant returns the SAME hash instead of minting a new
 * version that would strand this poller.
 */
async function cmdBudgetGrant(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) {
    throw new UsageError('Usage: haven budget grant <agentId> --amount 25 --token USDC --period <minutes> [--recipient <address>] [--expires <unix-seconds>] [--wait]')
  }
  if (!args.flags.amount || !args.flags.token || args.flags.period === undefined) {
    throw new UsageError('--amount, --token and --period are required (period is whole minutes, at least 1)')
  }
  // The delegation rail has no one-time period: `/delegations/build` refuses
  // anything under 60 seconds. `agents connect` DOES take `--period 0` for
  // `reset_period_min`, which is a different field on a different route, and
  // this command's usage text was first written from that convention — so a
  // caller following it hit an opaque 400 from the backend instead of this
  // sentence. Refuse it here, where the message can say what to pass instead.
  if (args.flags.period < 1) {
    throw new UsageError('--period must be at least 1 minute for a budget grant. A recurring budget is the only shape this rail has; `haven agents connect --period 0` is a different field on a different route.')
  }
  const { api } = await authed(args, d)

  // Fail fast on the rail this command cannot serve, and read the token's
  // decimals from the backend — the same registry the dashboard form sizes
  // budgets with, never a local table.
  const agent = await api.get<Agent & { account_type?: string | null; safe_address: string | null; safe_chain_id: number | null }>(`/agents/${id}`)
  if (agent.account_type !== 'delegator_hybrid') {
    throw new HavenCliError(
      `Agent ${id} is not on the delegation rail — budgets are managed from the dashboard for this account.`,
      EXIT.refused,
    )
  }
  if (!agent.safe_address || !agent.safe_chain_id) {
    throw new HavenCliError(`Agent ${id} has no wallet assigned yet — connect it first.`, EXIT.refused)
  }
  const { balances } = await api.get<{ balances: BalanceToken[] }>(
    `/balances/${agent.safe_address}?chain_id=${agent.safe_chain_id}`,
  )
  const wanted = args.flags.token.trim().toUpperCase()
  const token = balances.find((b) => b.symbol.toUpperCase() === wanted)
  if (!token || !token.address) {
    const known = balances.map((b) => b.symbol).join(', ')
    throw new UsageError(`Unknown token ${args.flags.token} on this wallet's chain. Available: ${known || 'none'}`)
  }
  const amount = parseTokenAmount(args.flags.amount, token.decimals, token.symbol)
  if (!amount.ok) throw new UsageError(amount.message)

  const built = await api.post<DelegationBuild>(`/agents/${id}/delegations/build`, {
    token_address: token.address,
    recipient_address: args.flags.recipient ?? null,
    budget_atomic: amount.atomic,
    period_seconds: args.flags.period * 60,
    ...(args.flags.expires !== undefined ? { expires_at: args.flags.expires } : {}),
  })

  const emitGrant = (status?: DelegationRow['status']) =>
    emit(d, args.flags.json, { ...built, agent_id: id, status: status ?? 'pending' }, () =>
      [
        `Budget of ${args.flags.amount} ${token.symbol} per ${args.flags.period} minutes built for agent ${id}.`,
        args.flags.recipient ? `Recipient pin: ${args.flags.recipient}` : null,
        'Open this link and sign — the budget goes live the moment you do:',
        built.signing_url,
        `Delegation: ${built.delegation_hash} (version ${built.version})`,
        status === 'active' ? 'Signed and active.' : 'Waiting for your signature. Run the same command with --wait to poll until it is active.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    )

  emitGrant()
  if (!args.flags.wait) return EXIT.ok

  const deadline = Date.now() + BUDGET_WAIT_TIMEOUT_S * 1000
  while (Date.now() < deadline) {
    await d.sleep(BUDGET_WAIT_INTERVAL_MS)
    const { delegations } = await api.get<{ delegations: DelegationRow[] }>(`/agents/${id}/delegations`)
    const mine = delegations.find((row) => row.delegation_hash === built.delegation_hash)
    if (mine?.status === 'active') {
      emitGrant('active')
      return EXIT.ok
    }
    if (mine?.status === 'revoked' || mine?.status === 'replaced') {
      throw new HavenCliError(
        `Delegation ${built.delegation_hash} is now ${mine.status} without being signed.`,
        EXIT.refused,
      )
    }
  }
  throw new HavenCliError(
    `Timed out waiting for delegation ${built.delegation_hash} to go active (${BUDGET_WAIT_TIMEOUT_S / 60} minutes). The signing link stays valid until it expires — sign it, or rerun with --wait.`,
    EXIT.failed,
  )
}

/**
 * `haven budget revoke` — prepare the revocation, hand the signature to the
 * human (#2539).
 *
 * Calls the per-hash revoke PREPARE route (one sponsored UserOp, unsigned)
 * and prints the revocation link the backend built. Nothing is submitted and
 * no row flips here: the budget keeps working until the owner signs in the
 * dashboard, which is what `--wait` polls for.
 */
async function cmdBudgetRevoke(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const [id, hash] = args.positionals
  if (!id || !hash) throw new UsageError('Usage: haven budget revoke <agentId> <delegationHash> [--wait]')
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new UsageError(`The delegation hash must be 0x followed by 64 hex characters — \`${HASH_DISCOVERY_HINT}\` lists them, or the dashboard.`)
  }

  const { api } = await authed(args, d)
  const { delegations } = await api.get<{ delegations: DelegationRow[] }>(`/agents/${id}/delegations`)
  const row = delegations.find((r) => r.delegation_hash.toLowerCase() === hash.toLowerCase())
  if (!row) {
    throw new HavenCliError(`No delegation ${hash} on agent ${id}.`, EXIT.refused)
  }
  if (row.status === 'revoked') {
    throw new HavenCliError(`Delegation ${hash} is already revoked.`, EXIT.refused)
  }
  if (row.status === 'replaced') {
    throw new HavenCliError(
      `Delegation ${hash} was already replaced by a newer grant — nothing to revoke.`,
      EXIT.refused,
    )
  }

  // PREPARE only: the response carries the unsigned UserOp and the dashboard
  // link. The /submit step stays owner-session-only by design.
  const prepared = await api.post<RevocationPrepare>(`/agents/${id}/delegations/${hash}/revoke`, {})
  const revokeUrl = prepared.revocation_url
  if (!revokeUrl) {
    throw new HavenCliError(
      'The backend did not return a revocation link — it may be older than #2539. Finish the revocation in the dashboard.',
      EXIT.failed,
    )
  }

  const emitRevoke = (status: DelegationRow['status'] | 'pending_revoke') =>
    emit(d, args.flags.json, { agent_id: id, delegation_hash: hash, status, ...prepared }, () =>
      [
        'Revocation prepared — one signature, sponsored (no gas).',
        'Open this link and sign to stop this budget:',
        revokeUrl,
        `Delegation: ${hash}`,
        status === 'revoked' ? 'Revoked.' : 'The budget keeps working until you sign. Run the same command with --wait to poll until it is revoked.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    )

  emitRevoke('pending_revoke')
  if (!args.flags.wait) return EXIT.ok

  const deadline = Date.now() + BUDGET_WAIT_TIMEOUT_S * 1000
  while (Date.now() < deadline) {
    await d.sleep(BUDGET_WAIT_INTERVAL_MS)
    const { delegations: after } = await api.get<{ delegations: DelegationRow[] }>(`/agents/${id}/delegations`)
    const mine = after.find((r) => r.delegation_hash.toLowerCase() === hash.toLowerCase())
    if (mine?.status === 'revoked') {
      emitRevoke('revoked')
      return EXIT.ok
    }
  }
  throw new HavenCliError(
    `Timed out waiting for delegation ${hash} to be revoked (${BUDGET_WAIT_TIMEOUT_S / 60} minutes). The link stays valid — sign it, or rerun with --wait.`,
    EXIT.failed,
  )
}

function resetLabel(mins: number): string {
  if (mins === 0) return 'one-time'
  if (mins === 1440) return 'daily'
  if (mins === 10080) return 'weekly'
  if (mins === 43200) return 'monthly'
  return `every ${mins}m`
}

async function cmdAgentLifecycle(args: ParsedArgs, d: ResolvedDeps, action: 'pause' | 'resume'): Promise<number> {
  const id = args.positionals[0]
  if (!id) throw new UsageError(`Usage: haven agents ${action} <id>`)
  const { api } = await authed(args, d)
  await api.post(`/agents/${id}/${action}`)
  const status = action === 'pause' ? 'paused' : 'resumed'
  emit(d, args.flags.json, { ok: true, agent_id: id, status }, () => `Agent ${id} ${status}.`)
  return EXIT.ok
}

async function cmdAgentRevoke(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) throw new UsageError('Usage: haven agents revoke <id> --yes')
  // Revoke is terminal (status can't go back to active). Require explicit --yes
  // so it can't happen by accident in a script.
  if (!args.flags.yes) {
    throw new UsageError(
      `This permanently revokes agent ${id}.`,
      'Re-run with --yes to confirm. Revoke is terminal — the agent cannot go back to active.',
    )
  }
  const { api } = await authed(args, d)
  await api.post(`/agents/${id}/revoke`)
  emit(
    d,
    args.flags.json,
    { ok: true, agent_id: id, status: 'revoked' },
    () => `Agent ${id} revoked. To also remove its on-chain allowance, use the dashboard.`,
  )
  return EXIT.ok
}

async function cmdAgentRotateKey(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) throw new UsageError('Usage: haven agents rotate-key <id>')
  const { api } = await authed(args, d)
  const res = await api.post<{ api_key: string; api_key_prefix: string }>(`/agents/${id}/rotate-key`)
  // The key is the payload, so it belongs on stdout in both modes. The
  // SENTENCE about it is prose and moves to stderr under --json, which is what
  // keeps stdout a single parseable object with a secret in exactly one field.
  d.o.note('New API key (shown once — store it now; the old key stops working):')
  emit(d, args.flags.json, res, () => res.api_key)
  return EXIT.ok
}

async function cmdAgentRename(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const [id, ...nameParts] = args.positionals
  const name = nameParts.join(' ').trim()
  if (!id || !name) throw new UsageError('Usage: haven agents rename <id> <name>')
  const { api } = await authed(args, d)
  await api.put(`/agents/${id}`, { name })
  emit(d, args.flags.json, { ok: true, agent_id: id, name }, () => `Agent ${id} renamed to "${name}".`)
  return EXIT.ok
}

async function cmdWalletRename(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const [id, ...nameParts] = args.positionals
  const name = nameParts.join(' ').trim()
  if (!id || !name) throw new UsageError('Usage: haven wallets rename <id> <name>')
  const { api } = await authed(args, d)
  await api.put(`/user/safes/${id}`, { name })
  emit(d, args.flags.json, { ok: true, safe_id: id, name }, () => `Wallet ${id} renamed to "${name}".`)
  return EXIT.ok
}

// ── Activity ────────────────────────────────────────────────────────

/**
 * Resolve `--safe` (id or address) to a Safe id for the `/transactions` filter,
 * mirroring `wallets balances`. Throws if `--safe` was given but matches no
 * wallet, so a typo'd filter fails loudly instead of silently returning all rows.
 */
async function resolveSafeId(args: ParsedArgs, api: CliApi): Promise<string | undefined> {
  if (!args.flags.safe) return undefined
  const { safes } = await api.get<{ safes: Safe[] }>('/user/safes')
  const safe = pickSafe(safes, args.flags.safe)
  if (!safe) throw new UsageError(`No wallet matches "${args.flags.safe}".`)
  return safe.id
}

async function cmdActivityList(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const safeId = await resolveSafeId(args, api)
  const params = new URLSearchParams({
    offset: String(args.flags.offset ?? 0),
    limit: String(args.flags.limit ?? 25),
  })
  if (safeId) params.set('safeId', safeId)
  if (args.flags.agent) params.set('agentId', args.flags.agent)
  const { transactions } = await api.get<{ transactions: Txn[] }>(`/transactions?${params.toString()}`)
  const visible = args.flags.direction
    ? transactions.filter((t) => t.direction === args.flags.direction)
    : transactions
  emit(d, args.flags.json, visible, () =>
    visible.length === 0
      ? 'No activity.'
      : table(
          ['DATE', 'DIR', 'AMOUNT', 'TYPE', 'ACCOUNT'],
          visible.map((t) => [
            new Date(t.timestamp * 1000).toISOString().slice(0, 10),
            t.direction === 'in' ? 'in' : 'out',
            `${t.direction === 'in' ? '+' : '-'}${t.valueFormatted} ${t.asset}`,
            t.source ?? 'transfer',
            t.safeName ?? '',
          ]),
        ),
  )
  return EXIT.ok
}

async function cmdActivityExport(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  if (args.flags.format === 'sie') return exportSie(args, d)
  const { api } = await authed(args, d)
  const safeId = await resolveSafeId(args, api)
  const params = new URLSearchParams({
    offset: String(args.flags.offset ?? 0),
    limit: String(args.flags.limit ?? 1000),
  })
  if (safeId) params.set('safeId', safeId)
  if (args.flags.agent) params.set('agentId', args.flags.agent)
  const { transactions } = await api.get<{ transactions: Txn[] }>(`/transactions?${params.toString()}`)
  const visible = args.flags.direction
    ? transactions.filter((t) => t.direction === args.flags.direction)
    : transactions

  // Same columns as the dashboard export (#411), minus counterparty_name
  // (no contacts join in the CLI yet).
  const headers = [
    'date', 'type', 'status', 'direction', 'amount', 'token_symbol', 'token_address',
    'counterparty_address', 'safe_address', 'agent_name', 'tx_hash', 'chain_id',
  ]
  const rows = visible.map((t) => [
    new Date(t.timestamp * 1000).toISOString(),
    exportType(t),
    exportStatus(t),
    t.direction,
    t.valueFormatted,
    t.tokenSymbol ?? t.asset ?? '',
    t.tokenAddress ?? '',
    (t.direction === 'in' ? t.from : t.to) ?? '',
    t.safeAddress ?? '',
    t.agentName ?? '',
    t.hash,
    t.chainId != null ? String(t.chainId) : '',
  ])
  d.o.text(toCsv(headers, rows), { format: 'csv', rows: rows.length })
  return EXIT.ok
}

function exportType(t: Txn): string {
  if (t.activityType === 'delegate_sweep') return 'allowance funding'
  if (t.source === 'x402') return 'x402'
  if (t.source === 'mpp_demo') return 'mpp'
  return t.direction === 'in' ? 'receive' : 'send'
}

function exportStatus(t: Txn): string {
  if (t.isError) return 'failed'
  if (t.paymentFlowStatus === 'confirming_merchant') return 'pending'
  return 'executed'
}

/** SIE 4I export: the backend builds the verifikat file (book-time SEK + BAS). */
async function exportSie(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const params = new URLSearchParams({ format: 'sie' })
  if (args.flags.from) params.set('from', args.flags.from)
  if (args.flags.to) params.set('to', args.flags.to)
  if (args.flags.company) params.set('company', args.flags.company)
  const content = await api.getText(`/accounting/export?${params.toString()}`)
  d.o.text(content, { format: 'sie' })
  return EXIT.ok
}

// ── Catalog ─────────────────────────────────────────────────────────

async function cmdCatalogList(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const { entries } = await api.get<{ entries: CatalogEntry[] }>('/catalog')
  emit(d, args.flags.json, entries, () =>
    entries.length === 0
      ? 'Catalog is empty.'
      : table(
          ['NAME', 'CATEGORY', 'RAIL', 'PRICE', 'STATUS'],
          entries.map((e) => [e.name, e.category, e.rail, e.price_display ?? '—', e.status]),
        ),
  )
  return EXIT.ok
}


// ── Connect (#2527) ─────────────────────────────────────────────────

/**
 * Resolve the wallet this setup belongs to, and the token's decimals.
 *
 * The decimals are READ from the backend rather than kept in a table here.
 * `GET /balances/:safeAddress` lists every token the chain is configured for —
 * zero balance included — with its address and decimals, which is the same
 * registry the dashboard modal reads. A local table would be a second source
 * of truth for a number that decides a budget's magnitude, and it would drift
 * silently the first time a chain gained a token.
 */
async function resolveWalletAndToken(
  args: ParsedArgs,
  api: CliApi,
  symbol: string,
): Promise<{ safeId: string; token: BalanceToken }> {
  const { safes } = await api.get<{ safes: Safe[] }>('/user/safes')
  if (safes.length === 0) {
    throw new HavenCliError('No wallet on this account yet — finish onboarding first.', EXIT.refused)
  }
  const safe = args.flags.safe
    ? safes.find((s) => s.id === args.flags.safe || s.safe_address === args.flags.safe)
    : (safes.find((s) => s.is_default) ?? safes[0])
  if (!safe) throw new UsageError(`No wallet matches --safe ${args.flags.safe}`)

  // `chain_id` is REQUIRED here, not decorative. The same account address is
  // provisioned on every supported chain, so a wallet address usually owns more
  // than one ownership row — and `GET /balances/:address` answers
  // `400 chain_id required` rather than guessing when it finds more than one
  // (`routes/balances.ts`). `wallets balances` has always passed it; this call
  // omitted it and would have failed for exactly the ordinary multi-chain
  // account (haven-reviewer, #2527).
  const { balances } = await api.get<{ balances: BalanceToken[] }>(
    `/balances/${safe.safe_address}?chain_id=${safe.chain_id}`,
  )
  const wanted = symbol.trim().toUpperCase()
  const token = balances.find((b) => b.symbol.toUpperCase() === wanted)
  if (!token) {
    const known = balances.map((b) => b.symbol).join(', ')
    throw new UsageError(`Unknown token ${symbol} on this wallet's chain. Available: ${known || 'none'}`)
  }
  return { safeId: safe.id, token }
}

/** Poll a setup until it leaves the states that are still in flight. */
const SETTLED = new Set(['active', 'expired', 'cancelled', 'failed'])

async function pollSetup(
  api: CliApi,
  setupId: string,
  d: ResolvedDeps,
  wait: boolean,
): Promise<SetupStatus> {
  let status = await api.get<SetupStatus>(`/agent-connection-setups/${setupId}`)
  if (!wait) return status
  // Bounded by the setup's own expiry rather than a local guess, so the loop
  // cannot outlive the thing it is watching.
  const deadline = new Date(status.expires_at).getTime()
  while (!SETTLED.has(status.status) && Date.now() < deadline) {
    await d.sleep(5000)
    status = await api.get<SetupStatus>(`/agent-connection-setups/${setupId}`)
  }
  return status
}

/**
 * `haven agents connect` — the connect flow without the dashboard modal.
 *
 * Three shapes: create a setup, `--status <id>` to read one, and `--run` to
 * additionally execute the connector command the backend printed.
 *
 * The command is PRINTED, never composed. `connector_command` comes back from
 * `POST /agent-connection-setups` and is emitted verbatim, which is what makes
 * it byte-identical to the dashboard's for the same setup — they are the same
 * string from the same builder, not two constructions that have to be kept in
 * agreement.
 */
async function cmdAgentsConnect(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)

  if (args.flags.status) {
    const status = await pollSetup(api, args.flags.status, d, args.flags.wait)
    emit(d, args.flags.json, status, () =>
      [
        `setup ${status.setup_id}: ${status.status}`,
        status.agent_id ? `agent: ${status.agent_id}` : null,
        SETTLED.has(status.status) ? null : `approve: ${status.approval_url}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    return EXIT.ok
  }

  const name = args.flags.name?.trim()
  if (!name) throw new UsageError('Usage: haven agents connect --name <name> --budget <amount> --token USDC --period <minutes>')
  if (!args.flags.budget || !args.flags.token || args.flags.period === undefined) {
    throw new UsageError('--budget, --token and --period are required (period is whole minutes; 0 means one-time)')
  }

  const { safeId, token } = await resolveWalletAndToken(args, api, args.flags.token)
  const amount = parseTokenAmount(args.flags.budget, token.decimals, token.symbol)
  if (!amount.ok) throw new UsageError(amount.message)

  const setup = await api.post<CreateSetupResponse>('/agent-connection-setups', {
    name,
    safe_id: safeId,
    allowances: [
      {
        token_address: token.address ?? '0x0000000000000000000000000000000000000000',
        token_symbol: token.symbol,
        // ATOMIC on the way in, human on the way back (#2295). Converted here
        // exactly once, from the decimals the backend just told us.
        allowance_amount: amount.atomic,
        reset_period_min: args.flags.period,
      },
    ],
    // How this setup was made, for connect attribution (#2302). The route
    // already accepts any slug, so nothing backend-side had to change.
    source: 'cli',
    // #2522: the hand-off marker, set only when an agent is driving this CLI
    // and says so. Never inferred — a guess here mislabels a human's own run.
    ...(d.env.HAVEN_AGENT_DRIVEN === '1' ? { via: 'agent' } : {}),
  })

  if (!args.flags.run) {
    emit(d, args.flags.json, setup, () =>
      [
        'Run this where the agent runs:',
        '',
        setup.connector_command,
        '',
        `Then approve the budget: ${setup.approval_url}`,
        `Setup ${setup.setup_id} expires ${setup.expires_at}.`,
      ].join('\n'),
    )
    return EXIT.ok
  }

  // `--run`: execute the printed command with `--json` appended and nothing
  // else changed. The connector's stderr is streamed as it arrives — a run can
  // take minutes and that is the only progress anyone sees.
  const run = await runConnector(setup.connector_command, d.spawner, (chunk) => d.err(chunk.trimEnd()))
  const relay = relayLine(run.outcome)
  const merged = {
    setup_id: setup.setup_id,
    approval_url: setup.approval_url,
    connector_command: setup.connector_command,
    connector_exit_code: run.exitCode,
    outcome: run.outcome,
    relay,
  }

  if (isRefusal(run.outcome)) {
    // Exit 4 with the refusal carried whole. Recognised by the presence of
    // `error`, never by matching a code — a refusal the connector adds later
    // reaches the user through this same path with no CLI change.
    emitConnectResult(d, args.flags.json, merged, relay)
    return EXIT.refused
  }
  if (!run.outcome) {
    throw new HavenCliError(
      `The connector produced no outcome (exit ${run.exitCode}).${run.stdoutNoise ? ` Output: ${run.stdoutNoise}` : ''}`,
      run.exitCode === 0 ? EXIT.failed : EXIT.failed,
    )
  }
  emitConnectResult(d, args.flags.json, merged, relay)
  return EXIT.ok
}

/**
 * Print a `--run` result with the relay line FIRST under prose (#2483's
 * one-gate rule): whatever the human has to act on outranks the record of what
 * happened, because a link buried under an outcome dump is a link nobody sees.
 */
function emitConnectResult(
  d: ResolvedDeps,
  json: boolean,
  merged: { relay: string | null; outcome: ConnectorOutcome | null; setup_id: string },
  relay: string | null,
): void {
  emit(d, json, merged, () =>
    [relay, relay ? '' : null, `setup ${merged.setup_id}: ${merged.outcome?.outcome ?? 'unknown'}`]
      .filter((line) => line !== null)
      .join('\n'),
  )
}

// ── Contacts ────────────────────────────────────────────────────────

async function cmdContactsList(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const { contacts } = await api.get<{ contacts: Contact[] }>('/contacts')
  emit(d, args.flags.json, contacts, () =>
    contacts.length === 0
      ? 'No contacts yet.'
      : table(['ID', 'NAME', 'ADDRESS'], contacts.map((c) => [c.id, c.name, truncateAddress(c.address)])),
  )
  return EXIT.ok
}

async function cmdContactsAdd(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const [address, ...nameParts] = [...args.positionals].reverse()
  // positionals are <name...> <address>; address is last, name is the rest.
  const name = nameParts.reverse().join(' ').trim()
  if (!name || !address) throw new UsageError('Usage: haven contacts add <name> <address>')
  const { api } = await authed(args, d)
  const contact = await api.post<Contact>('/contacts', { name, address })
  emit(d, args.flags.json, contact, () => `Added contact "${contact.name}" (${truncateAddress(contact.address)}).`)
  return EXIT.ok
}

async function cmdContactsRemove(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) throw new UsageError('Usage: haven contacts remove <id>')
  const { api } = await authed(args, d)
  await api.del(`/contacts/${id}`)
  emit(d, args.flags.json, { ok: true, contact_id: id, removed: true }, () => `Contact ${id} removed.`)
  return EXIT.ok
}
