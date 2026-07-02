/**
 * #745 DoD step 3: enable a Smart Sessions session on the pilot Safe binding a
 * HAVEN AGENT's delegate key (not the old pilot session key). The backend
 * verifies payment signatures against the agent's `delegate_address`, so the
 * session must bind exactly that address.
 *
 * One owner-signed tx (the owner pays gas), then prints the `permissionId` and
 * the two ready-to-paste SQL statements that flip the account onto the session
 * rail. Testnet-only; prints addresses and tx links, never keys.
 *
 * Env (outside the repo, e.g. ~/.haven/pilot.env):
 *   PILOT_OWNER_PRIVATE_KEY        owner of the pilot Safe (throwaway, faucet ETH)
 *   PILOT_SAFE_ADDRESS             the #721-provisioned pilot Safe
 *   PILOT_AGENT_DELEGATE_ADDRESS   the dev agent's delegate address (dashboard)
 *   PILOT_ALLOWED_RECIPIENT        the single allowlisted recipient for the DoD
 *   PILOT_RPC_URL                  optional, default https://sepolia.base.org
 *
 * Run: npm run pilot:enable-agent-session -w packages/qa-agent
 */

import { randomBytes } from 'node:crypto'
import { ethers } from 'ethers'
import { http, createPublicClient, type Address, type Hex } from 'viem'
import { baseSepolia } from 'viem/chains'
import { getAccount, isSessionEnabled } from '@rhinestone/module-sdk'
import {
  buildHavenPolicySession,
  getEnableSessionsAction,
  getPermissionId,
} from './session-policies.js'
import { SAFE_ABI, execSafeTransactionAsOwner } from './provision-lib.js'

const CHAIN_ID = 84532
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address

// DoD policy shape: 0.05 USDC per tx, 0.10 USDC lifetime, 7 days validity.
const PER_TX_CAP_ATOMIC = 50_000n
const CUMULATIVE_LIMIT_ATOMIC = 100_000n
const VALIDITY_DAYS = 7

function requireAddress(name: string): `0x${string}` {
  const value = process.env[name]
  if (!value || !ethers.isAddress(value)) {
    console.error(`${name} must be set to a valid 0x address.`)
    process.exit(2)
  }
  return ethers.getAddress(value) as `0x${string}`
}

async function main(): Promise<void> {
  const ownerKey = process.env.PILOT_OWNER_PRIVATE_KEY
  if (!ownerKey) {
    console.error('PILOT_OWNER_PRIVATE_KEY is required (throwaway key, never production).')
    process.exit(2)
  }
  const safeAddress = requireAddress('PILOT_SAFE_ADDRESS')
  const delegateAddress = requireAddress('PILOT_AGENT_DELEGATE_ADDRESS')
  const allowedRecipient = requireAddress('PILOT_ALLOWED_RECIPIENT')
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'

  const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID)
  const owner = new ethers.Wallet(ownerKey, provider)
  console.log(`owner (pays gas):     ${owner.address}`)
  console.log(`pilot Safe:           ${safeAddress}`)
  console.log(`agent delegate:       ${delegateAddress}  ← the session key`)
  console.log(`allowed recipient:    ${allowedRecipient}`)

  const validUntilSec = Math.floor(Date.now() / 1000) + VALIDITY_DAYS * 24 * 3600
  const session = buildHavenPolicySession({
    sessionKeyAddress: delegateAddress,
    usdcAddress: SEPOLIA_USDC,
    allowedRecipient,
    perTxCapAtomic: PER_TX_CAP_ATOMIC,
    cumulativeLimitAtomic: CUMULATIVE_LIMIT_ATOMIC,
    validUntilSec,
    // Random salt: never collides with earlier pilot sessions on this Safe.
    salt: `0x${randomBytes(32).toString('hex')}` as Hex,
    chainId: BigInt(CHAIN_ID),
  })
  const permissionId = getPermissionId({ session })

  console.log('enabling the session (one owner tx)…')
  const enable = getEnableSessionsAction({ sessions: [session] })
  const safe = new ethers.Contract(safeAddress, SAFE_ABI, owner)
  const receipt = await execSafeTransactionAsOwner(safe, owner, {
    chainId: CHAIN_ID,
    to: enable.target,
    data: enable.callData,
    operation: 0,
  })
  // Print the tx BEFORE verification — if the read below fails, the operator
  // still has the link (the tx itself already succeeded; execSafeTransaction
  // throws on revert).
  console.log(`tx confirmed:         https://sepolia.basescan.org/tx/${receipt.hash}`)

  // Public Base Sepolia RPCs are load-balanced — a read right after the tx can
  // hit a node that has not seen the block yet. Retry before declaring failure.
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })
  let enabled = false
  for (let attempt = 1; attempt <= 6 && !enabled; attempt++) {
    enabled = await isSessionEnabled({
      account: getAccount({ address: safeAddress, type: 'safe' }),
      client: publicClient as never,
      permissionId,
    })
    if (!enabled) {
      console.log(`   verify attempt ${attempt}/6 — RPC has not caught up, waiting 5 s…`)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
  if (!enabled) {
    throw new Error(
      'session did not verify as enabled after 30 s — check the tx above on Basescan; ' +
        'if it succeeded, re-run with PILOT_RPC_URL set to a dedicated RPC and note that ' +
        're-running creates a NEW session (fresh salt), which is harmless.',
    )
  }

  console.log('')
  console.log('✅ session enabled and verified on-chain')
  console.log(`   permissionId: ${permissionId}`)
  console.log(`   policy:       recipient=${allowedRecipient}, per-tx 0.05 USDC, lifetime 0.10 USDC, expires in ${VALIDITY_DAYS}d`)
  console.log('')
  console.log('── Next (DoD step 4) — run in the dev database ──────────────────')
  console.log(`UPDATE user_safes SET execution_rail = 'session_key'`)
  console.log(`  WHERE LOWER(safe_address) = LOWER('${safeAddress}') AND chain_id = ${CHAIN_ID};`)
  console.log(`UPDATE agents SET session_permission_id = '${permissionId}'`)
  console.log(`  WHERE LOWER(delegate_address) = LOWER('${delegateAddress}');`)
  console.log('──────────────────────────────────────────────────────────────────')
  console.log('then: npm run pilot:dod-payment -w packages/qa-agent   (DoD step 5)')
}

main().catch((e) => {
  console.error('enable-agent-session failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
