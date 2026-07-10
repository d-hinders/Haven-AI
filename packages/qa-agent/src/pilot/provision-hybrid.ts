/**
 * #825 live proof — provision Hybrid DeleGator accounts through the
 * PRODUCTION API (both owner variants), then prove on-chain deployment of
 * the EOA variant with one sponsored UserOp.
 *
 * 1. POST /accounts/hybrid { owner_address }          → counterfactual (EOA)
 * 2. POST /accounts/hybrid { passkeys: [P256 coords] } → counterfactual (passkey)
 * 3. Deploy variant 1 on-chain: ONE sponsored UserOp (no ETH anywhere) —
 *    proves the counterfactual address is real and records time-to-account
 *    for the #825 UX comparison vs the Safe deploy flow.
 *
 * The passkey variant uses a PROGRAMMATIC P256 keypair (Node crypto) — same
 * curve and coordinates as WebAuthn; the dashboard flow (#833) swaps in real
 * WebAuthn credentials. Testnet-only; throwaway keys; prints addresses and
 * tx links, never keys.
 *
 * Env (~/.haven/pilot.env): PILOT_API_URL, PILOT_DEV_EMAIL, PILOT_DEV_PASSWORD,
 *   PILOT_BUNDLER_URL (SECRET), PILOT_RPC_URL?
 *
 * Run: npm run pilot:provision-hybrid -w packages/qa-agent
 */

import { generateKeyPairSync } from 'node:crypto'
import { http, createPublicClient, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { entryPoint07Address } from 'viem/account-abstraction'
import { createSmartAccountClient } from 'permissionless'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { Implementation, toMetaMaskSmartAccount } from '@metamask/smart-accounts-kit'

const CHAIN = baseSepolia

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required.`)
    process.exit(2)
  }
  return value
}

async function api(base: string, method: string, path: string, body?: unknown, jwt?: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

/** A programmatic P256 keypair — WebAuthn's curve, raw coordinates. */
function generateP256(): { x: string; y: string } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const toHex = (b64url: string) => ('0x' + Buffer.from(b64url, 'base64url').toString('hex')) as Hex
  return { x: toHex(jwk.x), y: toHex(jwk.y) }
}

async function main(): Promise<void> {
  const base = requireEnv('PILOT_API_URL').replace(/\/$/, '')
  const bundlerUrl = requireEnv('PILOT_BUNDLER_URL')
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'

  const login = await api(base, 'POST', '/auth/login', {
    email: requireEnv('PILOT_DEV_EMAIL'),
    password: requireEnv('PILOT_DEV_PASSWORD'),
  })
  const jwt = login.json.token as string
  if (login.status !== 200 || !jwt) throw new Error(`dev login failed (${login.status})`)

  // ── Variant 1: EOA owner (fresh throwaway) ─────────────────────────────────
  const ownerKey = generatePrivateKey()
  const owner = privateKeyToAccount(ownerKey)
  const t0 = Date.now()
  const eoaRes = await api(base, 'POST', '/accounts/hybrid', {
    owner_address: owner.address,
    name: 'Pilot Hybrid (EOA)',
  }, jwt)
  if (eoaRes.status !== 201) throw new Error(`EOA provisioning failed (${eoaRes.status}): ${JSON.stringify(eoaRes.json)}`)
  const eoaAddress = eoaRes.json.account_address as `0x${string}`
  console.log(`✅ EOA variant provisioned in ${Date.now() - t0}ms (0 signatures, 0 txs)`)
  console.log(`   account: ${eoaAddress} (counterfactual)`)

  // ── Variant 2: pure passkey (programmatic P256) ────────────────────────────
  const p256 = generateP256()
  const t1 = Date.now()
  const pkRes = await api(base, 'POST', '/accounts/hybrid', {
    passkeys: [{ key_id: `pilot-${Date.now()}`, x: p256.x, y: p256.y }],
    name: 'Pilot Hybrid (passkey)',
  }, jwt)
  if (pkRes.status !== 201) throw new Error(`passkey provisioning failed (${pkRes.status}): ${JSON.stringify(pkRes.json)}`)
  console.log(`✅ passkey variant provisioned in ${Date.now() - t1}ms (0 signatures, 0 txs)`)
  console.log(`   account: ${pkRes.json.account_address} (counterfactual)`)

  // ── Deploy proof (EOA variant): ONE sponsored UserOp ───────────────────────
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) })
  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: '0x',
    signer: { account: owner },
  })
  if (smartAccount.address.toLowerCase() !== eoaAddress.toLowerCase()) {
    throw new Error(`API/local address mismatch: ${eoaAddress} vs ${smartAccount.address} — determinism broken!`)
  }
  console.log('   API and local derivation agree ✓')

  const pimlico = createPimlicoClient({
    transport: http(bundlerUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  })
  const accountClient = createSmartAccountClient({
    account: smartAccount,
    chain: CHAIN,
    bundlerTransport: http(bundlerUrl),
    paymaster: pimlico,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })
  const t2 = Date.now()
  const hash = await accountClient.sendUserOperation({
    calls: [{ to: smartAccount.address, value: 0n, data: '0x' }],
  })
  const receipt = await pimlico.waitForUserOperationReceipt({ hash })
  console.log(`✅ deployed with ONE sponsored UserOp in ${Date.now() - t2}ms (no ETH held anywhere)`)
  console.log(`   tx: https://sepolia.basescan.org/tx/${receipt.receipt.transactionHash}`)
  console.log('')
  console.log('UX comparison vs Safe deploy (#825 acceptance):')
  console.log('  Hybrid: address instant at provisioning (0 prompts); deploy = 1 sponsored')
  console.log('  UserOp, deferrable to first real operation (#828 grant deploys if needed).')
  console.log('  Safe:   deploy tx required before the address is usable end-to-end.')
}

main().catch((e) => {
  console.error('provision-hybrid failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
