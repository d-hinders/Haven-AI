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
const DEFAULT_API = 'https://havenbackend-production-8a00.up.railway.app'
// Self-reported CLI version. Owned by scripts/release-bump.mjs, which rewrites
// the string literal below on every release — keep it a bare quoted literal.
export const CLI_VERSION = '0.1.34-alpha.0'

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
  'wallets list', 'wallets balances', 'wallets rename',
  'agents list', 'agents show', 'agents pause', 'agents resume', 'agents revoke',
  'agents rotate-key', 'agents rename', 'agents connect',
  'budget show',
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
    case 'agents list': return cmdAgentsList(args, d)
    case 'agents show': return cmdAgentsShow(args, d)
    case 'agents connect': return cmdAgentsConnect(args, d)
    case 'agents pause': return cmdAgentLifecycle(args, d, 'pause')
    case 'agents resume': return cmdAgentLifecycle(args, d, 'resume')
    case 'agents revoke': return cmdAgentRevoke(args, d)
    case 'agents rotate-key': return cmdAgentRotateKey(args, d)
    case 'agents rename': return cmdAgentRename(args, d)
    case 'budget show': return cmdBudgetShow(args, d)
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
  // link on while the poll runs.
  d.o.data(
    {
      ok: true,
      verification_url: start.verification_url,
      user_code: start.user_code,
      expires_at: new Date(deadline).toISOString(),
    },
    () =>
      `Open ${start.verification_url}\nand approve the code ${start.user_code}.\n` +
      `It expires in ${Math.round(start.expires_in / 60)} minutes.`,
  )

  if (args.flags.noWait) return EXIT.ok

  // The server names the interval; the client does not invent one. `slow_down`
  // widens it, which is the only backoff signal this flow has.
  let interval = start.interval * 1000
  for (;;) {
    if (Date.now() >= deadline) {
      throw new HavenCliError('The code expired before it was approved.', EXIT.notAuthenticated)
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

async function cmdLogin(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
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

async function cmdBudgetShow(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) throw new UsageError('Usage: haven budget show <agentId>')
  const { api } = await authed(args, d)
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

  const { balances } = await api.get<{ balances: BalanceToken[] }>(`/balances/${safe.safe_address}`)
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
