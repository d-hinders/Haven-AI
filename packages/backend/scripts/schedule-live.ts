/**
 * #769 live proof — enable a pre-signed budget SCHEDULE on Base Sepolia with
 * ONE owner signature, then prove the cross-period rollover through the
 * production API with NO further owner action.
 *
 * Determinism contract: the backend's lazy rollover (session-schedule-
 * wiring.ts) recomputes the schedule from what the DB stores — the REAL agent
 * UUID, `agents.delegate_address`, the `agent_recipients` row's resolved
 * budget, and `agent_allowances.reset_period_min`. This script builds the
 * on-chain schedule from the SAME inputs and prints the SQL that stores them,
 * so the recomputation matches bit-for-bit. Change one input on either side
 * and the permissionIds diverge — that is the fail-closed design, not a bug.
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
 *   PILOT_ALLOWED_RECIPIENT, PILOT_AGENT_ID (the DB uuid — determinism input!),
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
import { buildScheduleFromNow } from '../src/lib/session-schedule.js'

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

async function main(): Promise<void> {
  const ownerKey = requireEnv('PILOT_OWNER_PRIVATE_KEY')
  const safeAddress = ethers.getAddress(requireEnv('PILOT_SAFE_ADDRESS'))
  const delegate = ethers.getAddress(requireEnv('PILOT_AGENT_DELEGATE_ADDRESS'))
  const recipient = ethers.getAddress(requireEnv('PILOT_ALLOWED_RECIPIENT'))
  const agentId = requireEnv('PILOT_AGENT_ID') // the DB uuid — determinism input
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  const periodMin = Number(process.env.PILOT_SCHEDULE_PERIOD_MIN ?? 3)
  const periods = Number(process.env.PILOT_SCHEDULE_PERIODS ?? 3)
  const budgetAtomic = BigInt(process.env.PILOT_SCHEDULE_BUDGET_ATOMIC ?? '100000')

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

  console.log('')
  console.log(`✅ all ${periods} time-locked sessions enabled with ONE signature`)
  console.log('   (future sessions are DEAD before their validAfter window — max')
  console.log('    exposure at any instant = one period budget)')
  console.log('')
  console.log('── DB wiring (Railway → Postgres → Console → psql) ───────────────')
  console.log(`INSERT INTO agent_recipients (agent_id, token_address, recipient_address, budget_amount)`)
  console.log(`  VALUES ('${agentId}', '${SEPOLIA_USDC}', '${recipient.toLowerCase()}', '${budgetAtomic}')`)
  console.log(`  ON CONFLICT (agent_id, token_address, recipient_address)`)
  console.log(`  DO UPDATE SET budget_amount = '${budgetAtomic}';`)
  console.log(`UPDATE agent_allowances SET reset_period_min = ${periodMin}`)
  console.log(`  WHERE agent_id = '${agentId}' AND LOWER(token_address) = LOWER('${SEPOLIA_USDC}');`)
  console.log(`UPDATE agents SET session_schedule_from_period = ${fromPeriod},`)
  console.log(`  session_schedule_period_count = ${periods},`)
  console.log(`  session_permission_id = '${schedule.entries[0].permissionId}'`)
  console.log(`  WHERE id = '${agentId}';`)
  console.log('───────────────────────────────────────────────────────────────────')
  console.log('cross-period proof (NO further owner action):')
  console.log('  1. npm run pilot:dod-payment -w packages/qa-agent   → pays on session', fromPeriod)
  console.log(`  2. wait ${periodMin} min (one period boundary)`)
  console.log('  3. npm run pilot:dod-payment -w packages/qa-agent   → pays on session', fromPeriod + 1)
  console.log('     — fresh budget, zero signatures; check agents.session_permission_id')
  console.log(`     flipped to '${schedule.entries[1]?.permissionId ?? '(n/a)'}' (the lazy rollover).`)
}

main().catch((e) => {
  console.error('schedule-live failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
