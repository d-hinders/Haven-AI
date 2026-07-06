/**
 * #745 DoD step 2: create the dev-backend USER + import the pilot Safe +
 * create the AGENT — entirely over the dev backend's HTTP API (the dev
 * frontend has no permanent URL, so the dashboard route is impractical).
 *
 * What it does, idempotently:
 *   1. login (or sign up) a dev user,
 *   2. import the pilot Safe on Base Sepolia (tolerates "already linked"),
 *   3. generate a THROWAWAY delegate keypair locally,
 *   4. create the agent bound to that Safe with a USDC allowance row (the
 *      rail-agnostic "configured for this token" guard — no on-chain
 *      AllowanceModule allowance is needed on the session rail),
 *   5. print the exact pilot.env lines for steps 3–5.
 *
 * ⚠️ Prints the delegate PRIVATE KEY and agent API key to YOUR terminal — they
 * go into ~/.haven/pilot.env. Testnet-only throwaways; never paste in chat,
 * never commit.
 *
 * Env: PILOT_API_URL, PILOT_SAFE_ADDRESS, PILOT_DEV_EMAIL, PILOT_DEV_PASSWORD
 * Run: npm run pilot:create-dod-agent -w packages/qa-agent
 */

import { ethers } from 'ethers'

const CHAIN_ID = 84532
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required.`)
    process.exit(2)
  }
  return value
}

interface ApiResult {
  status: number
  json: Record<string, unknown>
}

async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  jwt?: string,
): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as never }
}

async function main(): Promise<void> {
  const base = requireEnv('PILOT_API_URL').replace(/\/$/, '')
  const safeAddress = requireEnv('PILOT_SAFE_ADDRESS')
  const email = requireEnv('PILOT_DEV_EMAIL')
  const password = requireEnv('PILOT_DEV_PASSWORD')

  // 1. Login, or sign up on first run.
  console.log('1/4 login…')
  let auth = await api(base, 'POST', '/auth/login', { email, password })
  if (auth.status !== 200) {
    console.log('    no dev user yet — signing up')
    auth = await api(base, 'POST', '/auth/signup', { name: 'DoD Operator', email, password })
    if (auth.status !== 201 && auth.status !== 200) {
      console.error(`    signup failed (HTTP ${auth.status}):`, JSON.stringify(auth.json))
      process.exit(1)
    }
    if (!auth.json.token) auth = await api(base, 'POST', '/auth/login', { email, password })
  }
  const jwt = auth.json.token as string
  if (!jwt) {
    console.error('    could not obtain a JWT:', JSON.stringify(auth.json))
    process.exit(1)
  }

  // 2. Import the pilot Safe (idempotent — 409 means already linked).
  console.log('2/4 importing the pilot Safe…')
  const imported = await api(base, 'POST', '/user/safes', {
    safe_address: safeAddress,
    chain_id: CHAIN_ID,
    name: 'Pilot Safe (Base Sepolia)',
  }, jwt)
  if (imported.status !== 201 && imported.status !== 409) {
    console.error(`    import failed (HTTP ${imported.status}):`, JSON.stringify(imported.json))
    process.exit(1)
  }
  const safes = await api(base, 'GET', '/user/safes', undefined, jwt)
  const safeRows = (Array.isArray(safes.json) ? safes.json : (safes.json.safes as unknown[])) ?? []
  const safeRow = (safeRows as Array<Record<string, unknown>>).find(
    (row) =>
      String(row.safe_address).toLowerCase() === safeAddress.toLowerCase() &&
      Number(row.chain_id) === CHAIN_ID,
  )
  if (!safeRow?.id) {
    console.error('    could not resolve the imported Safe id:', JSON.stringify(safes.json))
    process.exit(1)
  }
  console.log(`    safe_id: ${safeRow.id}`)

  // 3. Throwaway delegate keypair — generated locally, never leaves this machine.
  const delegate = ethers.Wallet.createRandom()

  // 4. Create the agent. The allowance row satisfies the token guard; the
  //    session policy (step 3) is what actually binds spend on this rail.
  console.log('3/4 creating the agent…')
  const created = await api(base, 'POST', '/agents', {
    name: 'DoD Session Agent',
    description: 'Stage 2 session-rail definition-of-done (#739/#745)',
    delegate_address: delegate.address,
    safe_id: safeRow.id,
    allowances: [{
      token_address: SEPOLIA_USDC,
      token_symbol: 'USDC',
      allowance_amount: '1',
      reset_period_min: 0,
    }],
  }, jwt)
  if (created.status !== 201) {
    console.error(`    agent creation failed (HTTP ${created.status}):`, JSON.stringify(created.json))
    process.exit(1)
  }
  const apiKey = created.json.api_key as string
  const agent = created.json.agent as Record<string, unknown> | undefined
  console.log(`    agent id: ${agent?.id ?? '(see response)'}`)

  console.log('4/4 done')
  console.log('')
  console.log('✅ dev user + pilot Safe + agent ready')
  console.log('')
  console.log('── Append to ~/.haven/pilot.env (SECRETS — never in chat/commits) ──')
  console.log(`PILOT_AGENT_DELEGATE_ADDRESS=${delegate.address}`)
  console.log(`PILOT_AGENT_DELEGATE_PRIVATE_KEY=${delegate.privateKey}`)
  console.log(`PILOT_AGENT_API_KEY=${apiKey}`)
  console.log('─────────────────────────────────────────────────────────────────────')
  console.log('')
  console.log('next: re-source the env, then step 3:')
  console.log('  set -a; source ~/.haven/pilot.env; set +a')
  console.log('  npm run pilot:enable-agent-session -w packages/qa-agent')
}

main().catch((e) => {
  console.error('create-dod-agent failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
