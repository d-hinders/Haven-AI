/**
 * #745 DoD step 5 — the #739 definition-of-done: a MIGRATED Base Sepolia
 * account executes a policy-bound payment through the PRODUCTION path (the dev
 * backend's real HTTP API — no pilot rails, no direct chain calls).
 *
 * Flow: POST /payments (backend prepares the session UserOp and returns its
 * hash) → sign the hash EIP-191 with the agent's delegate key (exactly what
 * signUserOpHashForSession in @haven_ai/sdk does) → POST /payments/:id/sign
 * (backend submits to the bundler) → print the Basescan link for #739.
 *
 * The script ASSERTS the backend answered with the session scheme — if the
 * account is not migrated it fails loudly instead of silently paying over the
 * legacy AllowanceModule rail.
 *
 * Env (outside the repo, e.g. ~/.haven/pilot.env):
 *   PILOT_API_URL                     dev backend base URL (no trailing slash)
 *   PILOT_AGENT_API_KEY               the dev agent's credential (secret)
 *   PILOT_AGENT_DELEGATE_PRIVATE_KEY  the agent's delegate key (secret, testnet)
 *   PILOT_ALLOWED_RECIPIENT           must equal the session's allowlisted recipient
 *   PILOT_DOD_AMOUNT                  optional, default '0.01' (≤ 0.05 per-tx cap)
 *
 * Run: npm run pilot:dod-payment -w packages/qa-agent
 */

import { ethers } from 'ethers'

interface SignDataResponse {
  payment_id: string
  status: string
  sign_data?: { hash: string; signature_scheme?: string; instructions?: string }
  error?: string
  details?: string
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required.`)
    process.exit(2)
  }
  return value
}

async function post(url: string, apiKey: string, body: unknown): Promise<{ status: number; json: SignDataResponse & Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as never }
}

async function main(): Promise<void> {
  const apiUrl = requireEnv('PILOT_API_URL').replace(/\/$/, '')
  const apiKey = requireEnv('PILOT_AGENT_API_KEY')
  const delegateKey = requireEnv('PILOT_AGENT_DELEGATE_PRIVATE_KEY')
  const recipient = requireEnv('PILOT_ALLOWED_RECIPIENT')
  const amount = process.env.PILOT_DOD_AMOUNT ?? '0.01'

  const delegate = new ethers.Wallet(delegateKey)
  console.log(`backend:   ${apiUrl}`)
  console.log(`delegate:  ${delegate.address}`)
  console.log(`payment:   ${amount} USDC → ${recipient}`)
  console.log('')

  // 1. Authorize — the backend routes by account state and, for a migrated
  //    account, prepares the session UserOp and returns its hash.
  console.log('1/3 POST /payments (authorize)…')
  const created = await post(`${apiUrl}/payments`, apiKey, {
    token: 'USDC',
    amount,
    to: recipient,
  })
  if (created.status !== 201 || !created.json.sign_data) {
    console.error(`   authorize failed (HTTP ${created.status}):`, JSON.stringify(created.json, null, 2))
    process.exit(1)
  }
  const { payment_id: paymentId, sign_data: signData } = created.json

  // 2. The DoD gate: this MUST be the session rail. A raw-ECDSA response means
  //    the account is still on the legacy rail — stop, do not pay.
  if (signData.signature_scheme !== 'eip191_userop') {
    console.error('   ✗ backend answered with the LEGACY scheme — the account is not migrated.')
    console.error('     Check DoD step 4 (the two UPDATEs) and that the backend has the #745 code.')
    process.exit(1)
  }
  console.log(`   intent ${paymentId} — session scheme confirmed (eip191_userop)`)

  // 3. Sign EIP-191 (identical to signUserOpHashForSession in @haven_ai/sdk).
  console.log('2/3 signing the UserOperation hash (EIP-191)…')
  const signature = await delegate.signMessage(ethers.getBytes(signData.hash))

  console.log('3/3 POST /payments/:id/sign (backend submits to the bundler)…')
  const executed = await post(`${apiUrl}/payments/${paymentId}/sign`, apiKey, { signature })
  if (executed.status !== 200 || executed.json.status !== 'confirmed') {
    console.error(`   execution failed (HTTP ${executed.status}):`, JSON.stringify(executed.json, null, 2))
    process.exit(1)
  }

  console.log('')
  console.log('✅ DoD PASSED — policy-bound session payment through the production path')
  console.log(`   payment:  ${paymentId}`)
  console.log(`   tx:       https://sepolia.basescan.org/tx/${executed.json.tx_hash}`)
  console.log('   paste the tx link on #739 to close the foundation.')
}

main().catch((e) => {
  console.error('dod-payment failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
