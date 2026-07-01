/**
 * #723 (ADR #719 Stage 1): gasless payment E2E + rail comparison.
 *
 * Session rail (always measured): three sequential policy-bound USDC payments
 * from the pilot Safe (session key signs, bundler submits, paymaster pays gas),
 * then the #718 concurrency probe — THREE SIMULTANEOUS payments with
 * consecutive pre-assigned 2D nonces. Bundlers can include all three; the
 * single-EOA relayer rail serializes (and historically raced, #692).
 *
 * Relayer rail (opt-in, PILOT_COMPARE_RELAYER=1 + QA_* env): the same shape
 * through the existing AllowanceModule rail via @haven_ai/sdk pay() against
 * the dev backend — three sequential, then three concurrent. ⚠️ Uses the
 *   shared QA identity and spends 6 × 0.1 USDC of its allowance; off by
 *   default so the deterministic qa-dev signal is never touched accidentally.
 *
 * Output: a Markdown comparison table (median latency, avg gas, concurrency
 * outcome) + one rail-agnostic evidence JSON line per confirmed payment
 * (mirrors lib/machine-payment-evidence.ts columns). Paste both into #723.
 *
 * Run: npm run pilot:compare -w packages/qa-agent   (env: see pilot/config.ts)
 */

import { ethers } from 'ethers'
import { formatUnits, type Address, type Hex } from 'viem'
import { HavenClient } from '@haven_ai/sdk'
import { loadPilotPolicyConfig, type PilotPolicyConfig } from './config.js'
import { SAFE_ABI, execSafeTransactionAsOwner } from './provision-lib.js'
import { ERC20_ABI, SEPOLIA_USDC, createSessionRail } from './session-rail.js'
import {
  buildHavenPolicySession,
  getEnableSessionsAction,
  getPermissionId,
} from './session-policies.js'
import {
  buildComparisonTable,
  buildPilotEvidence,
  type RailMeasurement,
} from './compare-lib.js'

const CHAIN_ID = 84532
const PAY_AMOUNT = 10_000n // 0.01 USDC per session-rail payment (6 total = 0.06)
const RELAYER_AMOUNT = '0.1' // matches the deterministic within-budget scenario

async function measureSessionRail(cfg: PilotPolicyConfig): Promise<RailMeasurement> {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, CHAIN_ID)
  const owner = new ethers.Wallet(cfg.ownerPrivateKey, provider)
  const recipient = owner.address as Address
  const rail = await createSessionRail(cfg)

  const usdcBalance = (await rail.publicClient.readContract({
    address: SEPOLIA_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [cfg.safeAddress],
  })) as bigint
  console.log(`safe USDC: ${formatUnits(usdcBalance, 6)}`)
  if (usdcBalance < 100_000n) {
    console.error('Pilot Safe needs ≥ 0.10 test-USDC (comparison spends 0.06). Fund it, re-run.')
    process.exit(2)
  }

  // A roomy comparison session (distinct salt from the #722 suite).
  const nowSec = Math.floor(Date.now() / 1000)
  const session = buildHavenPolicySession({
    sessionKeyAddress: ethers.computeAddress(cfg.sessionPrivateKey) as Address,
    usdcAddress: SEPOLIA_USDC,
    allowedRecipient: recipient,
    perTxCapAtomic: 50_000n,
    cumulativeLimitAtomic: 500_000n,
    validUntilSec: nowSec + 24 * 3600,
    salt: ('0x' + '03'.repeat(32)) as Hex,
    chainId: BigInt(CHAIN_ID),
  })
  const permissionId = getPermissionId({ session })
  const enable = getEnableSessionsAction({ sessions: [session] })
  console.log('owner enabling the comparison session…')
  await execSafeTransactionAsOwner(new ethers.Contract(cfg.safeAddress, SAFE_ABI, owner), owner, {
    chainId: CHAIN_ID,
    to: enable.target,
    data: enable.callData,
    operation: 0,
  })

  const m: RailMeasurement = {
    rail: 'erc4337-session',
    sequentialLatenciesMs: [],
    gasUsed: [],
    concurrentAttempted: 3,
    concurrentLanded: 0,
    concurrentFailures: [],
  }

  console.log('session rail: 3 sequential payments…')
  for (let i = 0; i < 3; i++) {
    const r = await rail.sendTransfer(permissionId, recipient, PAY_AMOUNT)
    m.sequentialLatenciesMs.push(r.latencyMs)
    m.gasUsed.push(r.actualGasUsed)
    console.log(
      JSON.stringify(
        buildPilotEvidence({
          rail: m.rail, txHash: r.txHash, chainId: CHAIN_ID,
          payer: cfg.safeAddress, settlement: recipient,
          tokenAddress: SEPOLIA_USDC, amountRaw: PAY_AMOUNT,
        }),
      ),
    )
  }

  console.log('session rail: 3 CONCURRENT payments (consecutive pre-assigned nonces)…')
  const base = await rail.getSessionNonce()
  const settled = await Promise.allSettled(
    [0n, 1n, 2n].map((offset) =>
      rail.sendTransferWithNonce(permissionId, recipient, PAY_AMOUNT, base + offset, base),
    ),
  )
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      m.concurrentLanded++
      console.log(
        JSON.stringify(
          buildPilotEvidence({
            rail: m.rail, txHash: s.value.txHash, chainId: CHAIN_ID,
            payer: cfg.safeAddress, settlement: recipient,
            tokenAddress: SEPOLIA_USDC, amountRaw: PAY_AMOUNT,
          }),
        ),
      )
    } else {
      const msg = s.reason instanceof Error ? s.reason.message.split('\n')[0] : String(s.reason)
      m.concurrentFailures.push(msg.slice(0, 80))
    }
  }
  return m
}

