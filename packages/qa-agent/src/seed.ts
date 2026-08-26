/**
 * QA dev-identity seed (epic #573, #574 item 1; re-based on the delegation
 * rail by #2007, epic #1440).
 *
 * Idempotently provisions the dedicated QA identity on **Base Sepolia (84532)**
 * against the shared dev backend, so the money-flow harness (#575) has a real
 * agent with real on-chain spend authority to run against:
 *
 *   1. QA user     — POST /auth/signup (falls back to /auth/login)
 *   2. QA account  — Hybrid DeleGator via POST /accounts/hybrid
 *                    (counterfactual, ZERO transactions, owner = SEED_OWNER)
 *   3. QA agent    — POST /agents with the delegate address
 *   4. Budget      — POST /agents/:id/delegations/build → owner signs the
 *                    EIP-712 payload → POST …/activate
 *
 * It then prints the `QA_*` env block (#574 secrets) for the harness.
 *
 * ── Why this no longer seeds a Safe (#2007) ──────────────────────────────────
 * It used to deploy an EOA-owned Safe and register it with `POST /user/safes`,
 * then enable the AllowanceModule and set an on-chain allowance. Every part of
 * that is gone:
 *
 *   - `POST /user/safes` has answered **HTTP 410** since #1984 — the Safe rail's
 *     inflow is closed, so no new Safe can enter Haven at all;
 *   - `execution_rail='allowance_module'` accounts answer **410** from
 *     /payments and x402 since #1986, so a seeded Safe could not pay even if
 *     one could still be created.
 *
 * The breakage was invisible because `ensureSafe()` short-circuited on an
 * already-linked Safe: the dead call sat behind a reuse branch and only fired
 * for a **fresh** QA account — which is precisely the case a database reset or
 * a new environment produces, and `qa-dev` feeds the `qa-freshness` gate on
 * `dev → main`.
 *
 * ⚠️ **Read the account list from `/auth/me`, never `GET /user/safes`.** That
 * route's projection has no `account_type` column, so it cannot tell a retired
 * Safe from a Hybrid account — a reuse check written against it would happily
 * adopt the QA user's existing dead Safe and reintroduce the same hidden
 * precondition one layer down. `/auth/me` carries `account_type`, which is what
 * makes the reuse branch here honest.
 *
 * ── Funding model ────────────────────────────────────────────────────────────
 *   - The **Hybrid account** holds the spendable test **USDC** (fund via the
 *     Circle faucet). Payments move account → recipient DIRECTLY; there is no
 *     funding leg and no delegate hot balance on this rail.
 *   - The dev **relayer** sponsors the UserOps, including the counterfactual
 *     account's first deployment.
 *   - **SEED_OWNER needs no ETH.** Provisioning is counterfactual and the grant
 *     is a signature, not a transaction — this seed sends nothing on-chain and
 *     opens no RPC connection.
 *
 * Everything is testnet/dev-only — never a production credential.
 *
 * Run:  npm run seed -w packages/qa-agent
 */

