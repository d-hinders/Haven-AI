import { parseArgs, helpText, type ParsedArgs } from './args.js'
import { createCliApi, CliApiError, type CliApi } from './api.js'
import { createSessionStore, type Session, type SessionStore } from './session.js'
import { chainName, table, truncateAddress } from './format.js'
import { toCsv } from './csv.js'

// Hosted Haven backend. Override with `--api <url>` or HAVEN_API_URL (e.g. a
// local backend at http://localhost:3001, or your own domain once self-hosted).
const DEFAULT_API = 'https://havenbackend-production-8a00.up.railway.app'
// Self-reported CLI version. Owned by scripts/release-bump.mjs, which rewrites
// the string literal below on every release — keep it a bare quoted literal.
export const CLI_VERSION = '0.1.17-alpha.0'

export interface RunDeps {
  sessionStore?: SessionStore
  /** Build an API client; injected so tests can stub the backend. */
  makeApi?: (baseUrl: string, token?: string) => CliApi
  promptPassword?: () => Promise<string>
  out?: (line: string) => void
  err?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

interface ResolvedDeps {
  sessionStore: SessionStore
  makeApi: (baseUrl: string, token?: string) => CliApi
  promptPassword: () => Promise<string>
  out: (line: string) => void
  err: (line: string) => void
  env: NodeJS.ProcessEnv
}

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

/** Entry point. Returns a process exit code; never throws for expected errors. */
export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const d: ResolvedDeps = {
    sessionStore: deps.sessionStore ?? createSessionStore(),
    makeApi: deps.makeApi ?? ((baseUrl, token) => createCliApi({ baseUrl, token })),
    promptPassword: deps.promptPassword ?? (() => Promise.reject(new Error('No password input available'))),
    out: deps.out ?? ((l) => process.stdout.write(`${l}\n`)),
    err: deps.err ?? ((l) => process.stderr.write(`${l}\n`)),
    env: deps.env ?? process.env,
  }

  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    d.err(e instanceof Error ? e.message : String(e))
    return 1
  }

  if (args.flags.version) {
    d.out(CLI_VERSION)
    return 0
  }
  if (args.flags.help || !args.command) {
    d.out(helpText())
    return 0
  }

  try {
    return await dispatch(args, d)
  } catch (e) {
    if (e instanceof CliApiError) {
      d.err(e.message)
      return e.status === 401 ? 2 : 1
    }
    d.err(e instanceof Error ? e.message : String(e))
    return 1
  }
}

async function dispatch(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const key = args.sub ? `${args.command} ${args.sub}` : args.command
  switch (key) {
    case 'login': return cmdLogin(args, d)
    case 'logout': return cmdLogout(d)
    case 'whoami': return cmdWhoami(args, d)
    case 'wallets list': return cmdWalletsList(args, d)
    case 'wallets balances': return cmdWalletsBalances(args, d)
    case 'agents list': return cmdAgentsList(args, d)
    case 'agents show': return cmdAgentsShow(args, d)
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
      d.err(`Unknown command: ${key}. Run \`haven --help\`.`)
      return 1
  }
}

function baseUrlFor(args: ParsedArgs, d: ResolvedDeps, session: Session | null): string {
  return args.flags.api ?? session?.apiBaseUrl ?? d.env.HAVEN_API_URL ?? DEFAULT_API
}

async function authed(args: ParsedArgs, d: ResolvedDeps): Promise<{ session: Session; api: CliApi }> {
  const session = await d.sessionStore.load()
  if (!session) throw new CliApiError('Not authenticated. Run `haven login` first.', 401)
  return { session, api: d.makeApi(baseUrlFor(args, d, session), session.token) }
}

function emit(d: ResolvedDeps, json: boolean, data: unknown, human: () => string): void {
  d.out(json ? JSON.stringify(data, null, 2) : human())
}

// ── Auth ────────────────────────────────────────────────────────────

async function cmdLogin(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const email = args.flags.email ?? d.env.HAVEN_EMAIL
  if (!email) {
    d.err('Provide an email with --email (or HAVEN_EMAIL).')
    return 1
  }
  const password = d.env.HAVEN_PASSWORD ?? (await d.promptPassword())
  if (!password) {
    d.err('A password is required.')
    return 1
  }
  const baseUrl = baseUrlFor(args, d, null)
  const api = d.makeApi(baseUrl)
  const res = await api.post<{ token: string; user: Session['user'] }>('/auth/login', { email, password })
  await d.sessionStore.save({ token: res.token, apiBaseUrl: baseUrl, user: res.user })
  emit(d, args.flags.json, { user: res.user, apiBaseUrl: baseUrl }, () => `Signed in as ${res.user.email}.`)
  return 0
}