async function measureRelayerRail(cfg: PilotPolicyConfig): Promise<RailMeasurement | null> {
  if (process.env.PILOT_COMPARE_RELAYER !== '1') {
    console.log('relayer rail: skipped (set PILOT_COMPARE_RELAYER=1 + QA_* env to include it)')
    return null
  }
  const { QA_HAVEN_API_URL, QA_AGENT_API_KEY, QA_DELEGATE_PRIVATE_KEY, QA_PAYMENT_TO } = process.env
  if (!QA_HAVEN_API_URL || !QA_AGENT_API_KEY || !QA_DELEGATE_PRIVATE_KEY || !QA_PAYMENT_TO) {
    console.error('PILOT_COMPARE_RELAYER=1 needs QA_HAVEN_API_URL, QA_AGENT_API_KEY, QA_DELEGATE_PRIVATE_KEY, QA_PAYMENT_TO')
    process.exit(2)
  }
  console.log('relayer rail: 3 sequential + 3 concurrent 0.1 USDC payments (shared QA identity)…')
  const client = new HavenClient({
    apiKey: QA_AGENT_API_KEY,
    delegateKey: QA_DELEGATE_PRIVATE_KEY,
    baseUrl: QA_HAVEN_API_URL,
  })
  const provider = new ethers.JsonRpcProvider(process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org', CHAIN_ID)

  const m: RailMeasurement = {
    rail: 'allowance-relayer',
    sequentialLatenciesMs: [],
    gasUsed: [],
    concurrentAttempted: 3,
    concurrentLanded: 0,
    concurrentFailures: [],
  }
  const payOnce = async (): Promise<{ latencyMs: number; txHash: string | null }> => {
    const startedAt = Date.now()
    const result = await client.pay({ token: 'USDC', amount: RELAYER_AMOUNT, to: QA_PAYMENT_TO })
    return { latencyMs: Date.now() - startedAt, txHash: result.txHash }
  }

  for (let i = 0; i < 3; i++) {
    const r = await payOnce()
    m.sequentialLatenciesMs.push(r.latencyMs)
    if (r.txHash) {
      const receipt = await provider.getTransactionReceipt(r.txHash)
      if (receipt) m.gasUsed.push(receipt.gasUsed)
      console.log(
        JSON.stringify(
          buildPilotEvidence({
            rail: m.rail, txHash: r.txHash, chainId: CHAIN_ID,
            payer: 'safe (QA identity)', settlement: QA_PAYMENT_TO,
            tokenAddress: SEPOLIA_USDC, amountRaw: 100_000n,
          }),
        ),
      )
    }
  }

  const settled = await Promise.allSettled([payOnce(), payOnce(), payOnce()])
  for (const s of settled) {
    if (s.status === 'fulfilled') m.concurrentLanded++
    else {
      const msg = s.reason instanceof Error ? s.reason.message.split('\n')[0] : String(s.reason)
      m.concurrentFailures.push(msg.slice(0, 80))
    }
  }
  return m
}

async function main(): Promise<void> {
  let cfg: PilotPolicyConfig
  try {
    cfg = loadPilotPolicyConfig(process.env)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }

  const measurements: RailMeasurement[] = [await measureSessionRail(cfg)]
  const relayer = await measureRelayerRail(cfg)
  if (relayer) measurements.push(relayer)

  console.log('')
  console.log(buildComparisonTable(measurements))
  console.log('')
  console.log('✅ comparison complete — paste the table + evidence lines into #723')
}

main().catch((e) => {
  console.error('rail comparison failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
