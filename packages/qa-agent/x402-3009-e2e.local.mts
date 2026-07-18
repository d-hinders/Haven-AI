/**
 * #946 LIVE PROOF (Base Sepolia, dev stack) — delegation-rail agent pays an
 * EIP-3009-only merchant end-to-end through the production API + SDK.
 *
 * Steps (resumable — state in ~/.haven/pilot-3009.json, keys never printed):
 *  1. login (dev creds) → provision a Hybrid treasury (EOA owner, testnet)
 *  2. create an agent bound to it (client-generated delegate key)
 *  3. build + owner-sign + activate an OPEN budget delegation (2 USDC / day)
 *  4. fund the treasury with 1 USDC from the pilot Safe (owner-signed)
 *  5. HavenClient.fetch → demo-merchant buy_vpn (0.001 USDC): 402 → 3009-mode
 *     funding redemption → EIP-3009 header → merchant settles.
 *
 * Untracked one-off (.local.mts). Testnet only.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'
import { HavenClient } from '@haven_ai/sdk'
import { SAFE_ABI, execSafeTransactionAsOwner } from './src/pilot/provision-lib.js'

const STATE_PATH = path.join(homedir(), '.haven', 'pilot-3009.json')
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const CHAIN_ID = 84532
const RPC = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
const API = (process.env.PILOT_API_URL ?? '').replace(/\/$/, '')
const MERCHANT = 'https://demo-merchant-dev-84e4.up.railway.app'

function req(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} saknas — source ~/.haven/pilot.env`); process.exit(2) }
  return v
}

interface State {
  ownerKey?: string
  delegateKey?: string
  accountAddress?: string
  safeId?: string
  agentId?: string
  apiKey?: string
  delegationHash?: string
  activated?: boolean
  funded?: boolean
}
const state: State = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))

async function api(method: string, p: string, body?: unknown, jwt?: string) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json as Record<string, never>
}

async function main() {
  req('PILOT_API_URL')
  const login = await api('POST', '/auth/login', {
    email: req('PILOT_DEV_EMAIL'),
    password: req('PILOT_DEV_PASSWORD'),
  })
  const jwt = (login as { token?: string; access_token?: string }).token ??
    (login as { access_token?: string }).access_token
  if (!jwt) throw new Error('login gav ingen token')
  console.log('1. inloggad')

  if (!state.ownerKey) { state.ownerKey = ethers.Wallet.createRandom().privateKey; save() }
  if (!state.delegateKey) { state.delegateKey = ethers.Wallet.createRandom().privateKey; save() }
  const owner = new ethers.Wallet(state.ownerKey)
  const delegate = new ethers.Wallet(state.delegateKey)

  if (!state.accountAddress) {
    const acct = await api('POST', '/accounts/hybrid', {
      chain_id: CHAIN_ID, name: '3009 pilot treasury', owner_address: owner.address,
    }, jwt) as { id: string; account_address: string }
    state.accountAddress = acct.account_address
    state.safeId = acct.id
    save()
  }
  console.log(`2. treasury Hybrid: ${state.accountAddress}`)

  if (!state.agentId) {
    const agent = await api('POST', '/agents', {
      name: '3009 pilot agent',
      description: '#946 live proof',
      delegate_address: delegate.address,
      safe_id: state.safeId,
    }, jwt) as { id: string; api_key: string }
    state.agentId = agent.id
    state.apiKey = agent.api_key
    save()
  }
  console.log(`3. agent: ${state.agentId} (delegat ${delegate.address})`)

  if (!state.delegationHash) {
    const built = await api('POST', `/agents/${state.agentId}/delegations/build`, {
      token_address: USDC,
      recipient_address: null, // OPEN budget — kravet för 3009-läget
      budget_atomic: '2000000', // 2 USDC
      period_seconds: 86_400,
    }, jwt) as { delegation_hash: string; signing_payload: { domain: object; types: Record<string, unknown>; message: object; primaryType: string } }
    state.delegationHash = built.delegation_hash
    save()
    const sp = built.signing_payload
    const types = { ...sp.types } as Record<string, unknown>
    delete types.EIP712Domain
    const signature = await owner.signTypedData(sp.domain as never, types as never, sp.message as never)
    await api('POST', `/agents/${state.agentId}/delegations/${built.delegation_hash}/activate`, { signature }, jwt)
    state.activated = true
    save()
  } else if (!state.activated) {
    throw new Error('delegation byggd men inte aktiverad — radera ~/.haven/pilot-3009.json och kör om')
  }
  console.log(`4. öppen budget aktiverad: ${state.delegationHash}`)

  if (!state.funded) {
    const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID)
    const usdc = new ethers.Contract(USDC, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], provider)
    const bal = await usdc.balanceOf(state.accountAddress)
    if (bal >= 1_000_000n) {
      console.log('5. treasury redan finansierat')
    } else {
      const pilotSafeOwner = new ethers.Wallet(req('PILOT_OWNER_PRIVATE_KEY'), provider)
      const pilotSafe = new ethers.Contract(req('PILOT_SAFE_ADDRESS'), SAFE_ABI, pilotSafeOwner)
      const data = usdc.interface.encodeFunctionData('transfer', [state.accountAddress, 1_000_000n])
      const receipt = await execSafeTransactionAsOwner(pilotSafe, pilotSafeOwner, {
        chainId: CHAIN_ID, to: USDC, data, operation: 0,
      })
      console.log(`5. treasury finansierat med 1 USDC: ${receipt.hash}`)
    }
    state.funded = true
    save()
  }

  console.log('6. kör betalningen: agent → demo-merchant (EIP-3009-only)…')
  const client = new HavenClient({
    apiKey: state.apiKey!,
    delegateKey: state.delegateKey as `0x${string}`,
    baseUrl: API,
    chainRpcs: { [CHAIN_ID]: RPC },
  })
  const res = await client.fetch(`${MERCHANT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    }),
  })
  const text = await res.text()
  console.log(`   HTTP ${res.status}`)
  console.log(`   ${text.slice(0, 400).replace(/\n/g, ' ')}`)
  if (!res.ok) process.exit(1)
  console.log('\n✅ #946 LIVE-BEVISAT: delegationsräls-agent betalade en EIP-3009-merchant end-to-end.')
}

main().catch((err) => {
  console.error('E2E fail:', err instanceof Error ? err.message.replace(/apikey=[A-Za-z0-9_]*/g, 'apikey=REDACTED') : err)
  process.exit(1)
})