import { ethers } from 'ethers'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Base Sepolia (84532) constants ───────────────────────────────────────────
// Source of truth: `@haven_ai/core`'s chain registry. Mirrored here to keep this
// package self-contained.
const CHAIN_ID = 84532
const ADDR = {
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const
const USDC_DECIMALS = 6

/** The rail marker a Hybrid DeleGator account carries in `user_safes`. */
const HYBRID_ACCOUNT_TYPE = 'delegator_hybrid'

// ── Config ───────────────────────────────────────────────────────────────────
export interface SeedConfig {
  apiUrl: string
  ownerKey: string
  delegateAddress: string
  paymentTo: string
  qaEmail: string
  qaPassword: string
  budgetUsdc: string
  periodMin: number
}

function loadSeedConfig(env: NodeJS.ProcessEnv = process.env): SeedConfig {
  const missing: string[] = []
  const req = (name: string): string => {
    const v = env[name]?.trim()
    if (!v) missing.push(name)
    return v ?? ''
  }
  const cfg: SeedConfig = {
    apiUrl: req('SEED_HAVEN_API_URL').replace(/\/+$/, ''),
    ownerKey: req('SEED_OWNER_PRIVATE_KEY'),
    delegateAddress: req('SEED_DELEGATE_ADDRESS'),
    paymentTo: req('SEED_PAYMENT_TO'),
    qaEmail: req('SEED_QA_EMAIL'),
    qaPassword: req('SEED_QA_PASSWORD'),
    // Names kept from the AllowanceModule era so an existing operator env keeps
    // working; on the delegation rail they mean the delegation's period budget
    // and its period length.
    budgetUsdc: env.SEED_ALLOWANCE_USDC?.trim() || '5',
    periodMin: Number(env.SEED_RESET_MIN?.trim() || '1440'),
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required seed env: ${missing.join(', ')}. ` +
        `All values are testnet/dev-only — see docs/operations/agent-qa.md.`,
    )
  }
  if (!ethers.isAddress(cfg.delegateAddress)) {
    throw new Error(`SEED_DELEGATE_ADDRESS is not a valid address: ${cfg.delegateAddress}`)
  }
  if (!ethers.isAddress(cfg.paymentTo)) {
    throw new Error(`SEED_PAYMENT_TO is not a valid address: ${cfg.paymentTo}`)
  }
  if (!Number.isFinite(cfg.periodMin) || cfg.periodMin <= 0) {
    throw new Error(`SEED_RESET_MIN must be a positive number of minutes: ${cfg.periodMin}`)
  }
  return cfg
}

// ── Backend HTTP helper (Node → API, server-to-server, no CORS) ──────────────
async function api<T>(
  cfg: SeedConfig,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${text}`) as Error & {
      status: number
      json: unknown
    }
    err.status = res.status
    err.json = json
    throw err
  }
  return json as T
}

// ── Phase 1: QA user (signup, fall back to login) ────────────────────────────
async function ensureUser(cfg: SeedConfig): Promise<string> {
  try {
    const r = await api<{ token: string }>(cfg, 'POST', '/auth/signup', {
      body: { name: 'QA Bot', email: cfg.qaEmail, password: cfg.qaPassword },
    })
    console.log('  ✓ created QA user')
    return r.token
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status !== 409) throw e
    const r = await api<{ token: string }>(cfg, 'POST', '/auth/login', {
      body: { email: cfg.qaEmail, password: cfg.qaPassword },
    })
    console.log('  ✓ QA user exists — logged in')
    return r.token
  }
}

// ── Phase 2: QA account (Hybrid DeleGator on the delegation rail) ────────────
interface SessionSafe {
  id: string
  safe_address: string
  chain_id: number
  account_type: string | null
}

/** The account list as `/auth/me` reports it — the only projection with a rail marker. */
async function listAccounts(cfg: SeedConfig, token: string): Promise<SessionSafe[]> {
  const me = await api<{ safes?: SessionSafe[] }>(cfg, 'GET', '/auth/me', { token })
  return me.safes ?? []
}

function findHybrid(accounts: SessionSafe[]): SessionSafe | undefined {
  return accounts.find((s) => s.account_type === HYBRID_ACCOUNT_TYPE && s.chain_id === CHAIN_ID)
}

async function ensureAccount(
  cfg: SeedConfig,
  token: string,
  owner: ethers.Wallet,
): Promise<SessionSafe> {
  const existing = findHybrid(await listAccounts(cfg, token))
  if (existing) {
    console.log(`  ✓ reusing Hybrid account ${existing.safe_address}`)
    return existing
  }

  console.log('  • provisioning a Hybrid DeleGator account (counterfactual, no transaction)…')
  await api(cfg, 'POST', '/accounts/hybrid', {
    token,
    body: { chain_id: CHAIN_ID, owner_address: owner.address, name: 'QA Account' },
  })

  const account = findHybrid(await listAccounts(cfg, token))
  if (!account) {
    throw new Error('Provisioned Hybrid account did not appear in /auth/me')
  }
  console.log(`  ✓ Hybrid account provisioned: ${account.safe_address}`)
  return account
}