async function cmdLogout(d: ResolvedDeps): Promise<number> {
  await d.sessionStore.clear()
  d.out('Signed out.')
  return 0
}

async function cmdWhoami(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const user = await api.get<Session['user']>('/auth/me')
  emit(d, args.flags.json, user, () => `${user.email}${user.name ? ` (${user.name})` : ''}`)
  return 0
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
  return 0
}

async function cmdWalletsBalances(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const { api } = await authed(args, d)
  const { safes } = await api.get<{ safes: Safe[] }>('/user/safes')
  const safe = pickSafe(safes, args.flags.safe)
  if (!safe) {
    d.err(args.flags.safe ? `No wallet matches "${args.flags.safe}".` : 'No Haven wallet found.')
    return 1
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
  return 0
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
  return 0
}

async function cmdAgentsShow(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) { d.err('Usage: haven agents show <id>'); return 1 }
  const { api } = await authed(args, d)
  const agent = await api.get<Agent>(`/agents/${id}`)
  emit(d, args.flags.json, agent, () =>
    [
      `${agent.name}  [${agent.status}]`,
      `id: ${agent.id}`,
      `budget: ${budgetSummary(agent.allowances)}`,
    ].join('\n'),
  )
  return 0
}

async function cmdBudgetShow(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) { d.err('Usage: haven budget show <agentId>'); return 1 }
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
  return 0
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
  if (!id) { d.err(`Usage: haven agents ${action} <id>`); return 1 }
  const { api } = await authed(args, d)
  await api.post(`/agents/${id}/${action}`)
  d.out(`Agent ${id} ${action === 'pause' ? 'paused' : 'resumed'}.`)
  return 0
}

async function cmdAgentRevoke(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) { d.err('Usage: haven agents revoke <id> --yes'); return 1 }
  // Revoke is terminal (status can't go back to active). Require explicit --yes
  // so it can't happen by accident in a script.
  if (!args.flags.yes) {
    d.err(`This permanently revokes agent ${id}. Re-run with --yes to confirm.`)
    return 1
  }
  const { api } = await authed(args, d)
  await api.post(`/agents/${id}/revoke`)
  d.out(`Agent ${id} revoked. To also remove its on-chain allowance, use the dashboard.`)
  return 0
}

async function cmdAgentRotateKey(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) { d.err('Usage: haven agents rotate-key <id>'); return 1 }
  const { api } = await authed(args, d)
  const res = await api.post<{ api_key: string; api_key_prefix: string }>(`/agents/${id}/rotate-key`)
  if (args.flags.json) {
    d.out(JSON.stringify(res, null, 2))
  } else {
    d.out('New API key (shown once — store it now; the old key stops working):')
    d.out(res.api_key)
  }
  return 0
}

async function cmdAgentRename(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const [id, ...nameParts] = args.positionals
  const name = nameParts.join(' ').trim()
  if (!id || !name) { d.err('Usage: haven agents rename <id> <name>'); return 1 }
  const { api } = await authed(args, d)
  await api.put(`/agents/${id}`, { name })
  d.out(`Agent ${id} renamed to "${name}".`)
  return 0
}

async function cmdWalletRename(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const [id, ...nameParts] = args.positionals
  const name = nameParts.join(' ').trim()
  if (!id || !name) { d.err('Usage: haven wallets rename <id> <name>'); return 1 }
  const { api } = await authed(args, d)
  await api.put(`/user/safes/${id}`, { name })
  d.out(`Wallet ${id} renamed to "${name}".`)
  return 0
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
  if (!safe) throw new CliApiError(`No wallet matches "${args.flags.safe}".`, 1)
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
  return 0
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
  d.out(toCsv(headers, rows))
  return 0
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
  d.out(content)
  return 0
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
  return 0
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
  return 0
}

async function cmdContactsAdd(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const [address, ...nameParts] = [...args.positionals].reverse()
  // positionals are <name...> <address>; address is last, name is the rest.
  const name = nameParts.reverse().join(' ').trim()
  if (!name || !address) { d.err('Usage: haven contacts add <name> <address>'); return 1 }
  const { api } = await authed(args, d)
  const contact = await api.post<Contact>('/contacts', { name, address })
  emit(d, args.flags.json, contact, () => `Added contact "${contact.name}" (${truncateAddress(contact.address)}).`)
  return 0
}

async function cmdContactsRemove(args: ParsedArgs, d: ResolvedDeps): Promise<number> {
  const id = args.positionals[0]
  if (!id) { d.err('Usage: haven contacts remove <id>'); return 1 }
  const { api } = await authed(args, d)
  await api.del(`/contacts/${id}`)
  d.out(`Contact ${id} removed.`)
  return 0
}
