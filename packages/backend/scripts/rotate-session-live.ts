/**
 * #734 live proof — rotate the pilot agent's session on Base Sepolia using the
 * BACKEND's rotation construction (src/lib/session-rotation.ts), then verify
 * on-chain that the new session is enabled and the old one is gone.
 *
 * The rotation is ONE owner-signed tx (remove old + enable new, atomic). After
 * it confirms, the script prints the guarded SQL switch and the follow-ups
 * that prove the budget semantics through the production API:
 *   - `pilot:dod-payment` succeeds again → fresh period budget;
 *   - a payment against the OLD permissionId fails validation → old budget dead.
 *
 * Testnet-only operator tooling. Prints addresses/tx links, never keys.
 *
 * Env (see ~/.haven/pilot.env):
 *   PILOT_OWNER_PRIVATE_KEY, PILOT_SAFE_ADDRESS, PILOT_AGENT_DELEGATE_ADDRESS,
 *   PILOT_ALLOWED_RECIPIENT, PILOT_CURRENT_PERMISSION_ID (the one in the DB),
 *   PILOT_RPC_URL? , PILOT_ROTATION_PERIOD_MIN? (default 1440 = daily)
 *
 * Run: npm run pilot:rotate-live -w @haven/backend
 */

import { ethers } from 'ethers'
import { http, createPublicClient } from 'viem'
import { baseSepolia } from 'viem/chains'
import { getAccount, isSessionEnabled } from '@rhinestone/module-sdk'
import { buildRotationPayload, buildRotationSession } from '../src/lib/session-rotation.js'

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
  const oldPermissionId = requireEnv('PILOT_CURRENT_PERMISSION_ID') as `0x${string}`
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  const periodMin = Number(process.env.PILOT_ROTATION_PERIOD_MIN ?? 1440)

  const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID)
  const owner = new ethers.Wallet(ownerKey, provider)
  const nowSec = Math.floor(Date.now() / 1000)

  // The backend's deterministic per-period session for this agent.
  const next = buildRotationSession(
    'dod-pilot-agent', // stable rotation identity for the pilot
    {
      sessionKeyAddress: delegate as `0x${string}`,
      usdcAddress: SEPOLIA_USDC,
      allowedRecipient: recipient as `0x${string}`,
      budgetAtomic: 100_000n, // 0.10 USDC per period
      chainId: BigInt(CHAIN_ID),
    },
    periodMin,
    nowSec,
  )
  if (next.permissionId.toLowerCase() === oldPermissionId.toLowerCase()) {
    console.error('current period session already active — nothing to rotate yet')
    process.exit(2)
  }

  const payload = buildRotationPayload(CHAIN_ID, oldPermissionId, next)
  console.log(`rotating session (period ${next.periodIndex}, ${periodMin} min)…`)
  console.log(`  old: ${oldPermissionId}`)
  console.log(`  new: ${next.permissionId}`)

  const safe = new ethers.Contract(safeAddress, [
    'function nonce() view returns (uint256)',
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  ], owner)
  const receipt = await execAsOwner(safe, owner, payload)
  console.log(`tx confirmed:  https://sepolia.basescan.org/tx/${receipt.hash}`)

  // Verify both directions, tolerating public-RPC lag.
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })
  const account = getAccount({ address: safeAddress as `0x${string}`, type: 'safe' })
  let newEnabled = false
  let oldEnabled = true
  for (let attempt = 1; attempt <= 6 && !(newEnabled && !oldEnabled); attempt++) {
    ;[newEnabled, oldEnabled] = await Promise.all([
      isSessionEnabled({ account, client: client as never, permissionId: next.permissionId }),
      isSessionEnabled({ account, client: client as never, permissionId: oldPermissionId }),
    ])
    if (!(newEnabled && !oldEnabled)) {
      console.log(`  verify ${attempt}/6 (new=${newEnabled} old=${oldEnabled}) — waiting 5 s…`)
      await new Promise((r) => setTimeout(r, 5_000))
    }
  }
  if (!newEnabled || oldEnabled) {
    throw new Error(`rotation did not verify (new=${newEnabled}, old=${oldEnabled}) — check the tx`)
  }

  console.log('')
  console.log('✅ rotated atomically — new session enabled, old session removed on-chain')
  console.log('')
  console.log('── DB switch (Railway → Postgres → Console → psql) ──────────────')
  console.log(`UPDATE agents SET session_permission_id = '${next.permissionId}'`)
  console.log(`  WHERE session_permission_id = '${oldPermissionId}';`)
  console.log('──────────────────────────────────────────────────────────────────')
  console.log('proof of budget semantics through the production API:')
  console.log('  1. npm run pilot:dod-payment -w packages/qa-agent   → succeeds (fresh budget)')
  console.log('  2. the OLD session can no longer validate anything — removed on-chain')
}

main().catch((e) => {
  console.error('rotate-session-live failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
