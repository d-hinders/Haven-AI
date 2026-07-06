/**
 * #769 live proof — enable a pre-signed budget SCHEDULE on Base Sepolia with
 * ONE owner signature, then prove the cross-period rollover through the
 * production API with NO further owner action.
 *
 * Determinism contract: the backend's lazy rollover (session-schedule-
 * wiring.ts) recomputes the schedule from what the DB stores — the REAL agent
 * UUID, `agents.delegate_address`, the `agent_recipients` row's resolved
 * budget, and `agent_allowances.reset_period_min`. This script builds the
 * on-chain schedule from the SAME inputs, so the recomputation matches
 * bit-for-bit. Change one input on either side and the permissionIds diverge —
 * that is the fail-closed design, not a bug.
 *
 * DB wiring is done OVER THE API (#798): the script logs in to the dev
 * backend, resolves the agent by delegate address, upserts the recipient
 * (#796 CRUD), aligns reset_period_min (preserving the allowance amount), and
 * records the window via schedule/confirm — zero manual SQL. If any API step
 * fails, the equivalent SQL block is printed as the fallback so the proof can
 * still proceed by hand.
 *
 * Proof sequence (printed at the end):
 *   1. pay in period N through the API (uses schedule session N),
 *   2. wait one period — NO owner signature, NO cron,
 *   3. pay again: the authorize path lazily flips to session N+1 (fresh
 *      budget) because the owner already enabled it in step 0.
 *
 * Testnet-only operator tooling. Prints addresses/tx links, never keys.
 *
 * Env (see ~/.haven/pilot.env):
 *   PILOT_OWNER_PRIVATE_KEY, PILOT_SAFE_ADDRESS, PILOT_AGENT_DELEGATE_ADDRESS,
 *   PILOT_ALLOWED_RECIPIENT, PILOT_API_URL, PILOT_DEV_EMAIL, PILOT_DEV_PASSWORD,
 *   PILOT_AGENT_ID? (optional override — normally resolved via the API),
 *   PILOT_RPC_URL?, PILOT_SCHEDULE_PERIOD_MIN? (default 3 — short for the proof),
 *   PILOT_SCHEDULE_PERIODS? (default 3), PILOT_SCHEDULE_BUDGET_ATOMIC? (default
 *   100000 = 0.10 USDC per period)
 *
 * Run: npm run pilot:schedule-live -w @haven/backend
 */

import { ethers } from 'ethers'
import { http, createPublicClient } from 'viem'
import { baseSepolia } from 'viem/chains'
import { getAccount, isSessionEnabled } from '@rhinestone/module-sdk'
import { buildScheduleFromNow, type SessionSchedule } from '../src/lib/session-schedule.js'

