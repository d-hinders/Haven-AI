/**
 * #721 (ADR #719 Stage 1): provision the pilot Safe — the migration story.
 *
 * Unlike the #720 rig (a Safe *born* in 7579 mode via the launchpad), this
 * script mirrors what a Haven customer's account would go through in Stage 2:
 *   1. deploy a VANILLA Safe v1.4.1 (exactly the shape Haven deploys today),
 *   2. upgrade it with ONE owner-signed execTransaction — a MultiSend batch of
 *      enableModule + setFallbackHandler + safe7579.initializeAccount (which
 *      installs the Smart Sessions validator with no sessions yet), and
 *   3. verify the migration is ADDITIVE: the account answers as an ERC-7579
 *      account (accountId, Smart Sessions installed) *and* the plain owner
 *      execTransaction path still works afterwards.
 *
 * The owner EOA pays gas for both txs (needs a little Base Sepolia faucet ETH)
 * — deliberate: this is the customer-side migration path, no Haven relayer, no
 * bundler. Testnet-only; no Haven flow or QA-harness identity is touched.
 *
 * Run: npm run pilot:provision -w packages/qa-agent   (env: see pilot/config.ts)
 */

import { ethers } from 'ethers'
import {
  REGISTRY_ADDRESS,
  RHINESTONE_ATTESTER_ADDRESS,
  SMART_SESSIONS_ADDRESS,
} from '@rhinestone/module-sdk'
import { loadPilotProvisionConfig } from './config.js'
import {
  ERC7579_ACCOUNT_ABI,
  ERC7579_MODULE_TYPE_VALIDATOR,
  MULTI_SEND_ABI,
  SAFE_ABI,
  SAFE_PROXY_FACTORY_ABI,
  SEPOLIA_SAFE_CONTRACTS,
  buildProvisionBatch,
  encodeMultiSendTransactions,
  execSafeTransactionAsOwner,
} from './provision-lib.js'

const CHAIN_ID = 84532

async function main(): Promise<void> {
  let cfg
  try {
    cfg = loadPilotProvisionConfig(process.env)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, CHAIN_ID)
  const owner = new ethers.Wallet(cfg.ownerPrivateKey, provider)
  console.log(`owner (throwaway):   ${owner.address}`)

  const ownerBalance = await provider.getBalance(owner.address)
  if (ownerBalance === 0n) {
    console.error(
      'Owner holds no Base Sepolia ETH — it pays gas for the deploy and the one ' +
        'owner tx. Fund it from a faucet, then re-run.',
    )
    process.exit(2)
  }
  console.log(`owner gas balance:   ${ethers.formatEther(ownerBalance)} ETH`)

  // ── 1. Deploy a vanilla Safe v1.4.1 — or resume an already-deployed one ────
  let safeAddress: string
  if (cfg.existingSafeAddress) {
    const code = await provider.getCode(cfg.existingSafeAddress)
    if (code === '0x') {
      console.error(`PILOT_SAFE_ADDRESS ${cfg.existingSafeAddress} has no code on Base Sepolia.`)
      process.exit(2)
    }
    safeAddress = cfg.existingSafeAddress
    console.log(`reusing vanilla Safe: ${safeAddress} (PILOT_SAFE_ADDRESS set — deploy skipped)`)
  } else {
    const safeIface = new ethers.Interface(SAFE_ABI)
    const initializer = safeIface.encodeFunctionData('setup', [
      [owner.address], 1, ethers.ZeroAddress, '0x',
      SEPOLIA_SAFE_CONTRACTS.compatibilityFallbackHandler,
      ethers.ZeroAddress, 0, ethers.ZeroAddress,
    ])
    const factory = new ethers.Contract(
      SEPOLIA_SAFE_CONTRACTS.safeProxyFactory, SAFE_PROXY_FACTORY_ABI, owner,
    )
    console.log('deploying vanilla Safe…')
    let deployReceipt
    try {
      const deployTx = await factory.createProxyWithNonce(
        SEPOLIA_SAFE_CONTRACTS.safeSingletonL2, initializer, cfg.saltNonce,
      )
      deployReceipt = await deployTx.wait()
    } catch (e) {
      throw new Error(
        'Safe deploy reverted — if this owner+salt already deployed one (CREATE2 ' +
          'collision), set PILOT_SAFE_ADDRESS to reuse it or bump PILOT_SALT_NONCE. ' +
          (e instanceof Error ? e.message.split('\n')[0] : String(e)),
      )
    }
    const proxyCreated = deployReceipt.logs
      .map((log: ethers.Log) => { try { return factory.interface.parseLog(log) } catch { return null } })
      .find((parsed: ethers.LogDescription | null) => parsed?.name === 'ProxyCreation')
    if (!proxyCreated) throw new Error('ProxyCreation event not found in deploy receipt')
    safeAddress = proxyCreated.args.proxy
    console.log(`vanilla Safe:        ${safeAddress}`)
  }

  // ── 2. THE one owner tx: enableModule + setFallbackHandler + initializeAccount
  const batch = buildProvisionBatch({
    safeAddress,
    safe7579Adapter: cfg.safe7579AdapterAddress,
    smartSessionsValidator: SMART_SESSIONS_ADDRESS,
    registry: REGISTRY_ADDRESS,
    attester: RHINESTONE_ATTESTER_ADDRESS,
  })
  const multiSendData = new ethers.Interface(MULTI_SEND_ABI).encodeFunctionData('multiSend', [
    encodeMultiSendTransactions(batch),
  ])
  const safe = new ethers.Contract(safeAddress, SAFE_ABI, owner)
  console.log('submitting the ONE owner tx (MultiSend: enable + fallback + initialize)…')
  const migrateReceipt = await execSafeTransactionAsOwner(safe, owner, {
    chainId: CHAIN_ID,
    to: SEPOLIA_SAFE_CONTRACTS.multiSendCallOnly,
    data: multiSendData,
    operation: 1, // delegatecall into MultiSendCallOnly; inner calls are plain CALLs
  })
  console.log(`migration tx:        ${migrateReceipt.hash}`)

  // ── 3. Verify: 7579 surface live AND the plain-Safe path still works ────────
  const account7579 = new ethers.Contract(safeAddress, ERC7579_ACCOUNT_ABI, provider)
  const accountId: string = await account7579.accountId()
  const sessionsInstalled: boolean = await account7579.isModuleInstalled(
    ERC7579_MODULE_TYPE_VALIDATOR, SMART_SESSIONS_ADDRESS, '0x',
  )
  const adapterEnabled: boolean = await safe.isModuleEnabled(cfg.safe7579AdapterAddress)
  console.log(`accountId():         ${accountId}`)
  console.log(`Smart Sessions:      installed=${sessionsInstalled}`)
  console.log(`adapter as module:   enabled=${adapterEnabled}`)

  console.log('verifying the plain owner execTransaction path still works…')
  await execSafeTransactionAsOwner(safe, owner, { chainId: CHAIN_ID, to: safeAddress, data: '0x', operation: 0 })

  if (!sessionsInstalled || !adapterEnabled || !accountId) {
    throw new Error('post-migration verification failed — see flags above')
  }

  console.log('')
  console.log('✅ pilot Safe provisioned — vanilla Safe upgraded with ONE owner tx')
  console.log(`   safe:     https://sepolia.basescan.org/address/${safeAddress}`)
  console.log(`   tx:       https://sepolia.basescan.org/tx/${migrateReceipt.hash}`)
  console.log('   additive: plain execTransaction verified post-migration')
  console.log('   next:     #722 creates the session + policies on this account')
}

main().catch((e) => {
  console.error('provisioning failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
