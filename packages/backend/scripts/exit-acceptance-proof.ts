/**
 * #832 acceptance test — the exit guarantee, executed on-chain using ONLY
 * public inputs (account address + the pinned DelegationManager + a
 * delegation object). Proves a user with only their owner key and the public
 * docs can (a) enumerate a budget's status and (b) disableDelegation so
 * further redemption reverts. No Haven backend, no Haven session.
 *
 * Env: PILOT_7710_DELEGATOR_PRIVATE_KEY (the account owner), SPIKE_DELEGATE_KEY
 *   (agent key), PILOT_RPC_URL?, PILOT_ALLOWED_RECIPIENT.
 *
 * Run: npm run pilot:exit-proof -w @haven/backend
 */
import { ethers } from 'ethers'
import { createPublicClient, http, type Hex } from 'viem'
import { baseSepolia } from 'viem/chains'
import {
  Implementation, toMetaMaskSmartAccount, createOpenDelegation, signDelegation,
  type Delegation,
} from '@metamask/smart-accounts-kit'
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { getDelegationContracts } from '../src/rails/delegation-contracts.js'
import { buildRevocation } from '../src/rails/delegation-policy.js'
import { createDelegationRail, createTreasuryOps } from '../src/rails/delegation-rail.js'
import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'

const CHAIN = baseSepolia
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const DELEGATION_TUPLE =
  'tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)'
const EXIT_ABI = [
  `function disableDelegation(${DELEGATION_TUPLE} _delegation)`,
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
]

function req(n: string): string { const v = process.env[n]; if (!v) { console.error(`${n} required`); process.exit(2) } return v }

async function main(): Promise<void> {
  const ownerKey = req('PILOT_7710_DELEGATOR_PRIVATE_KEY')
  const agentKey = req('SPIKE_DELEGATE_KEY') as Hex
  const recipient = req('PILOT_ALLOWED_RECIPIENT')
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  const manager = getDelegationContracts(CHAIN.id).delegationManager

  const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN.id)
  const owner = new ethers.Wallet(ownerKey, provider)
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) })

  const treasury = await toMetaMaskSmartAccount({
    client: publicClient as never, implementation: Implementation.Hybrid,
    deployParams: [owner.address as `0x${string}`, [], [], []], deploySalt: '0x',
    signer: { account: { address: owner.address as `0x${string}`, async signMessage() { throw new Error('watch') }, async signTransaction() { throw new Error('watch') }, async signTypedData() { throw new Error('watch') }, type: 'local' } as never },
  })
  console.log(`account (delegator): ${treasury.address}`)
  console.log(`DelegationManager (pinned): ${manager}`)

  // A budget the account issued (the thing we'll revoke).
  const nowSec = Math.floor(Date.now() / 1000)
  const delegation = createOpenDelegation({
    environment: treasury.environment, from: treasury.address,
    scope: { type: 'erc20PeriodTransfer', tokenAddress: USDC, periodAmount: 20_000n, periodDuration: 3600, startDate: nowSec - 60 },
    caveats: [{ type: 'timestamp', afterThreshold: 0, beforeThreshold: nowSec + 3600 }],
  })
  const signed: Delegation = {
    ...delegation,
    signature: await signDelegation({ privateKey: ownerKey as Hex, delegation, delegationManager: manager, chainId: CHAIN.id }),
  }
  const hash = hashDelegation(signed)
  const exit = new ethers.Contract(manager, EXIT_ABI, owner)

  // STEP A — inspect (public read, no Haven).
  const beforeDisabled = await exit.disabledDelegations(hash)
  console.log(`\nSTEP A — inspect: disabledDelegations(${hash.slice(0, 12)}…) = ${beforeDisabled} (false = active)`)

  // Prove it's spendable: one redemption before revocation.
  const agent = new ethers.Wallet(agentKey)
  const rail = await createDelegationRail({ delegateOwnerAddress: agent.address as `0x${string}`, chainId: CHAIN.id, bundlerUrl: req('PILOT_BUNDLER_URL'), rpcUrl })
  const prep = await rail.prepareRedemption(signed, USDC as `0x${string}`, recipient as `0x${string}`, 5_000n)
  const sig = await signUserOpTypedDataForDelegation(agentKey, prep.signingTypedData)
  const spend = await rail.submitRedemption(prep, sig as Hex)
  console.log(`   pre-revoke spend succeeds: https://sepolia.basescan.org/tx/${spend.txHash}`)

  // STEP B — revoke: disableDelegation is a DELEGATOR-ACCOUNT operation (the
  // manager checks msg.sender == delegator), so it runs as a UserOp the OWNER
  // signs — NOT a bare EOA call (which reverts). The owner signs the account's
  // EIP-712 typed data (the #829 lesson; treasury ops share it). No Haven.
  const revocation = buildRevocation(signed, CHAIN.id)
  const treasuryOps = await createTreasuryOps({
    ownerAddress: owner.address as `0x${string}`, chainId: CHAIN.id,
    bundlerUrl: req('PILOT_BUNDLER_URL'), rpcUrl,
  })
  const preparedRevoke = await treasuryOps.prepareCall(revocation.to as `0x${string}`, revocation.data as Hex)
  const revokeSig = await signUserOpTypedDataForDelegation(ownerKey as Hex, preparedRevoke.signingTypedData)
  const revokeResult = await treasuryOps.submitCall(preparedRevoke, revokeSig as Hex)
  console.log(`\nSTEP B — revoke (owner-signed account op): https://sepolia.basescan.org/tx/${revokeResult.txHash}`)
  const afterDisabled = await exit.disabledDelegations(hash)
  console.log(`   disabledDelegations now = ${afterDisabled} (true = revoked)`)

  // STEP C — confirm further redemption fails.
  let redeemBlocked = false
  try {
    const p2 = await rail.prepareRedemption(signed, USDC as `0x${string}`, recipient as `0x${string}`, 5_000n)
    const s2 = await signUserOpTypedDataForDelegation(agentKey, p2.signingTypedData)
    await rail.submitRedemption(p2, s2 as Hex)
  } catch { redeemBlocked = true }
  console.log(`\nSTEP C — post-revoke redemption ${redeemBlocked ? 'FAILS ✓ (as required)' : 'STILL WORKS ✗'}`)

  const pass = beforeDisabled === false && afterDisabled === true && redeemBlocked
  console.log(pass ? '\n✅ EXIT ACCEPTANCE TEST PASSED — enumerate + revoke, no Haven involved' : '\n❌ acceptance test failed')
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error('exit-proof failed:', e instanceof Error ? e.message : e); process.exit(1) })