const CHAIN_ID = 84532
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required.`)
    process.exit(2)
  }
  return value
}

// ── Dev-API helpers (#798) — same shape as create-dod-agent.ts ─────────────

interface ApiResult {
  status: number
  json: Record<string, unknown>
}

async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  jwt?: string,
): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as never }
}

async function apiLogin(base: string): Promise<string> {
  const res = await api(base, 'POST', '/auth/login', {
    email: requireEnv('PILOT_DEV_EMAIL'),
    password: requireEnv('PILOT_DEV_PASSWORD'),
  })
  const token = res.json.token
  if (res.status !== 200 || typeof token !== 'string') {
    throw new Error(`dev login failed (${res.status})`)
  }
  return token
}

/** Resolve the pilot agent's uuid by its delegate address (env overrides). */
async function resolveAgentId(base: string, jwt: string, delegate: string): Promise<string> {
  if (process.env.PILOT_AGENT_ID) return process.env.PILOT_AGENT_ID
  const res = await api(base, 'GET', '/agents', undefined, jwt)
  const agents = (res.json.agents ?? []) as Array<{ id: string; delegate_address?: string }>
  const match = agents.find(
    (a) => (a.delegate_address ?? '').toLowerCase() === delegate.toLowerCase(),
  )
  if (!match) throw new Error(`no agent with delegate ${delegate} on the dev backend`)
  return match.id
}

interface WiringInputs {
  agentId: string
  recipient: string
  budgetAtomic: bigint
  periodMin: number
  periods: number
  fromPeriod: number
  firstPermissionId: string
}

/**
 * The three DB writes, over the API. Throws on any failure — the caller
 * prints the SQL fallback.
 */
async function wireViaApi(base: string, jwt: string, w: WiringInputs): Promise<void> {
  // 1. Recipient row (#796 CRUD upsert) with the per-period budget.
  const rec = await api(base, 'POST', `/agents/${w.agentId}/recipients`, {
    recipient_address: w.recipient.toLowerCase(),
    token_address: SEPOLIA_USDC,
    label: 'pilot recipient',
    budget_amount: w.budgetAtomic.toString(),
  }, jwt)
  if (rec.status !== 201) throw new Error(`recipient upsert failed (${rec.status}): ${JSON.stringify(rec.json)}`)

  // 2. reset_period_min must match the schedule's period — preserve the
  //    existing allowance amount (the allowances upsert writes both fields).
  const agent = await api(base, 'GET', `/agents/${w.agentId}`, undefined, jwt)
  const allowances = (agent.json.allowances ?? []) as Array<{
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>
  const usdc = allowances.find((a) => a.token_address.toLowerCase() === SEPOLIA_USDC.toLowerCase())
  if (!usdc) throw new Error('agent has no USDC allowance to align reset_period_min on')
  if (usdc.reset_period_min !== w.periodMin) {
    const upd = await api(base, 'POST', `/agents/${w.agentId}/allowances`, {
      token_address: usdc.token_address,
      token_symbol: usdc.token_symbol,
      allowance_amount: usdc.allowance_amount,
      reset_period_min: w.periodMin,
    }, jwt)
    if (upd.status >= 300) throw new Error(`allowance period update failed (${upd.status})`)
  }

  // 3. Record the enabled window (#770 confirm).
  const conf = await api(base, 'POST', `/agents/${w.agentId}/schedule/confirm`, {
    from_period: w.fromPeriod,
    period_count: w.periods,
    first_permission_id: w.firstPermissionId,
  }, jwt)
  if (conf.status !== 200) throw new Error(`schedule confirm failed (${conf.status}): ${JSON.stringify(conf.json)}`)
}

function printSqlFallback(w: WiringInputs): void {
  console.log('── SQL fallback (Railway → Postgres → shell → psql $DATABASE_URL) ─')
  console.log(`INSERT INTO agent_recipients (agent_id, token_address, recipient_address, budget_amount)`)
  console.log(`  VALUES ('${w.agentId}', '${SEPOLIA_USDC}', '${w.recipient.toLowerCase()}', '${w.budgetAtomic}')`)
  console.log(`  ON CONFLICT (agent_id, token_address, recipient_address)`)
  console.log(`  DO UPDATE SET budget_amount = '${w.budgetAtomic}';`)
  console.log(`UPDATE agent_allowances SET reset_period_min = ${w.periodMin}`)
  console.log(`  WHERE agent_id = '${w.agentId}' AND LOWER(token_address) = LOWER('${SEPOLIA_USDC}');`)
  console.log(`UPDATE agents SET session_schedule_from_period = ${w.fromPeriod},`)
  console.log(`  session_schedule_period_count = ${w.periods},`)
  console.log(`  session_permission_id = '${w.firstPermissionId}'`)
  console.log(`  WHERE id = '${w.agentId}';`)
  console.log('───────────────────────────────────────────────────────────────────')
}

/** Minimal threshold-1 owner execTransaction (EIP-712) — script-local. */
async function execAsOwner(
  safe: ethers.Contract,
  owner: ethers.Wallet,
  tx: { to: string; data: string; operation: 0 | 1 },
): Promise<ethers.TransactionReceipt> {
  const nonce: bigint = await safe.nonce()
  const domain = { chainId: CHAIN_ID, verifyingContract: await safe.getAddress() }
  const types = {
    SafeTx: [
      { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
    ],
  }
  const message = {
    to: tx.to, value: 0n, data: tx.data, operation: tx.operation,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce,
  }
  const signature = await owner.signTypedData(domain, types, message)
  const sent = await safe.execTransaction(
    tx.to, 0n, tx.data, tx.operation, 0n, 0n, 0n,
    ethers.ZeroAddress, ethers.ZeroAddress, signature,
  )
  const receipt = await sent.wait()
  if (!receipt || receipt.status !== 1) throw new Error('execTransaction reverted')
  return receipt
}

async function enableOnChain(
  schedule: SessionSchedule,
  safeAddress: string,
  owner: ethers.Wallet,
  rpcUrl: string,
  periods: number,
): Promise<string> {
  const safe = new ethers.Contract(safeAddress, [
    'function nonce() view returns (uint256)',
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  ], owner)
  const receipt = await execAsOwner(safe, owner, schedule.enablePayload)
  console.log(`tx confirmed:  https://sepolia.basescan.org/tx/${receipt.hash}`)

  // Verify every scheduled session is enabled, tolerating public-RPC lag.
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })
  const account = getAccount({ address: safeAddress as `0x${string}`, type: 'safe' })
  let enabled: boolean[] = []
  for (let attempt = 1; attempt <= 6; attempt++) {
    enabled = await Promise.all(
      schedule.entries.map((e) =>
        isSessionEnabled({ account, client: client as never, permissionId: e.permissionId }),
      ),
    )
    if (enabled.every(Boolean)) break
    console.log(`  verify ${attempt}/6 (${enabled.filter(Boolean).length}/${periods}) — waiting 5 s…`)
    await new Promise((r) => setTimeout(r, 5_000))
  }
  if (!enabled.every(Boolean)) {
    throw new Error(`schedule did not verify (${enabled.filter(Boolean).length}/${periods} enabled)`)
  }
  return receipt.hash
}

