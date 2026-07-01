/**
 * #722 (ADR #719 Stage 1): on-chain policy enforcement suite — the pilot's
 * core question. Runs six cases against the provisioned pilot Safe (#721),
 * proving each Haven policy both PERMITS the intended payment and BLOCKS the
 * violating one at 4337 validation (a rule that doesn't stop is not a rule):
 *
 *   1. within caps → allowlisted recipient      → EXECUTES
 *   2. non-allowlisted recipient                → REJECTED
 *   3. over the per-tx cap                      → REJECTED
 *   4. cumulative spend past the session limit  → REJECTED (after two passes)
 *   5. session outside its validity window      → REJECTED (validAfter in future)
 *   6. owner revokes the session                → REJECTED afterwards
 *
 * Spend per full run ≈ 0.12 test-USDC (cases 1 + 4a + 4b) to the owner address.
 * Rejected cases fail at validation — no funds move, no gas is burned.
 *
 * Run: npm run pilot:policies -w packages/qa-agent   (env: see pilot/config.ts)
 */

import { ethers } from 'ethers'
import {
  http,
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { entryPoint07Address, getUserOperationHash } from 'viem/account-abstraction'
import { createSmartAccountClient } from 'permissionless'
import { toSafeSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { getAccountNonce } from 'permissionless/actions'
import {
  SMART_SESSIONS_ADDRESS,
  encodeSmartSessionSignature,
  encodeValidatorNonce,
  getAccount,
  getOwnableValidatorMockSignature,
} from '@rhinestone/module-sdk'
import { loadPilotPolicyConfig, type PilotPolicyConfig } from './config.js'
import { SAFE_ABI, execSafeTransactionAsOwner } from './provision-lib.js'
import {
  SmartSessionMode,
  buildHavenPolicySession,
  getEnableSessionsAction,
  getPermissionId,
  getRemoveSessionAction,
} from './session-policies.js'

const CHAIN_ID = 84532
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address
const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])
const NOT_ALLOWLISTED = '0x000000000000000000000000000000000000dEaD' as Address

// Policy numbers (atomic, 6 decimals): per-tx 0.05, session-lifetime 0.10.
const PER_TX_CAP = 50_000n
const CUMULATIVE_LIMIT = 100_000n
const OK_AMOUNT = 40_000n // 0.04 — under the per-tx cap
const OVER_TX_AMOUNT = 60_000n // 0.06 — over the per-tx cap

interface CaseResult {
  name: string
  expected: 'execute' | 'reject'
  outcome: 'execute' | 'reject'
  detail: string
}