// ── Phase 3: QA agent (reuse if one already maps to this delegate) ───────────
interface Agent {
  id: string
  name: string
  delegate_address: string | null
  status: string | null
}

const REUSABLE_AGENT_STATUSES = new Set(['active', 'pending_approval'])

/**
 * Reuse only an agent whose current status is explicitly safe for the QA seed.
 * A delegate address is spending authority, so a revoked (or unknown-status)
 * row must never be silently bypassed by creating a new agent with that key.
 */
export async function findReusableAgent(
  cfg: SeedConfig,
  token: string,
): Promise<Agent | undefined> {
  const { agents } = await api<{ agents: Agent[] }>(cfg, 'GET', '/agents', { token })
  const matchingDelegate = agents.filter(
    (a) => a.delegate_address?.toLowerCase() === cfg.delegateAddress.toLowerCase(),
  )
  const disallowed = matchingDelegate.find((a) => !REUSABLE_AGENT_STATUSES.has(a.status ?? ''))
  if (disallowed) {
    const status = disallowed.status ?? 'missing'
    throw new Error(
      `QA agent ${disallowed.id} for SEED_DELEGATE_ADDRESS ${cfg.delegateAddress} has status ${JSON.stringify(status)}. ` +
        'Refusing to reuse or create an agent with this delegate address. Rotate SEED_DELEGATE_ADDRESS, ' +
        `or deliberately un-revoke (or otherwise restore) agent ${disallowed.id} before re-running the seed.`,
    )
  }

  return matchingDelegate[0]
}

async function ensureAgent(
  cfg: SeedConfig,
  token: string,
  account: SessionSafe,
  existing: Agent | undefined,
): Promise<{ agentId: string; apiKey: string | null }> {
  if (existing) {
    console.log(`  ✓ QA agent already exists (${existing.id}) — api key not re-shown`)
    return { agentId: existing.id, apiKey: null }
  }
  const created = await api<{ id?: string; api_key?: string; secret?: string }>(
    cfg,
    'POST',
    '/agents',
    {
      token,
      body: {
        name: 'QA Agent',
        description: 'Automated QA harness identity (epic #573). Testnet-only.',
        delegate_address: cfg.delegateAddress,
        safe_id: account.id,
        // #2020: no `allowances` — POST /agents refuses a non-empty array now
        // that the mirror is retired. The comment this replaced already said
        // the row was vestigial; the authority that matters is the delegation
        // granted in phase 4.
      },
    },
  )
  if (!created.id) throw new Error('POST /agents did not return an agent id')
  console.log('  ✓ QA agent created')
  return { agentId: created.id, apiKey: created.api_key ?? created.secret ?? null }
}

// ── Phase 4: budget delegation (build → owner signs → activate) ──────────────
// The agent's spend authority. Budget, recipient and expiry are enforced
// ON-CHAIN by the caveat enforcers during redemption; Haven never holds the
// signing key, so the owner signs the EIP-712 payload locally here.
interface TypedDataPayload {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  message: Record<string, unknown>
}

interface DelegationRow {
  chain_id: number
  token_address: string | null
  status: string
  budget_atomic: string | null
}

