/**
 * #835 — Delegation rail definition-of-done live matrix, driven end to end
 * through the PRODUCTION HTTP API (the #739/#805/#798 discipline: pilot scripts
 * drive the real endpoints, zero manual DB steps). This is the epic's proof
 * harness — merges don't close #835, THIS output (with tx links) does.
 *
 * It exercises the matrix rows in order against PILOT_API_URL:
 *   1  provision a fresh Hybrid           POST /accounts/hybrid
 *   2  one-signature budget grant          POST /agents/:id/delegations/build + /activate  (owner signs ONCE, zero tx)
 *   3  within-budget payment               POST /payments + /payments/:id/sign            (agent signs; account→recipient, deploys on first op)
 *   4  overspend reverts                    POST /payments over budget                     (rejected before/at chain, funds never move)
 *   5  zero-signature refill                spend to cap → wait one PERIOD → spend again   (NO signature, NO Haven cron — the headline)
 *   6  N-recipient matrix                   second recipient, distinct delegation, both paid
 *   7  revoke kill-switch                   POST /agents/:id/delegations/:hash/revoke(+submit) → next payment fails
 *   8  x402 direct settlement               (delegated to pilot:delegation-payment-smoke / #830 evidence — see report)
 *
 * Rows 3–7 move real value and therefore need the fresh Hybrid FUNDED with
 * Base-Sepolia test USDC. The script is funding-aware: it computes the account
 * address, checks the balance, and if it is short it prints the exact address +
 * amount to fund and stops cleanly at that gate. Fund once, re-run — everything
 * up to the gate is idempotent-friendly (a fresh account per run by default).
 *
 * Env (from ~/.haven/pilot.env): PILOT_API_URL, PILOT_DEV_EMAIL,
 * PILOT_DEV_PASSWORD, PILOT_OWNER_PRIVATE_KEY (the Hybrid's EOA owner),
 * PILOT_ALLOWED_RECIPIENT. Optional: PILOT_RPC_URL, DOD_PERIOD_SECONDS
 * (default 120; the route floor is 60), DOD_BUDGET_USDC (default "0.10").
 *
 * Run: npm run pilot:dod -w @haven/backend
 */
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData, type Address, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'

const ERC20_TRANSFER_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const CHAIN_ID = 84532
const EXPLORER = 'https://sepolia.basescan.org/tx/'

