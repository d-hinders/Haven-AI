/**
 * #884 — Passkey gate spike (epic #836): WebAuthn-signed Hybrid end-to-end on
 * Base Sepolia, fully HEADLESS. A local P256 key emulates the authenticator
 * (viem's toWebAuthnAccount accepts a custom getFn), so every claim is
 * scriptable like #820.
 *
 * Claims proven, in order:
 *   1. PROVISION+DEPLOY — a pure-passkey Hybrid (deployParams
 *      [zeroAddress,[keyId],[x],[y]]) relayer-deploys via ensureHybridDeployed
 *      (the #860 path) with no EOA owner at all.
 *   2. PASSKEY-SIGNED GRANT REDEEMS — the account signs a budget delegation
 *      through its WebAuthn signer; the DelegationManager accepts it at
 *      redemption (EIP-1271 → Hybrid → P256 verify). THE headline risk.
 *   3. PASSKEY-SIGNED ACCOUNT OP — a treasury UserOp (disableDelegation)
 *      signed via the WebAuthn account validates in validateUserOp.
 *   4. KEY ROTATION = RECOVERY — addKey enrolls a second P256 signer via an
 *      account op; the BACKUP signer alone then performs removeKey of the
 *      "lost" primary. The on-chain recovery primitive.
 *
 * Env (~/.haven/pilot.env): PILOT_BUNDLER_URL, PILOT_OWNER_PRIVATE_KEY (used
 * ONLY as the gas relayer for the factory deploy + USDC funding source),
 * PILOT_RPC_URL?. Throwaway P256 keys are generated per run.
 *
 * Run: npm run pilot:passkey-spike -w @haven/backend
 */