async function ensureBudget(
  cfg: SeedConfig,
  token: string,
  agentId: string,
  budgetAtomic: string,
): Promise<void> {
  const { delegations } = await api<{ delegations: DelegationRow[] }>(
    cfg,
    'GET',
    `/agents/${agentId}/delegations`,
    { token },
  )
  const active = delegations.find(
    (d) =>
      d.status === 'active' &&
      d.chain_id === CHAIN_ID &&
      d.token_address?.toLowerCase() === ADDR.usdc.toLowerCase() &&
      d.budget_atomic === budgetAtomic,
  )
  if (active) {
    console.log('  ✓ active USDC budget delegation already granted — skipping')
    return
  }

  const built = await api<{
    delegation_hash?: string
    signing_payload?: TypedDataPayload
  }>(cfg, 'POST', `/agents/${agentId}/delegations/build`, {
    token,
    body: {
      token_address: ADDR.usdc,
      // Open (unpinned) budget: the EIP-3009 bridge leg structurally requires
      // one — a recipient-pinned delegation cannot fund the delegate EOA
      // (owner decision 2026-07-15).
      recipient_address: null,
      budget_atomic: budgetAtomic,
      period_seconds: cfg.periodMin * 60,
    },
  })
  if (!built.delegation_hash || !built.signing_payload) {
    throw new Error('delegations/build did not return a signable payload')
  }

  const owner = new ethers.Wallet(cfg.ownerKey)
  const { domain, types, message } = built.signing_payload
  const signable = Object.fromEntries(
    Object.entries(types).filter(([name]) => name !== 'EIP712Domain'),
  )
  const signature = await owner.signTypedData(
    domain as never,
    signable as never,
    message as never,
  )

  await api(cfg, 'POST', `/agents/${agentId}/delegations/${built.delegation_hash}/activate`, {
    token,
    body: { signature },
  })
  console.log(
    `  ✓ budget granted: ${cfg.budgetUsdc} USDC per ${cfg.periodMin} min (delegation ${built.delegation_hash})`,
  )
}

// ── Orchestration ────────────────────────────────────────────────────────────
export async function main(): Promise<void> {
  const cfg = loadSeedConfig()
  const owner = new ethers.Wallet(cfg.ownerKey)
  const budgetAtomic = ethers.parseUnits(cfg.budgetUsdc, USDC_DECIMALS).toString()

  console.log(`Seeding QA identity on Base Sepolia → ${cfg.apiUrl}`)
  console.log(`  owner ${owner.address}  (no ETH needed — nothing here is sent on-chain)`)

  console.log('\n[1/4] QA user')
  const token = await ensureUser(cfg)
  // Check the all-status agent list before provisioning a Hybrid account. A
  // revoked or otherwise non-usable delegate must not trigger any account,
  // agent, or delegation write while the seed is refusing to restore authority.
  const existingAgent = await findReusableAgent(cfg, token)
  console.log('\n[2/4] QA account (Hybrid DeleGator, delegation rail)')
  const account = await ensureAccount(cfg, token, owner)
  console.log('\n[3/4] QA agent')
  const { agentId, apiKey } = await ensureAgent(cfg, token, account, existingAgent)
  console.log('\n[4/4] Budget delegation')
  await ensureBudget(cfg, token, agentId, budgetAtomic)

  console.log('\n─── QA env (set as #574 secrets — testnet/dev-only) ───')
  console.log(`QA_HAVEN_API_URL=${cfg.apiUrl}`)
  console.log(`QA_PAYMENT_TO=${cfg.paymentTo}`)
  console.log(
    'QA_DELEGATION_DELEGATE_PRIVATE_KEY=<the delegate key for ' + cfg.delegateAddress + '>',
  )
  if (apiKey) {
    console.log(`QA_DELEGATION_AGENT_API_KEY=${apiKey}`)
  } else {
    console.log(
      'QA_DELEGATION_AGENT_API_KEY=<unchanged — agent already existed; rotate via dashboard if lost>',
    )
  }
  console.log(
    '\nThe QA harness uses the delegation identity above. It does not require\n' +
      'legacy AllowanceModule credentials (`QA_AGENT_API_KEY` or\n' +
      '`QA_DELEGATE_PRIVATE_KEY`).',
  )
  console.log('\nAccount (fund with Base Sepolia USDC): ' + account.safe_address)
  console.log('Done.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('\n✗ seed failed:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
}