async function main(): Promise<void> {
  const ownerKey = requireEnv('PILOT_OWNER_PRIVATE_KEY')
  const safeAddress = ethers.getAddress(requireEnv('PILOT_SAFE_ADDRESS'))
  const delegate = ethers.getAddress(requireEnv('PILOT_AGENT_DELEGATE_ADDRESS'))
  const recipient = ethers.getAddress(requireEnv('PILOT_ALLOWED_RECIPIENT'))
  const apiBase = requireEnv('PILOT_API_URL').replace(/\/$/, '')
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  const periodMin = Number(process.env.PILOT_SCHEDULE_PERIOD_MIN ?? 3)
  const periods = Number(process.env.PILOT_SCHEDULE_PERIODS ?? 3)
  const budgetAtomic = BigInt(process.env.PILOT_SCHEDULE_BUDGET_ATOMIC ?? '100000')

  // Resolve the agent uuid FIRST — it is a determinism input to the schedule.
  const jwt = await apiLogin(apiBase)
  const agentId = await resolveAgentId(apiBase, jwt, delegate)
  console.log(`agent: ${agentId} (resolved via dev API)`)

  const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID)
  const owner = new ethers.Wallet(ownerKey, provider)
  const nowSec = Math.floor(Date.now() / 1000)

  const schedule = buildScheduleFromNow(
    agentId,
    {
      sessionKeyAddress: delegate as `0x${string}`,
      usdcAddress: SEPOLIA_USDC,
      allowedRecipient: recipient as `0x${string}`,
      budgetAtomic,
      chainId: BigInt(CHAIN_ID),
    },
    periodMin,
    nowSec,
    periods,
  )
  const fromPeriod = schedule.entries[0].periodIndex
  console.log(`enabling ${periods}-period schedule (${periodMin} min/period, ` +
    `${ethers.formatUnits(budgetAtomic, 6)} USDC/period) — ONE owner signature:`)
  for (const e of schedule.entries) console.log(`  period ${e.periodIndex}: ${e.permissionId}`)

  await enableOnChain(schedule, safeAddress, owner, rpcUrl, periods)

  console.log('')
  console.log(`✅ all ${periods} time-locked sessions enabled with ONE signature`)
  console.log('   (future sessions are DEAD before their validAfter window — max')
  console.log('    exposure at any instant = one period budget)')
  console.log('')

  const wiring: WiringInputs = {
    agentId,
    recipient,
    budgetAtomic,
    periodMin,
    periods,
    fromPeriod,
    firstPermissionId: schedule.entries[0].permissionId,
  }
  try {
    await wireViaApi(apiBase, jwt, wiring)
    console.log('✅ DB wiring done over the API — recipient upserted, period aligned, window recorded.')
  } catch (err) {
    console.error(`API wiring failed: ${err instanceof Error ? err.message : err}`)
    console.log('falling back to manual SQL:')
    printSqlFallback(wiring)
  }

  console.log('')
  console.log('cross-period proof (NO further owner action):')
  console.log('  1. npm run pilot:dod-payment -w packages/qa-agent   → pays on session', fromPeriod)
  console.log(`  2. wait ${periodMin} min (one period boundary)`)
  console.log('  3. npm run pilot:dod-payment -w packages/qa-agent   → pays on session', fromPeriod + 1)
  console.log('     — fresh budget, zero signatures; the recorded session flips to')
  console.log(`     '${schedule.entries[1]?.permissionId ?? '(n/a)'}' (the lazy rollover).`)
}

main().catch((e) => {
  console.error('schedule-live failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
