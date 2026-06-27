/**
 * QA dev-identity seed (epic #573, #574 item 1).
 *
 * Idempotently provisions the dedicated QA identity on **Base Sepolia (84532)**
 * against the shared dev backend, so the deterministic money-flow harness (#575)
 * has a real agent + Safe + on-chain allowance to run against:
 *
 *   1. QA user        — POST /auth/signup (falls back to /auth/login)
 *   2. QA Safe        — EOA-owned Safe (owner = SEED_OWNER key, threshold 1),
 *                       deployed via SafeProxyFactory and linked via POST /user/safes
 *   3. Spend gate     — owner-signed multiSend {enableModule, addDelegate,
 *                       setAllowance} relayed through POST /safe-exec
 *   4. QA Agent       — POST /agents with the delegate address + USDC allowance
 *
 * It then prints the `QA_*` env block (#574 secrets) for the harness.
 *
 * ── Funding model (verified against backend `lib/allowance-module.ts`) ────────
 *   - The **delegate signs only** — it never submits a tx, so it needs no gas
 *     and no pre-funded USDC. Pass only its *address* here (SEED_DELEGATE_ADDRESS).
 *   - The **Safe** holds the spendable test **USDC** (fund via Circle faucet).
 *   - The dev **relayer** (RELAYER_PRIVATE_KEY on the backend) pays gas for the
 *     allowance transfers and for the /safe-exec relay.
 *   - The **SEED_OWNER** EOA needs a little Base Sepolia **ETH** for the one-time
 *     Safe deploy (it sends that one tx itself).
 *
 * ⚠️ The on-chain steps are NOT exercised in CI (no funded testnet wallets here).
 *    Run this once against funded Base Sepolia wallets; iterate on any on-chain
 *    error. Everything is testnet/dev-only — never a production credential.
 *
 * Run:  npx tsx packages/qa-agent/src/seed.ts
 */

import { ethers } from 'ethers'

// ── Base Sepolia (84532) constants ───────────────────────────────────────────
// Source of truth: backend `lib/chains.ts` (BASE_SEPOLIA). Mirrored here to keep
// this package self-contained. Every address verified deployed on Base Sepolia
// via eth_getCode. NOTE: the AllowanceModule is the **v0.1.1** deployment
// (0xAA46…) — v0.1.0's 0xCFbF… address is NOT on Base Sepolia (identical ABI).
const CHAIN_ID = 84532
const ADDR = {
  safeProxyFactory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC',
  safeSingletonL2: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
  fallbackHandler: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804',
  allowanceModule: '0xAA46724893dedD72658219405185Fb0Fc91e091C',
  multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const
const ZERO = '0x0000000000000000000000000000000000000000'
const USDC_DECIMALS = 6

// ── Config ───────────────────────────────────────────────────────────────────
interface SeedConfig {
  apiUrl: string
  rpcUrl: string
  ownerKey: string
  delegateAddress: string
  paymentTo: string
  qaEmail: string
  qaPassword: string
  allowanceUsdc: string
  resetMin: number
}

function loadSeedConfig(env: NodeJS.ProcessEnv = process.env): SeedConfig {
  const missing: string[] = []
  const req = (name: string): string => {
    const v = env[name]?.trim()
    if (!v) missing.push(name)
    return v ?? ''
  }
  const cfg: SeedConfig = {
    apiUrl: req('SEED_HAVEN_API_URL').replace(/\/+$/, ''),
    rpcUrl: (env.SEED_RPC_URL?.trim() || 'https://sepolia.base.org').replace(/\/+$/, ''),
    ownerKey: req('SEED_OWNER_PRIVATE_KEY'),
    delegateAddress: req('SEED_DELEGATE_ADDRESS'),
    paymentTo: req('SEED_PAYMENT_TO'),
    qaEmail: req('SEED_QA_EMAIL'),
    qaPassword: req('SEED_QA_PASSWORD'),
    allowanceUsdc: env.SEED_ALLOWANCE_USDC?.trim() || '5',
    resetMin: Number(env.SEED_RESET_MIN?.trim() || '1440'),
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required seed env: ${missing.join(', ')}. ` +
        `All values are testnet/dev-only — see docs/operations/agent-qa.md.`,
    )
  }
  if (!ethers.isAddress(cfg.delegateAddress)) {
    throw new Error(`SEED_DELEGATE_ADDRESS is not a valid address: ${cfg.delegateAddress}`)
  }
  if (!ethers.isAddress(cfg.paymentTo)) {
    throw new Error(`SEED_PAYMENT_TO is not a valid address: ${cfg.paymentTo}`)
  }
  return cfg
}

// ── Backend HTTP helper (Node → API, server-to-server, no CORS) ──────────────
async function api<T>(
  cfg: SeedConfig,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${text}`) as Error & {
      status: number
      json: unknown
    }
    err.status = res.status
    err.json = json
    throw err
  }
  return json as T
}