import { createHash } from 'node:crypto'
import {
  http,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  parseUnits,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { toWebAuthnAccount } from 'viem/account-abstraction'
import { baseSepolia } from 'viem/chains'
import { p256 } from '@noble/curves/p256'
import {
  Implementation,
  toMetaMaskSmartAccount,
  createDelegation,
  type Delegation,
  type MetaMaskSmartAccount,
} from '@metamask/smart-accounts-kit'
import { createDelegationRail } from '../src/lib/delegation-rail.js'
import { ensureHybridDeployed } from '../src/lib/hybrid-provisioning.js'
import { buildRevocation } from '../src/lib/delegation-policy.js'
import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'

const CHAIN = baseSepolia
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const EXPLORER = 'https://sepolia.basescan.org/tx/'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is required.`); process.exit(2) }
  return v
}

// ── Headless WebAuthn authenticator ─────────────────────────────────────────
// Emulates navigator.credentials.get with a local P256 key: builds
// authenticatorData + clientDataJSON and DER-signs their digest, exactly as a
// platform authenticator would. This is what makes the spike scriptable.

interface LocalPasskey {
  keyId: Hex
  x: bigint
  y: bigint
  credential: { id: string; publicKey: Hex }
  getFn: (options?: CredentialRequestOptions) => Promise<Credential | null>
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

function makeLocalPasskey(label: string): LocalPasskey {
  const priv = p256.utils.randomPrivateKey()
  const pubPoint = p256.ProjectivePoint.fromPrivateKey(priv)
  const x = pubPoint.x
  const y = pubPoint.y
  // Uncompressed public key (0x04||x||y) — the format viem's parsePublicKey accepts.
  const publicKey = ('0x04' +
    x.toString(16).padStart(64, '0') +
    y.toString(16).padStart(64, '0')) as Hex
  const idBytes = sha256(new TextEncoder().encode(`haven-spike-${label}-${toHex(priv).slice(2, 10)}`))
  const id = Buffer.from(idBytes).toString('base64url')
  const rpIdHash = sha256(new TextEncoder().encode('haven.spike.local'))

  const getFn = async (options?: CredentialRequestOptions): Promise<Credential | null> => {
    const challenge = new Uint8Array(
      (options?.publicKey?.challenge as ArrayBuffer) ?? new ArrayBuffer(0),
    )
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: Buffer.from(challenge).toString('base64url'),
        origin: 'https://haven.spike.local',
        crossOrigin: false,
      }),
    )
    // flags 0x05 = user present + user verified; counter 0.
    const authenticatorData = new Uint8Array(37)
    authenticatorData.set(rpIdHash, 0)
    authenticatorData[32] = 0x05
    const digest = sha256(
      new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]),
    )
    const signature = p256.sign(digest, priv).toDERRawBytes()
    const response = {
      authenticatorData: authenticatorData.buffer,
      clientDataJSON: clientDataJSON.buffer,
      signature: signature.buffer,
      userHandle: null,
    }
    return {
      id,
      rawId: idBytes.buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: () => ({}),
    } as unknown as Credential
  }

  return { keyId: toHex(idBytes), x, y, credential: { id, publicKey }, getFn }
}

async function buildPasskeyAccount(
  publicClient: ReturnType<typeof createPublicClient>,
  passkeys: LocalPasskey[],
  signWith: LocalPasskey,
): Promise<MetaMaskSmartAccount> {
  const webAuthnAccount = toWebAuthnAccount({
    credential: signWith.credential,
    getFn: signWith.getFn,
    rpId: 'haven.spike.local',
  })
  return toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [
      zeroAddress,
      passkeys.map((p) => p.keyId),
      passkeys.map((p) => p.x),
      passkeys.map((p) => p.y),
    ],
    deploySalt: '0x',
    signer: { webAuthnAccount, keyId: signWith.keyId },
  })
}

async function main(): Promise<void> {
  const bundlerUrl = requireEnv('PILOT_BUNDLER_URL')
  const gasKey = requireEnv('PILOT_OWNER_PRIVATE_KEY') as Hex
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  process.env.RELAYER_PRIVATE_KEY_84532 = process.env.RELAYER_PRIVATE_KEY_84532 || gasKey

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) })
  const primary = makeLocalPasskey('primary')
  const agentKey = ('0x' + Buffer.from(p256.utils.randomPrivateKey()).toString('hex')) as Hex
  const agent = privateKeyToAccount(agentKey)

  console.log(`\n#884 passkey spike — pure-P256 Hybrid, headless WebAuthn\n`)

  // ── Claim 1: provision + relayer deploy, NO EOA owner ──
  const treasury = await buildPasskeyAccount(publicClient, [primary], primary)
  console.log(`treasury (pure passkey): ${treasury.address}`)
  const dep = await ensureHybridDeployed(CHAIN.id, {
    passkeys: [{ keyId: primary.keyId, x: primary.x, y: primary.y }],
  })
  if (dep.address !== treasury.address) throw new Error('derivation mismatch lib vs kit')
  console.log(`✅ CLAIM 1 — relayer-deployed pure-passkey Hybrid: ${dep.txHash ? EXPLORER + dep.txHash : '(already deployed)'}\n`)

  // fund with USDC for the redemption
  const gasWallet = createWalletClient({ account: privateKeyToAccount(gasKey), chain: CHAIN, transport: http(rpcUrl) })
  const fundTx = await gasWallet.sendTransaction({
    to: USDC,
    data: encodeFunctionData({
      abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'transfer',
      args: [treasury.address, parseUnits('0.02', 6)],
    }),
  })
  await publicClient.waitForTransactionReceipt({ hash: fundTx })
  // Public RPCs read-after-write stale for a few seconds; poll until the
  // funded balance is visible so the redemption doesn't simulate against zero.
  const balAbi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const
  for (let i = 0; i < 8; i++) {
    const bal = (await publicClient.readContract({ address: USDC, abi: balAbi, functionName: 'balanceOf', args: [treasury.address] })) as bigint
    if (bal >= parseUnits('0.02', 6)) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log(`   funded 0.02 USDC — ${EXPLORER}${fundTx}\n`)

  // ── Claim 2: passkey-signed delegation REDEEMS ──
  const rail = await createDelegationRail({
    delegateOwnerAddress: agent.address,
    chainId: CHAIN.id,
    bundlerUrl,
    rpcUrl,
  })
  const nowSec = Math.floor(Date.now() / 1000)
  const delegation = createDelegation({
    environment: treasury.environment,
    from: treasury.address,
    to: rail.delegateAccountAddress,
    scope: {
      type: 'erc20PeriodTransfer',
      tokenAddress: USDC,
      periodAmount: 15_000n, // 0.015 USDC per period
      periodDuration: 3600,
      startDate: nowSec - 60,
    },
    caveats: [{ type: 'timestamp', afterThreshold: 0, beforeThreshold: nowSec + 3600 }],
  })
  // THE headline moment: the WebAuthn signer signs the delegation.
  const delegationSignature = await treasury.signDelegation({ delegation })
  const signed: Delegation = { ...delegation, signature: delegationSignature }
  console.log(`   delegation signed by passkey (${delegationSignature.slice(0, 18)}…)`)

  const prepared = await rail.prepareRedemption(signed, USDC, agent.address, 10_000n)
  const agentSig = await signUserOpTypedDataForDelegation(agentKey, prepared.signingTypedData)
  const redeemed = await rail.submitRedemption(prepared, agentSig as Hex)
  console.log(`✅ CLAIM 2 — passkey-signed grant REDEEMED on-chain (EIP-1271 → P256): ${EXPLORER}${redeemed.txHash}\n`)

  // ── Claim 3: passkey-signed account op (disableDelegation) ──
  // createTreasuryOps is the EOA-signer treasury path; the passkey account
  // signs its own ops via the kit account + a bundler client directly.
  const revocation = buildRevocation(signed, CHAIN.id)
  const { createBundlerClient } = await import('viem/account-abstraction')
  const { createPimlicoClient } = await import('permissionless/clients/pimlico')
  const { entryPoint07Address } = await import('viem/account-abstraction')
  const pimlico = createPimlicoClient({ transport: http(bundlerUrl), entryPoint: { address: entryPoint07Address, version: '0.7' } })
  const bundler = createBundlerClient({
    account: treasury,
    chain: CHAIN,
    transport: http(bundlerUrl),
    paymaster: pimlico,
    userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
  })
  const revokeHash = await bundler.sendUserOperation({
    calls: [{ to: revocation.to, value: 0n, data: revocation.data }],
  })
  const revokeReceipt = await bundler.waitForUserOperationReceipt({ hash: revokeHash })
  console.log(`✅ CLAIM 3 — passkey-signed account op (disableDelegation): ${EXPLORER}${revokeReceipt.receipt.transactionHash}\n`)

  // ── Claim 4: recovery = enroll backup, then backup-alone rotates out the lost primary ──
  // FINDING (#884): a pure-passkey Hybrid (no EOA owner) refuses to drop below
  // TWO keys — removeKey reverts CannotRemoveLastSigner (0xc4c85473) on a 2→1
  // removal. So the safe recovery ORDER is enroll-replacement-BEFORE-remove,
  // which also proves the backup has full control. (Design consequence for the
  // epic: single-passkey accounts have no recovery — push backup enrollment.)
  const backup = makeLocalPasskey('backup')
  const replacement = makeLocalPasskey('replacement')
  const HYBRID_KEY_ABI = [
    { name: 'addKey', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'keyId', type: 'string' }, { name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }], outputs: [] },
    { name: 'removeKey', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'keyId', type: 'string' }], outputs: [] },
  ] as const

  // (a) primary enrolls the backup → 2 keys
  const addBackupHash = await bundler.sendUserOperation({
    calls: [{ to: treasury.address, value: 0n, data: encodeFunctionData({ abi: HYBRID_KEY_ABI, functionName: 'addKey', args: [backup.keyId, backup.x, backup.y] }) }],
  })
  const addBackupReceipt = await bundler.waitForUserOperationReceipt({ hash: addBackupHash })
  console.log(`   backup passkey enrolled by primary (addKey): ${EXPLORER}${addBackupReceipt.receipt.transactionHash}`)

  // Primary is now "lost". The BACKUP signer alone drives the account from here.
  const treasuryAsBackup = await buildPasskeyAccount(publicClient, [primary], backup)
  if (treasuryAsBackup.address !== treasury.address) throw new Error('backup signer derives a different address')
  const bundlerAsBackup = createBundlerClient({
    account: treasuryAsBackup,
    chain: CHAIN,
    transport: http(bundlerUrl),
    paymaster: pimlico,
    userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
  })

  // (b) backup ALONE enrolls a replacement → 3 keys (proves backup control + restores redundancy)
  const addReplacementHash = await bundlerAsBackup.sendUserOperation({
    calls: [{ to: treasury.address, value: 0n, data: encodeFunctionData({ abi: HYBRID_KEY_ABI, functionName: 'addKey', args: [replacement.keyId, replacement.x, replacement.y] }) }],
  })
  const addReplacementReceipt = await bundlerAsBackup.waitForUserOperationReceipt({ hash: addReplacementHash })
  console.log(`   backup ALONE enrolled a replacement (addKey): ${EXPLORER}${addReplacementReceipt.receipt.transactionHash}`)

  // (c) backup ALONE removes the lost primary → 2 keys (above the ≥2 guard)
  const removeHash = await bundlerAsBackup.sendUserOperation({
    calls: [{ to: treasury.address, value: 0n, data: encodeFunctionData({ abi: HYBRID_KEY_ABI, functionName: 'removeKey', args: [primary.keyId] }) }],
  })
  const removeReceipt = await bundlerAsBackup.waitForUserOperationReceipt({ hash: removeHash })
  console.log(`✅ CLAIM 4 — RECOVERY: backup signer alone enrolled a replacement and removed the lost primary: ${EXPLORER}${removeReceipt.receipt.transactionHash}`)

  const finalCount = (await publicClient.readContract({
    address: treasury.address,
    abi: [{ name: 'getKeyIdHashesCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'getKeyIdHashesCount',
  })) as bigint
  console.log(`   account now holds ${finalCount} signers (backup + replacement); primary is gone.\n`)

  console.log('All four claims proven. Paste the tx links on epic #836 / #884.')
  console.log('Finding for the epic: pure-passkey Hybrids block dropping below 2 keys — recovery MUST enroll a replacement before removing the lost key; single-passkey accounts have no recovery path.')
}

main().catch((e) => {
  console.error('passkey spike failed:', e instanceof Error ? (e.stack ?? e.message) : e)
  process.exit(1)
})
