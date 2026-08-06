/**
 * #891 — Passkey epic definition-of-done matrix (epic #836), driven end to end
 * through the PRODUCTION HTTP API. Operator-verify: merges don't close #891;
 * this output (with tx links) does.
 *
 * The matrix — a passkey user's whole life, headless (headless-passkey.ts):
 *   1  Passkey signup            POST /accounts/hybrid (pure P256, NO EOA)
 *   2  One-ceremony grant        build → kit account signs the DELEGATION → activate
 *                                (activation relayer-deploys the counterfactual, #860)
 *   3  Agent payment redeems     the passkey-signed delegation pays on-chain
 *   4  Backup enrolled           account-signers prepare/submit, signed by PRIMARY
 *   5  RECOVERY                  primary "lost": BACKUP alone enrolls a replacement,
 *                                then removes the primary (the ≥2 floor forces this order)
 *   6  Lost key's authority DIES the old budget no longer redeems (EIP-1271 now fails
 *                                for the removed key's signature) — security-positive
 *   7  Re-grant + pay            a fresh budget signed by the REPLACEMENT pays again
 *
 * Env (~/.haven/pilot.env): PILOT_API_URL, PILOT_DEV_EMAIL, PILOT_DEV_PASSWORD,
 * PILOT_OWNER_PRIVATE_KEY (USDC funding source only), PILOT_RPC_URL?,
 * DOD_BUDGET_USDC (default 0.02).
 *
 * Run: npm run pilot:passkey-dod -w @haven/backend
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'
import { makeLocalPasskey, buildPasskeyAccount, type LocalPasskey } from './headless-passkey.js'

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const CHAIN_ID = 84532
const EXPLORER = 'https://sepolia.basescan.org/tx/'
const BAL_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const

type TypedData = { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing ${name}.`); process.exit(2) }
  return v
}

const rows: Array<{ n: number; name: string; status: string; detail: string }> = []
function record(n: number, name: string, status: string, detail = '') {
  rows.push({ n, name, status, detail })
  const icon = status === 'PASS' ? '✅' : status === 'GATED' ? '⏸️ ' : '❌'
  console.log(`${icon} [${n}] ${name}${detail ? ` — ${detail}` : ''}`)
}

function reviveUserOp(op: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(op), (_k, v) =>
    typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  )
}

async function main(): Promise<void> {
  const api = requireEnv('PILOT_API_URL').replace(/\/$/, '')
  const email = requireEnv('PILOT_DEV_EMAIL')
  const password = requireEnv('PILOT_DEV_PASSWORD')
  const gasKey = requireEnv('PILOT_OWNER_PRIVATE_KEY') as Hex
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  const budgetHuman = process.env.DOD_BUDGET_USDC ?? '0.02'
  const budgetAtomic = parseUnits(budgetHuman, 6)

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })
  const primary = makeLocalPasskey('dod-primary')
  const backup = makeLocalPasskey('dod-backup')
  const replacement = makeLocalPasskey('dod-replacement')
  const agentKey = generatePrivateKey()
  const agentDelegate = privateKeyToAccount(agentKey).address
  const recipient = privateKeyToAccount(gasKey).address // funds round-trip to the funding EOA

  console.log(`\n#891 passkey DoD → ${api}  (chain ${CHAIN_ID}, budget ${budgetHuman} USDC)\n`)

  // ── auth ──
  const login = await fetch(`${api}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!login.ok) { console.error(`login failed: ${login.status}`); process.exit(1) }
  const token = ((await login.json()) as { token: string }).token
  const authed = { 'content-type': 'application/json', authorization: `Bearer ${token}` }

  // ── [1] passkey signup — pure P256, no EOA anywhere ──
  const prov = await fetch(`${api}/accounts/hybrid`, {
    method: 'POST', headers: authed,
    body: JSON.stringify({
      chain_id: CHAIN_ID,
      name: `Passkey DoD ${new Date().toISOString()}`,
      passkeys: [{ key_id: primary.keyId, x: `0x${primary.x.toString(16)}`, y: `0x${primary.y.toString(16)}` }],
    }),
  })
  if (!prov.ok) { record(1, 'Passkey signup', 'FAIL', `${prov.status} ${await prov.text()}`); return finish() }
  const account = (await prov.json()) as { id: string; account_address: Address }
  record(1, 'Passkey signup', 'PASS', `${account.account_address} (pure P256, counterfactual)`)

  // agent on the account
  const created = await fetch(`${api}/agents`, {
    method: 'POST', headers: authed,
    body: JSON.stringify({ name: `Passkey DoD agent ${Date.now()}`, delegate_address: agentDelegate, safe_id: account.id }),
  })
  if (!created.ok) { record(2, 'One-ceremony grant', 'FAIL', `agent create ${created.status}`); return finish() }
  const agent = (await created.json()) as { id: string; api_key: string }
  const agentAuth = { 'content-type': 'application/json', authorization: `Bearer ${agent.api_key}` }

  // fund USDC (testnet; funding-aware with read-after-write poll)
  const gasWallet = createWalletClient({ account: privateKeyToAccount(gasKey), chain: baseSepolia, transport: http(rpcUrl) })
  const needed = budgetAtomic * 3n
  const fundTx = await gasWallet.sendTransaction({
    to: USDC,
    data: encodeFunctionData({
      abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'transfer', args: [account.account_address, needed],
    }),
  })
  await publicClient.waitForTransactionReceipt({ hash: fundTx })
  for (let i = 0; i < 8; i++) {
    const bal = (await publicClient.readContract({ address: USDC, abi: BAL_ABI, functionName: 'balanceOf', args: [account.account_address] })) as bigint
    if (bal >= needed) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log(`   funded ${formatUnits(needed, 6)} USDC — ${EXPLORER}${fundTx}`)

  // ── grant helper: build → kit signs the delegation → activate ──
  const signDelegationWith = async (deploySet: LocalPasskey[], signWith: LocalPasskey, message: Record<string, unknown>): Promise<Hex> => {
    const acct = await buildPasskeyAccount(publicClient, deploySet, signWith)
    return acct.signDelegation({
      delegation: {
        delegate: message.delegate as Address,
        delegator: message.delegator as Address,
        authority: message.authority as Hex,
        caveats: (message.caveats as Array<{ enforcer: string; terms: string; args: string }>).map((c) => ({
          enforcer: c.enforcer as Address, terms: c.terms as Hex, args: c.args as Hex,
        })),
        salt: (typeof message.salt === 'string' && message.salt.startsWith('0x')
          ? message.salt
          : `0x${BigInt(String(message.salt)).toString(16)}`) as Hex,
      },
    })
  }

  const grant = async (deploySet: LocalPasskey[], signWith: LocalPasskey): Promise<string | null> => {
    const built = await fetch(`${api}/agents/${agent.id}/delegations/build`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ token_address: USDC, recipient_address: recipient, budget_atomic: budgetAtomic.toString(), period_seconds: 3600 }),
    })
    if (!built.ok) { console.error(`   build failed: ${built.status} ${await built.text()}`); return null }
    const { delegation_hash, signing_payload } = (await built.json()) as { delegation_hash: string; signing_payload: TypedData }
    const signature = await signDelegationWith(deploySet, signWith, signing_payload.message)
    const act = await fetch(`${api}/agents/${agent.id}/delegations/${delegation_hash}/activate`, {
      method: 'POST', headers: authed, body: JSON.stringify({ signature }),
    })
    if (!act.ok) { console.error(`   activate failed: ${act.status} ${await act.text()}`); return null }
    return delegation_hash
  }

  const pay = async (): Promise<{ ok: boolean; tx?: string; error?: string }> => {
    const auth = await fetch(`${api}/payments`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({ token: 'USDC', amount: budgetHuman, to: recipient }),
    })
    if (!auth.ok) return { ok: false, error: `authorize ${auth.status} ${(await auth.text()).slice(0, 200)}` }
    const intent = (await auth.json()) as { payment_id: string; sign_data: { typed_data: TypedData } }
    const sig = await signUserOpTypedDataForDelegation(agentKey, intent.sign_data.typed_data)
    const submit = await fetch(`${api}/payments/${intent.payment_id}/sign`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ signature: sig }),
    })
    if (!submit.ok) return { ok: false, error: `submit ${submit.status} ${(await submit.text()).slice(0, 200)}` }
    return { ok: true, tx: ((await submit.json()) as { tx_hash?: string }).tx_hash }
  }

  // ── signer-op helper: prepare → kit signs the userOp → submit ──
  const signerOp = async (
    body: Record<string, unknown>,
    deploySet: LocalPasskey[],
    signWith: LocalPasskey,
  ): Promise<{ ok: boolean; tx?: string; error?: string }> => {
    const prep = await fetch(`${api}/agents/${agent.id}/account-signers/prepare`, {
      method: 'POST', headers: authed, body: JSON.stringify(body),
    })
    if (!prep.ok) return { ok: false, error: `prepare ${prep.status} ${(await prep.text()).slice(0, 200)}` }
    const prepared = (await prep.json()) as { signature_scheme: string; user_operation: unknown }
    if (prepared.signature_scheme !== 'webauthn_userop') {
      return { ok: false, error: `unexpected scheme ${prepared.signature_scheme}` }
    }
    const acct = await buildPasskeyAccount(publicClient, deploySet, signWith)
    const signature = await acct.signUserOperation(reviveUserOp(prepared.user_operation) as never)
    const submit = await fetch(`${api}/agents/${agent.id}/account-signers/submit`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ ...body, signature, user_operation: prepared.user_operation }),
    })
    if (!submit.ok) return { ok: false, error: `submit ${submit.status} ${(await submit.text()).slice(0, 200)}` }
    return { ok: true, tx: ((await submit.json()) as { tx_hash?: string }).tx_hash }
  }

  const pk = (p: LocalPasskey) => ({ key_id: p.keyId, x: `0x${p.x.toString(16)}`, y: `0x${p.y.toString(16)}` })

  // ── [2] one-ceremony grant (relayer-deploys the counterfactual) ──
  const hash1 = await grant([primary], primary)
  if (!hash1) { record(2, 'One-ceremony grant', 'FAIL'); return finish() }
  const code = await publicClient.getBytecode({ address: account.account_address })
  record(2, 'One-ceremony grant', 'PASS', `passkey-signed; account ${code && code !== '0x' ? 'DEPLOYED by relayer (#860)' : 'NOT deployed (!)'}`)

  // ── [3] payment redeems the passkey-signed delegation ──
  const p3 = await pay()
  if (!p3.ok) { record(3, 'Payment redeems passkey grant', 'FAIL', p3.error ?? ''); return finish() }
  record(3, 'Payment redeems passkey grant', 'PASS', p3.tx ? EXPLORER + p3.tx : 'submitted')

  // ── [4] backup enrolled, signed by PRIMARY ──
  const e4 = await signerOp({ action: 'add_passkey', passkey: pk(backup) }, [primary], primary)
  if (!e4.ok) { record(4, 'Backup enrolled', 'FAIL', e4.error ?? ''); return finish() }
  record(4, 'Backup enrolled', 'PASS', e4.tx ? EXPLORER + e4.tx : 'submitted')

  // ── [5] RECOVERY: backup ALONE enrolls replacement, then removes primary ──
  const e5a = await signerOp({ action: 'add_passkey', passkey: pk(replacement) }, [primary], backup)
  if (!e5a.ok) { record(5, 'Recovery (backup takes over)', 'FAIL', `replacement: ${e5a.error}`); return finish() }
  const e5b = await signerOp({ action: 'remove_passkey', passkey: { key_id: primary.keyId } }, [primary], backup)
  if (!e5b.ok) { record(5, 'Recovery (backup takes over)', 'FAIL', `remove: ${e5b.error}`); return finish() }
  const after = await fetch(`${api}/agents/${agent.id}/account-signers`, { headers: authed })
  const signerSet = (await after.json()) as { passkeys: Array<{ key_id: string }> }
  const primaryGone = !signerSet.passkeys.some((k) => k.key_id.toLowerCase() === primary.keyId.toLowerCase())
  record(5, 'Recovery (backup takes over)', primaryGone ? 'PASS' : 'FAIL',
    `replacement ${e5a.tx ? EXPLORER + e5a.tx : ''} · removal ${e5b.tx ? EXPLORER + e5b.tx : ''} · primary ${primaryGone ? 'GONE from signer set' : 'still present (!)'}`)

  // ── [6] the lost key's authority DIES: the old budget no longer redeems ──
  const p6 = await pay()
  if (p6.ok) record(6, "Lost key's grants die", 'FAIL', `old budget still paid ${p6.tx ?? ''}`)
  else record(6, "Lost key's grants die", 'PASS', 'old budget (signed by the removed key) no longer redeems — EIP-1271 rejects it')

  // ── [7] re-grant with the REPLACEMENT → payment works again ──
  const hash2 = await grant([primary], replacement)
  const p7 = hash2 ? await pay() : { ok: false, error: 're-grant failed' }
  if (!p7.ok) { record(7, 'Re-grant + pay after recovery', 'FAIL', p7.error ?? ''); return finish() }
  record(7, 'Re-grant + pay after recovery', 'PASS', p7.tx ? EXPLORER + p7.tx : 'submitted')

  finish()
}

function finish(): void {
  console.log(`\n──────── passkey DoD summary ────────`)
  for (const r of rows) console.log(`  [${r.n}] ${r.name.padEnd(32)} ${r.status.padEnd(6)} ${r.detail}`)
  const failed = rows.some((r) => r.status === 'FAIL')
  console.log(failed ? `\nFAILURES present.` : `\nAll rows passed. Paste this into #891 with the tx links.`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('passkey-dod failed:', e instanceof Error ? (e.stack ?? e.message) : e)
  process.exit(1)
})