// ── Phase 1: QA user (signup, fall back to login) ────────────────────────────
async function ensureUser(cfg: SeedConfig): Promise<string> {
  try {
    const r = await api<{ token: string }>(cfg, 'POST', '/auth/signup', {
      body: { name: 'QA Bot', email: cfg.qaEmail, password: cfg.qaPassword },
    })
    console.log('  ✓ created QA user')
    return r.token
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status !== 409) throw e
    const r = await api<{ token: string }>(cfg, 'POST', '/auth/login', {
      body: { email: cfg.qaEmail, password: cfg.qaPassword },
    })
    console.log('  ✓ QA user exists — logged in')
    return r.token
  }
}

// ── Phase 2: QA Safe (reuse if the user already has one on 84532) ────────────
interface UserSafe {
  id: string
  safe_address: string
  chain_id: number
}

async function ensureSafe(
  cfg: SeedConfig,
  token: string,
  owner: ethers.Wallet,
): Promise<UserSafe> {
  const existing = await api<UserSafe[]>(cfg, 'GET', '/user/safes', { token })
  const onChain = existing.find((s) => s.chain_id === CHAIN_ID)
  if (onChain) {
    console.log(`  ✓ reusing linked Safe ${onChain.safe_address}`)
    return onChain
  }

  console.log('  • deploying a new EOA-owned Safe (owner pays one-time gas)…')
  const safeAddress = await deploySafe(cfg, owner)
  console.log(`  ✓ Safe deployed: ${safeAddress}`)

  await api(cfg, 'POST', '/user/safes', {
    token,
    body: { safe_address: safeAddress, chain_id: CHAIN_ID, name: 'QA Safe' },
  })
  console.log('  ✓ Safe linked to QA user')
  const refreshed = await api<UserSafe[]>(cfg, 'GET', '/user/safes', { token })
  const safe = refreshed.find((s) => s.safe_address.toLowerCase() === safeAddress.toLowerCase())
  if (!safe) throw new Error('Linked Safe not found after POST /user/safes')
  return safe
}