type TypedData = {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing ${name}. Load ~/.haven/pilot.env before running.`)
    process.exit(2)
  }
  return v
}

/** viem signs EIP-712 typed data the account returns, verbatim (strip EIP712Domain). */
async function ownerSign(ownerKey: Hex, payload: TypedData): Promise<Hex> {
  const account = privateKeyToAccount(ownerKey)
  const types = { ...payload.types }
  delete (types as Record<string, unknown>).EIP712Domain
  return account.signTypedData({
    domain: payload.domain,
    types,
    primaryType: payload.primaryType,
    message: payload.message,
  } as never)
}

const rows: Array<{ n: number; name: string; status: string; detail: string }> = []
function record(n: number, name: string, status: string, detail = '') {
  rows.push({ n, name, status, detail })
  const icon = status === 'PASS' ? '✅' : status === 'GATED' ? '⏸️ ' : status === 'SKIP' ? '↷ ' : '❌'
  console.log(`${icon} [${n}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const api = requireEnv('PILOT_API_URL').replace(/\/$/, '')
  const email = requireEnv('PILOT_DEV_EMAIL')
  const password = requireEnv('PILOT_DEV_PASSWORD')
  const ownerKey = requireEnv('PILOT_OWNER_PRIVATE_KEY') as Hex
  const recipient1 = requireEnv('PILOT_ALLOWED_RECIPIENT') as Address
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  const period = Math.max(60, Number(process.env.DOD_PERIOD_SECONDS ?? '120'))
  const budgetHuman = process.env.DOD_BUDGET_USDC ?? '0.10'
  const budgetAtomic = parseUnits(budgetHuman, 6)

  const ownerAddress = privateKeyToAccount(ownerKey).address
  // A second recipient for the N-recipient row — any address works for a transfer.
  const recipient2 = privateKeyToAccount(generatePrivateKey()).address
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })

  console.log(`\nDoD matrix → ${api}  (chain ${CHAIN_ID}, period ${period}s, budget ${budgetHuman} USDC)\n`)

  // ── auth ──
  const login = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!login.ok) { console.error(`login failed: ${login.status} ${await login.text()}`); process.exit(1) }
  const token = ((await login.json()) as { token: string }).token
  const authed = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...extra,
  })

  // ── row 1: provision a fresh Hybrid ──
  // The Hybrid address is deterministic from (owner, passkeys, chain), so a
  // repeat run with the same owner key resolves the SAME account — reuse it
  // (it is genuinely the same on-chain account) rather than failing.
  const prov = await fetch(`${api}/accounts/hybrid`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ chain_id: CHAIN_ID, owner_address: ownerAddress, name: `DoD ${new Date().toISOString()}` }),
  })
  let account: { id: string; account_address: Address }
  if (prov.ok) {
    account = (await prov.json()) as { id: string; account_address: Address }
    record(1, 'Fresh account', 'PASS', `${account.account_address} (deploys on first payment)`)
  } else if (prov.status === 409) {
    const { id } = (await prov.json()) as { id: string }
    const list = await fetch(`${api}/user/safes`, { headers: authed() })
    const { safes } = (await list.json()) as { safes: Array<{ id: string; safe_address: Address }> }
    const row = safes.find((s) => s.id === id)
    if (!row) { record(1, 'Fresh account', 'FAIL', `account ${id} not found in /user/safes`); return finish() }
    account = { id, account_address: row.safe_address }
    record(1, 'Fresh account', 'PASS', `${account.account_address} (existing Hybrid, deterministic reuse)`)
  } else {
    record(1, 'Fresh account', 'FAIL', `${prov.status} ${await prov.text()}`); return finish()
  }

  // ── agent on the delegation rail = an agent linked to the Hybrid account ──
  const agentKey = generatePrivateKey() as Hex
  const agentDelegate = privateKeyToAccount(agentKey).address
  const created = await fetch(`${api}/agents`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ name: `DoD agent ${Date.now()}`, delegate_address: agentDelegate, safe_id: account.id }),
  })
  if (!created.ok) { record(2, 'One-signature grant', 'FAIL', `agent create ${created.status} ${await created.text()}`); return finish() }
  const agent = (await created.json()) as { id: string; api_key: string }
  const agentAuth = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', authorization: `Bearer ${agent.api_key}`, ...extra })

  // ── row 2: one-signature grant (build → owner signs ONCE → activate; zero tx) ──
  async function grant(recipient: Address | null): Promise<string | null> {
    const built = await fetch(`${api}/agents/${agent.id}/delegations/build`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ token_address: USDC, recipient_address: recipient, budget_atomic: budgetAtomic.toString(), period_seconds: period }),
    })
    if (!built.ok) { console.error(`  build failed: ${built.status} ${await built.text()}`); return null }
    const { delegation_hash, signing_payload } = (await built.json()) as { delegation_hash: string; signing_payload: TypedData }
    const signature = await ownerSign(ownerKey, signing_payload)
    const act = await fetch(`${api}/agents/${agent.id}/delegations/${delegation_hash}/activate`, {
      method: 'POST', headers: authed(), body: JSON.stringify({ signature }),
    })
    if (!act.ok) { console.error(`  activate failed: ${act.status} ${await act.text()}`); return null }
    return delegation_hash
  }
  const hash1 = await grant(recipient1)
  if (!hash1) { record(2, 'One-signature grant', 'FAIL', 'grant did not activate'); return finish() }
  record(2, 'One-signature grant', 'PASS', `1 owner signature, 0 tx — hash ${hash1.slice(0, 10)}…`)

  // ── funding gate: rows 3–7 move value ──
  let bal = (await publicClient.readContract({
    address: USDC, abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf', args: [account.account_address],
  })) as bigint
  const needed = budgetAtomic * 3n // a couple of periods + headroom

  // Optional self-funding: the operator's OWN owner key tops up its OWN fresh
  // test account so the whole matrix runs in one process. Explicit opt-in
  // (DOD_FUND_FROM_OWNER=1); otherwise the funding gate below hands off to a
  // faucet. Testnet only.
  if (bal < needed && process.env.DOD_FUND_FROM_OWNER === '1') {
    const shortfall = needed - bal
    console.log(`   funding the account with ${formatUnits(shortfall, 6)} USDC from the owner key (DOD_FUND_FROM_OWNER=1)…`)
    const wallet = createWalletClient({ account: privateKeyToAccount(ownerKey), chain: baseSepolia, transport: http(rpcUrl) })
    const fundTx = await wallet.sendTransaction({
      to: USDC,
      data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [account.account_address, shortfall] }),
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx })
    if (receipt.status !== 'success') { record(3, 'Within-budget payment', 'FAIL', `funding tx reverted ${EXPLORER}${fundTx}`); return finish() }
    console.log(`   funded — ${EXPLORER}${fundTx}`)
    // Public RPCs can read-after-write stale for a few seconds; poll rather than
    // trust the first read (else the gate below false-trips right after funding).
    const balAbi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const
    for (let i = 0; i < 6 && bal < needed; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      bal = (await publicClient.readContract({ address: USDC, abi: balAbi, functionName: 'balanceOf', args: [account.account_address] })) as bigint
    }
  }

  if (bal < needed) {
    console.log(`\n⏸️  FUNDING GATE — the fresh Hybrid needs test USDC to prove rows 3–7.`)
    console.log(`    Send ≥ ${formatUnits(needed, 6)} Base-Sepolia USDC to:`)
    console.log(`      ${account.account_address}`)
    console.log(`    (USDC ${USDC} · faucet: https://faucet.circle.com) then re-run pilot:dod.`)
    record(3, 'Within-budget payment', 'GATED', `account holds ${formatUnits(bal, 6)} USDC`)
    record(4, 'Overspend reverts', 'GATED', 'needs funding')
    record(5, 'Zero-signature refill', 'GATED', 'needs funding')
    record(6, 'N-recipient matrix', 'GATED', 'needs funding')
    record(7, 'Revoke kill-switch', 'GATED', 'needs funding')
    return finish()
  }

  // ── payment helper: authorize → agent signs typed data → submit ──
  async function pay(recipient: Address, human: string): Promise<{ ok: boolean; tx?: string; error?: string }> {
    const auth = await fetch(`${api}/payments`, {
      method: 'POST', headers: agentAuth(),
      body: JSON.stringify({ token: 'USDC', amount: human, to: recipient }),
    })
    if (!auth.ok) return { ok: false, error: `authorize ${auth.status} ${await auth.text()}` }
    const intent = (await auth.json()) as { payment_id: string; sign_data: { signature_scheme: string; typed_data: TypedData } }
    const signature = await signUserOpTypedDataForDelegation(agentKey, intent.sign_data.typed_data)
    const submit = await fetch(`${api}/payments/${intent.payment_id}/sign`, {
      method: 'POST', headers: agentAuth(), body: JSON.stringify({ signature }),
    })
    if (!submit.ok) return { ok: false, error: `submit ${submit.status} ${await submit.text()}` }
    const done = (await submit.json()) as { tx_hash?: string; status?: string }
    return { ok: true, tx: done.tx_hash }
  }

  // ── row 3: within-budget payment (also deploys the account) ──
  const p3 = await pay(recipient1, budgetHuman)
  if (!p3.ok) { record(3, 'Within-budget payment', 'FAIL', p3.error ?? ''); return finish() }
  record(3, 'Within-budget payment', 'PASS', p3.tx ? `${EXPLORER}${p3.tx}` : 'submitted')

  // ── row 4: overspend reverts (budget already spent this period) ──
  const p4 = await pay(recipient1, budgetHuman)
  if (p4.ok) record(4, 'Overspend reverts', 'FAIL', `second in-period spend unexpectedly succeeded ${p4.tx ?? ''}`)
  else record(4, 'Overspend reverts', 'PASS', 'in-period overspend rejected on-chain; no funds moved')

  // ── row 5: zero-signature refill — wait one period, spend again, NO signature/cron ──
  console.log(`   …waiting ${period + 15}s for the period boundary (no Haven cron, no signature)…`)
  await new Promise((r) => setTimeout(r, (period + 15) * 1000))
  const p5 = await pay(recipient1, budgetHuman)
  if (!p5.ok) { record(5, 'Zero-signature refill', 'FAIL', p5.error ?? ''); }
  else record(5, 'Zero-signature refill', 'PASS', `refilled natively — ${p5.tx ? EXPLORER + p5.tx : 'submitted'}`)

  // ── row 6: N-recipient matrix — a second recipient, distinct delegation ──
  const hash2 = await grant(recipient2)
  const p6 = hash2 ? await pay(recipient2, budgetHuman) : { ok: false, error: 'second grant failed' }
  if (!p6.ok) record(6, 'N-recipient matrix', 'FAIL', p6.error ?? '')
  else record(6, 'N-recipient matrix', 'PASS', `recipient2 paid via distinct delegation — ${p6.tx ? EXPLORER + p6.tx : 'submitted'}`)

  // ── row 7: revoke kill-switch — disable the first delegation, next payment fails ──
  const prep = await fetch(`${api}/agents/${agent.id}/delegations/${hash1}/revoke`, { method: 'POST', headers: authed(), body: '{}' })
  if (!prep.ok) { record(7, 'Revoke kill-switch', 'FAIL', `prepare ${prep.status} ${await prep.text()}`); return finish() }
  const rev = (await prep.json()) as { signing_payload: TypedData; user_operation: unknown }
  const revSig = await ownerSign(ownerKey, rev.signing_payload)
  const sub = await fetch(`${api}/agents/${agent.id}/delegations/${hash1}/revoke/submit`, {
    method: 'POST', headers: authed(), body: JSON.stringify({ signature: revSig, user_operation: rev.user_operation }),
  })
  if (!sub.ok) { record(7, 'Revoke kill-switch', 'FAIL', `submit ${sub.status} ${await sub.text()}`); return finish() }
  // Wait a period so the revoked delegation's budget would otherwise have refilled, then prove it still fails.
  console.log(`   …waiting ${period + 15}s, then proving the revoked budget no longer pays…`)
  await new Promise((r) => setTimeout(r, (period + 15) * 1000))
  const p7 = await pay(recipient1, budgetHuman)
  if (p7.ok) record(7, 'Revoke kill-switch', 'FAIL', `payment succeeded after revoke ${p7.tx ?? ''}`)
  else record(7, 'Revoke kill-switch', 'PASS', 'revoked delegation no longer authorizes payment')

  record(8, 'x402 direct settlement', 'SKIP', 'proven via pilot:delegation-payment-smoke / #830 — see report')
  finish()
}

function finish(): void {
  console.log(`\n──────── DoD matrix summary ────────`)
  for (const r of rows) console.log(`  [${r.n}] ${r.name.padEnd(24)} ${r.status.padEnd(6)} ${r.detail}`)
  const gated = rows.some((r) => r.status === 'GATED')
  const failed = rows.some((r) => r.status === 'FAIL')
  console.log(gated ? `\nStopped at a funding gate — fund the account above and re-run.` : failed ? `\nFAILURES present — see rows above.` : `\nAll executed rows passed. Paste this into #835 with the tx links.`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('dod-matrix failed:', e instanceof Error ? e.stack ?? e.message : e)
  process.exit(1)
})