async function main(): Promise<void> {
  let cfg: PilotPolicyConfig
  try {
    cfg = loadPilotPolicyConfig(process.env)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(cfg.rpcUrl) })
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, CHAIN_ID)
  const owner = new ethers.Wallet(cfg.ownerPrivateKey, provider)
  const sessionKey = privateKeyToAccount(cfg.sessionPrivateKey)
  const allowedRecipient = owner.address as Address
  console.log(`pilot Safe:      ${cfg.safeAddress}`)
  console.log(`session key:     ${sessionKey.address}`)
  console.log(`allowlisted to:  ${allowedRecipient}`)

  // Preflight: the pass cases move real test-USDC — require a funded pilot Safe.
  const usdcBalance = (await publicClient.readContract({
    address: SEPOLIA_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [cfg.safeAddress],
  })) as bigint
  console.log(`safe USDC:       ${formatUnits(usdcBalance, 6)}`)
  if (usdcBalance < 150_000n) {
    console.error('Pilot Safe needs ≥ 0.15 test-USDC (suite spends ~0.12). Fund it, then re-run.')
    process.exit(2)
  }

  // ── Sessions: A = the Haven policy shape, live now. B = not yet valid. ──────
  const nowSec = Math.floor(Date.now() / 1000)
  const sessionA = buildHavenPolicySession({
    sessionKeyAddress: sessionKey.address,
    usdcAddress: SEPOLIA_USDC,
    allowedRecipient,
    perTxCapAtomic: PER_TX_CAP,
    cumulativeLimitAtomic: CUMULATIVE_LIMIT,
    validUntilSec: nowSec + 24 * 3600,
    salt: ('0x' + '01'.repeat(32)) as Hex,
    chainId: BigInt(CHAIN_ID),
  })
  const sessionB = buildHavenPolicySession({
    sessionKeyAddress: sessionKey.address,
    usdcAddress: SEPOLIA_USDC,
    allowedRecipient,
    perTxCapAtomic: PER_TX_CAP,
    cumulativeLimitAtomic: CUMULATIVE_LIMIT,
    validAfterSec: nowSec + 3600, // window opens in the future → unusable now
    validUntilSec: nowSec + 24 * 3600,
    salt: ('0x' + '02'.repeat(32)) as Hex,
    chainId: BigInt(CHAIN_ID),
  })
  const permissionA = getPermissionId({ session: sessionA })
  const permissionB = getPermissionId({ session: sessionB })

  const safeEthers = new ethers.Contract(cfg.safeAddress, SAFE_ABI, owner)
  const enable = getEnableSessionsAction({ sessions: [sessionA, sessionB] })
  console.log('owner enabling sessions A + B (one execTransaction)…')
  await execSafeTransactionAsOwner(safeEthers, owner, {
    chainId: CHAIN_ID,
    to: enable.target,
    data: enable.callData,
    operation: 0,
  })

  // ── 4337 plumbing (the #720 rig, pointed at the provisioned account) ────────
  const account = await toSafeSmartAccount({
    client: publicClient,
    address: cfg.safeAddress,
    owners: [privateKeyToAccount(cfg.ownerPrivateKey)],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    safe4337ModuleAddress: cfg.safe7579AdapterAddress,
    erc7579LaunchpadAddress: cfg.erc7579LaunchpadAddress,
  })
  const pimlico = createPimlicoClient({
    transport: http(cfg.bundlerUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  })
  const client = createSmartAccountClient({
    account,
    chain: baseSepolia,
    bundlerTransport: http(cfg.bundlerUrl),
    paymaster: pimlico,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })

  /** Send one USDC transfer as a session-key UserOp under `permissionId`. */
  async function sendSessionTransfer(
    permissionId: Hex,
    to: Address,
    amount: bigint,
  ): Promise<string> {
    const nonce = await getAccountNonce(publicClient, {
      address: cfg.safeAddress,
      entryPointAddress: entryPoint07Address,
      key: encodeValidatorNonce({
        account: getAccount({ address: cfg.safeAddress, type: 'safe' }),
        validator: SMART_SESSIONS_ADDRESS,
      }),
    })
    const mock = encodeSessionSig(permissionId, getOwnableValidatorMockSignature({ threshold: 1 }))
    const userOperation = await client.prepareUserOperation({
      calls: [
        {
          to: SEPOLIA_USDC,
          value: 0n,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] }),
        },
      ],
      nonce,
      signature: mock,
    })
    const hash = getUserOperationHash({
      chainId: CHAIN_ID,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      userOperation: { ...userOperation, sender: cfg.safeAddress },
    })
    userOperation.signature = encodeSessionSig(permissionId, await sessionKey.sign({ hash }))
    const opHash = await client.sendUserOperation(userOperation)
    const receipt = await pimlico.waitForUserOperationReceipt({ hash: opHash })
    if (!receipt.success) throw new Error('UserOp included but reverted')
    return receipt.receipt.transactionHash
  }

  const results: CaseResult[] = []
  async function runCase(
    name: string,
    expected: 'execute' | 'reject',
    fn: () => Promise<string>,
  ): Promise<void> {
    try {
      const tx = await fn()
      results.push({ name, expected, outcome: 'execute', detail: tx })
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0].slice(0, 120) : String(e)
      results.push({ name, expected, outcome: 'reject', detail: msg })
    }
    const r = results[results.length - 1]
    const ok = r.outcome === r.expected
    console.log(`${ok ? '✅' : '❌'} ${name} — expected ${expected}, got ${r.outcome}`)
  }

  // ── The six cases ───────────────────────────────────────────────────────────
  await runCase('1 within caps → allowlisted', 'execute', () =>
    sendSessionTransfer(permissionA, allowedRecipient, OK_AMOUNT),
  )
  await runCase('2 non-allowlisted recipient', 'reject', () =>
    sendSessionTransfer(permissionA, NOT_ALLOWLISTED, OK_AMOUNT),
  )
  await runCase('3 over per-tx cap', 'reject', () =>
    sendSessionTransfer(permissionA, allowedRecipient, OVER_TX_AMOUNT),
  )
  await runCase('4a second within-cap payment (0.08 total)', 'execute', () =>
    sendSessionTransfer(permissionA, allowedRecipient, OK_AMOUNT),
  )
  await runCase('4b cumulative limit crossed (would be 0.12 > 0.10)', 'reject', () =>
    sendSessionTransfer(permissionA, allowedRecipient, OK_AMOUNT),
  )
  await runCase('5 session outside validity window', 'reject', () =>
    sendSessionTransfer(permissionB, allowedRecipient, OK_AMOUNT),
  )
  const remove = getRemoveSessionAction({ permissionId: permissionA })
  console.log('owner revoking session A…')
  await execSafeTransactionAsOwner(safeEthers, owner, {
    chainId: CHAIN_ID,
    to: remove.target,
    data: remove.callData,
    operation: 0,
  })
  await runCase('6 revoked session', 'reject', () =>
    sendSessionTransfer(permissionA, allowedRecipient, OK_AMOUNT),
  )

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const failures = results.filter((r) => r.outcome !== r.expected)
  console.log('')
  console.log('| case | expected | outcome | detail |')
  console.log('|---|---|---|---|')
  for (const r of results) {
    console.log(`| ${r.name} | ${r.expected} | ${r.outcome} | ${r.detail} |`)
  }
  console.log('')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} case(s) diverged — a policy did not enforce as expected`)
    process.exit(1)
  }
  console.log('✅ all six policies enforced on-chain — paste this table into #722')
}

function encodeSessionSig(permissionId: Hex, signature: Hex): Hex {
  return encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature })
}

main().catch((e) => {
  console.error('policy suite failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