// Mirrors backend `relaySafeDeploy` — single owner, threshold 1, no modules — but
// sent from the owner wallet itself (headless, no relayer key needed locally).
async function deploySafe(cfg: SeedConfig, owner: ethers.Wallet): Promise<string> {
  const setupIface = new ethers.Interface([
    'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  ])
  const initializer = setupIface.encodeFunctionData('setup', [
    [owner.address],
    1,
    ZERO,
    '0x',
    ADDR.fallbackHandler,
    ZERO,
    0,
    ZERO,
  ])
  const factory = new ethers.Contract(
    ADDR.safeProxyFactory,
    [
      'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
      'event ProxyCreation(address proxy, address singleton)',
    ],
    owner,
  )
  const saltNonce = BigInt(Date.now())
  const tx = await factory.createProxyWithNonce(ADDR.safeSingletonL2, initializer, saltNonce)
  const receipt = await tx.wait()
  const iface = new ethers.Interface([
    'event ProxyCreation(address proxy, address singleton)',
  ])
  const topic = iface.getEvent('ProxyCreation')!.topicHash
  const log = (receipt.logs as ethers.Log[]).find(
    (l) =>
      l.address.toLowerCase() === ADDR.safeProxyFactory.toLowerCase() && l.topics[0] === topic,
  )
  if (!log) throw new Error('ProxyCreation event not found in deploy receipt')
  return iface.decodeEventLog('ProxyCreation', log.data, log.topics).proxy as string
}

// ── Phase 3: enable module + addDelegate + setAllowance (owner-signed) ────────
// Built as one multiSend and relayed via POST /safe-exec (the dev relayer pays
// gas). Each sub-step is included only if not already on-chain (idempotent).
async function ensureAllowance(
  cfg: SeedConfig,
  token: string,
  safe: UserSafe,
  owner: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
): Promise<void> {
  const safeC = new ethers.Contract(
    safe.safe_address,
    [
      'function isModuleEnabled(address module) view returns (bool)',
      'function nonce() view returns (uint256)',
      'function enableModule(address module)',
    ],
    provider,
  )
  const moduleC = new ethers.Contract(
    ADDR.allowanceModule,
    [
      'function addDelegate(address delegate)',
      'function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)',
      'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
    ],
    provider,
  )

  const moduleEnabled: boolean = await safeC.isModuleEnabled(ADDR.allowanceModule)
  const current = (await moduleC.getTokenAllowance(
    safe.safe_address,
    cfg.delegateAddress,
    ADDR.usdc,
  )) as bigint[]
  // getTokenAllowance returns [amount, spent, resetTimeMin, lastResetMin, nonce].
  const desired = ethers.parseUnits(cfg.allowanceUsdc, USDC_DECIMALS)
  if (moduleEnabled && current[0] === desired) {
    console.log('  ✓ module enabled + allowance already set — skipping')
    return
  }

  // Build the inner calls.
  const inner: { to: string; data: string }[] = []
  if (!moduleEnabled) {
    inner.push({
      to: safe.safe_address,
      data: safeC.interface.encodeFunctionData('enableModule', [ADDR.allowanceModule]),
    })
  }
  inner.push({
    to: ADDR.allowanceModule,
    data: moduleC.interface.encodeFunctionData('addDelegate', [cfg.delegateAddress]),
  })
  inner.push({
    to: ADDR.allowanceModule,
    data: moduleC.interface.encodeFunctionData('setAllowance', [
      cfg.delegateAddress,
      ADDR.usdc,
      desired,
      cfg.resetMin,
      0, // resetBaseMin — start the window now
    ]),
  })

  const multiSendData = encodeMultiSend(inner)
  const nonce: bigint = await safeC.nonce()

  // SafeTx EIP-712 — domain + types mirror backend routes/safe-exec.ts exactly.
  const domain = { chainId: CHAIN_ID, verifyingContract: safe.safe_address }
  const types = {
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  }
  const message = {
    to: ADDR.multiSendCallOnly,
    value: 0n,
    data: multiSendData,
    operation: 1, // delegatecall — required for MultiSendCallOnly
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  }
  const safeTxHash = ethers.TypedDataEncoder.hash(domain, types, message)
  // EOA owner, threshold 1: a raw ECDSA signature over the EIP-712 safeTxHash
  // (v=27/28) is what Safe's checkSignatures verifies.
  const signature = owner.signingKey.sign(safeTxHash).serialized

  await api(cfg, 'POST', '/safe-exec/exec', {
    token,
    body: {
      chain_id: CHAIN_ID,
      safe_address: safe.safe_address,
      to: message.to,
      value: '0',
      data: message.data,
      operation: 1,
      safe_tx_gas: '0',
      base_gas: '0',
      gas_price: '0',
      gas_token: ZERO,
      refund_receiver: ZERO,
      nonce: nonce.toString(),
      signatures: signature,
    },
  })
  console.log(
    `  ✓ allowance set: ${cfg.allowanceUsdc} USDC → delegate, reset ${cfg.resetMin} min`,
  )
}

// Safe MultiSend payload: per tx = operation(1) ‖ to(20) ‖ value(32) ‖ len(32) ‖ data.
function encodeMultiSend(txs: { to: string; data: string }[]): string {
  const packed = txs
    .map((t) => {
      const data = t.data.startsWith('0x') ? t.data.slice(2) : t.data
      const len = data.length / 2
      return (
        '00' + // operation = call
        t.to.slice(2).toLowerCase().padStart(40, '0') +
        '0'.repeat(64) + // value = 0
        BigInt(len).toString(16).padStart(64, '0') +
        data
      )
    })
    .join('')
  const iface = new ethers.Interface(['function multiSend(bytes transactions)'])
  return iface.encodeFunctionData('multiSend', ['0x' + packed])
}

// ── Phase 4: QA agent (reuse if one already maps to this delegate) ───────────
interface Agent {
  id: string
  name: string
  delegate_address: string | null
}

async function ensureAgent(
  cfg: SeedConfig,
  token: string,
  safe: UserSafe,
): Promise<{ apiKey: string | null }> {
  const agents = await api<Agent[]>(cfg, 'GET', '/agents', { token })
  const existing = agents.find(
    (a) => a.delegate_address?.toLowerCase() === cfg.delegateAddress.toLowerCase(),
  )
  if (existing) {
    console.log(`  ✓ QA agent already exists (${existing.id}) — api key not re-shown`)
    return { apiKey: null }
  }
  const created = await api<{ api_key?: string; secret?: string }>(cfg, 'POST', '/agents', {
    token,
    body: {
      name: 'QA Agent',
      description: 'Automated QA harness identity (epic #573). Testnet-only.',
      delegate_address: cfg.delegateAddress,
      safe_id: safe.id,
      allowances: [
        {
          token_symbol: 'USDC',
          token_address: ADDR.usdc,
          allowance_amount: cfg.allowanceUsdc,
          reset_period_min: cfg.resetMin,
        },
      ],
    },
  })
  console.log('  ✓ QA agent created')
  return { apiKey: created.api_key ?? created.secret ?? null }
}

// ── Orchestration ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const cfg = loadSeedConfig()
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl)
  const net = await provider.getNetwork()
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`SEED_RPC_URL is chain ${net.chainId}, expected Base Sepolia (${CHAIN_ID}).`)
  }
  const owner = new ethers.Wallet(cfg.ownerKey, provider)
  const ownerEth = await provider.getBalance(owner.address)
  console.log(`Seeding QA identity on Base Sepolia → ${cfg.apiUrl}`)
  console.log(`  owner ${owner.address}  (${ethers.formatEther(ownerEth)} ETH)`)
  if (ownerEth === 0n) {
    console.warn('  ⚠ owner has 0 ETH — a fresh Safe deploy will fail. Fund it first.')
  }

  console.log('\n[1/4] QA user')
  const token = await ensureUser(cfg)
  console.log('\n[2/4] QA Safe')
  const safe = await ensureSafe(cfg, token, owner)
  console.log('\n[3/4] Spend gate (module + delegate + allowance)')
  await ensureAllowance(cfg, token, safe, owner, provider)
  console.log('\n[4/4] QA agent')
  const { apiKey } = await ensureAgent(cfg, token, safe)

  console.log('\n─── QA env (set as #574 secrets — testnet/dev-only) ───')
  console.log(`QA_HAVEN_API_URL=${cfg.apiUrl}`)
  console.log(`QA_PAYMENT_TO=${cfg.paymentTo}`)
  console.log('QA_DELEGATE_PRIVATE_KEY=<the delegate key for ' + cfg.delegateAddress + '>')
  if (apiKey) {
    console.log(`QA_AGENT_API_KEY=${apiKey}`)
  } else {
    console.log('QA_AGENT_API_KEY=<unchanged — agent already existed; rotate via dashboard if lost>')
  }
  console.log('\nSafe (fund with Base Sepolia USDC): ' + safe.safe_address)
  console.log('Done.')
}

main().catch((e) => {
  console.error('\n✗ seed failed:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
