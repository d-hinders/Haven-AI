/**
 * #4682 — the stand-in human.
 *
 * The spike's whole claim is that a SCRIPT can play the human at each hand-off
 * without any of its values reaching the agent. These tests pin the two halves
 * of that claim:
 *
 *  1. THE ORDER THE CODE REQUIRES. signup (a token with no `purpose`) →
 *     hybrid account → connection setup → device approval → funding →
 *     build/activate/budget-approval. The grant is built from the SETUP's own
 *     `allowance_amount` and `reset_period_min`, never from the harness's
 *     hard-coded 86_400.
 *  2. THE INVENTORY IS COMPLETE AND EARLY. Every generated value is in
 *     #4678's manifest before the request that uses it, so the redactor can
 *     prove the boundary rather than assert it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStandInHuman, STAND_IN_SECRET_NAMES } from './stand-in-human.js'
import { SecretManifest, readSecretManifest } from './secret-manifest.js'

const API = 'https://api.example'
const EVAL_ACCOUNT = `0x${'ee'.repeat(20)}`
const ACCOUNT = `0x${'aa'.repeat(20)}`
const SETUP_ID = '11111111-2222-3333-4444-555555555555'
const AGENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const DELEGATE = `0x${'dd'.repeat(20)}`

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qa-stand-in-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
beforeEach(() => vi.unstubAllGlobals())

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Call {
  method: string
  path: string
  auth: string | null
  body: Record<string, unknown> | undefined
}

/**
 * A fake backend that answers the stand-in's routes and records every call.
 * `setup` overrides the setup-status body so a test can vary the allowance.
 */
function fakeBackend(opts: {
  setupStatus?: Record<string, unknown>
  buildStatus?: number
  activateStatus?: number
  approvalStatus?: number
  revokeStatus?: number
} = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = url.replace(API, '')
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method, path, auth: headers.authorization ?? null, body })

    if (method === 'POST' && path === '/auth/signup') {
      return json({ token: 'signup-token-abc' }, 201)
    }
    if (method === 'POST' && path === '/accounts/hybrid') {
      return json({ ok: true }, 201)
    }
    if (method === 'GET' && path === '/auth/me') {
      return json({ accounts: [{ id: 'acct-1', account_address: ACCOUNT, account_type: 'delegator_hybrid' }] })
    }
    if (method === 'POST' && path === '/agent-connection-setups') {
      return json(
        {
          setup_id: SETUP_ID,
          status: 'awaiting_connection',
          approval_url: `https://app.example/agents?setup=${SETUP_ID}`,
          connector_command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_xyz',
        },
        201,
      )
    }
    if (method === 'GET' && path === `/agent-connection-setups/${SETUP_ID}`) {
      return json(
        opts.setupStatus ?? {
          setup_id: SETUP_ID,
          agent_id: AGENT_ID,
          delegate_address: DELEGATE,
          status: 'awaiting_connection',
          agent_budget: [
            {
              token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              token_symbol: 'USDC',
              allowance_amount: '2500000',
              reset_period_min: 1440,
            },
          ],
        },
      )
    }
    if (method === 'POST' && path === `/agents/${AGENT_ID}/delegations/build`) {
      if (opts.buildStatus && opts.buildStatus !== 200) return json({ error: 'build refused' }, opts.buildStatus)
      return json({
        delegation_hash: '0xdeadbeef',
        signing_payload: {
          domain: { name: 'Haven', version: '1', chainId: 84532, verifyingContract: `0x${'11'.repeat(20)}` },
          types: { Delegation: [{ name: 'delegate', type: 'address' }] },
          primaryType: 'Delegation',
          message: { delegate: DELEGATE },
        },
      })
    }
    if (method === 'POST' && path === `/agents/${AGENT_ID}/delegations/0xdeadbeef/activate`) {
      if (opts.activateStatus && opts.activateStatus !== 200) return json({ error: 'activate refused' }, opts.activateStatus)
      return json({ ok: true })
    }
    if (method === 'POST' && path === `/agent-connection-setups/${SETUP_ID}/budget-approval`) {
      if (opts.approvalStatus && opts.approvalStatus !== 200) return json({ error: 'not approved' }, opts.approvalStatus)
      return json({ setup_id: SETUP_ID, status: 'active' })
    }
    if (method === 'POST' && path === '/auth/device/approve') {
      return json({ status: 'approved', client_label: 'Haven CLI' })
    }
    if (method === 'POST' && path === `/agents/${AGENT_ID}/revoke`) {
      if (opts.revokeStatus && opts.revokeStatus !== 200) return json({ error: 'revoke refused' }, opts.revokeStatus)
      return json({ ok: true })
    }
    return json({ error: `unexpected ${method} ${path}` }, 404)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

async function manifestAt(dir: string): Promise<SecretManifest> {
  return SecretManifest.create(join(dir, 'secrets.jsonl'), { setupTasks: 1 })
}

function options(dir: string, fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    apiUrl: API,
    chainId: 84532,
    label: 'spike',
    evalAgentApiKey: 'sk_agent_eval',
    evalDelegateKey: `0x${'22'.repeat(32)}`,
    evalAccountAddress: EVAL_ACCOUNT,
    manifest: undefined as unknown as SecretManifest,
    budgetAtomic: '2500000',
    periodSeconds: 86_400,
    fetchImpl,
    readUsdcBalance: async () => 0n,
    ...overrides,
  }
}

describe('createStandInHuman — the order the code requires', () => {
  it('signs up, provisions the hybrid account, then creates the setup', async () => {
    const dir = await scratch()
    const backend = fakeBackend()
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    expect('error' in standIn).toBe(false)
    if ('error' in standIn) return

    expect(backend.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /auth/signup',
      'POST /accounts/hybrid',
      'GET /auth/me',
      'POST /agent-connection-setups',
    ])
    // The signup token carries no `purpose`, so it is what the device approval
    // and every later user call use.
    expect(backend.calls[1]!.auth).toBe('Bearer signup-token-abc')
    expect(backend.calls[3]!.auth).toBe('Bearer signup-token-abc')
    expect(standIn.evidence.accountAddress).toBe(ACCOUNT)
    expect(standIn.evidence.setupId).toBe(SETUP_ID)
  })

  it('asks for the setup with the budget and period it was given', async () => {
    const dir = await scratch()
    const backend = fakeBackend()
    const manifest = await manifestAt(dir)
    await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    const create = backend.calls.find((c) => c.path === '/agent-connection-setups')!
    const allowances = create.body!.allowances as Array<Record<string, unknown>>
    expect(allowances).toEqual([
      {
        token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        token_symbol: 'USDC',
        allowance_amount: '2500000',
        reset_period_min: 1440,
      },
    ])
  })

  it('records every generated value in the manifest before it is used', async () => {
    const dir = await scratch()
    const backend = fakeBackend()
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)

    const read = await readSecretManifest(manifest.filePath)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const names = read.secrets.map((s) => s.name)
    // The four values that exist at provisioning time. The device user code
    // arrives with the agent's hand-off, so it is recorded on approval.
    for (const name of STAND_IN_SECRET_NAMES.filter((n) => n !== 'stand_in_device_user_code')) {
      expect(names).toContain(name)
    }
    // The token the backend issued is the one in the inventory — not a copy.
    const token = read.secrets.find((s) => s.name === 'stand_in_signup_token')!
    expect(token.value).toBe('signup-token-abc')

    await standIn.approveDeviceLogin('ABCD-1234')
    const after = await readSecretManifest(manifest.filePath)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.secrets.map((s) => s.name)).toContain('stand_in_device_user_code')
    // And the inventory the leak test scans is the same set.
    expect(standIn.inventory().map((e) => e.name).sort()).toEqual([...STAND_IN_SECRET_NAMES].sort())
  })

  it('refuses to continue when signup fails', async () => {
    const dir = await scratch()
    const manifest = await manifestAt(dir)
    const fetchImpl = (async () => json({ error: 'email taken' }, 409)) as unknown as typeof fetch
    const standIn = await createStandInHuman(options(dir, fetchImpl, { manifest }))
    expect('error' in standIn).toBe(true)
    if (!('error' in standIn)) return
    expect(standIn.error).toContain('stand-in signup failed (409)')
  })
})

describe('approveDeviceLogin', () => {
  it('posts the user code with the signup token', async () => {
    const dir = await scratch()
    const backend = fakeBackend()
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)

    const result = await standIn.approveDeviceLogin('ABCD-1234')
    expect(result.status).toBe('approved')
    const call = backend.calls.find((c) => c.path === '/auth/device/approve')!
    expect(call.auth).toBe('Bearer signup-token-abc')
    expect(call.body).toEqual({ user_code: 'ABCD-1234' })
    expect(standIn.evidence.deviceApprovals).toEqual(['ABCD-1234'])
  })

  it('throws with the backend reason when the code is refused', async () => {
    const dir = await scratch()
    const manifest = await manifestAt(dir)
    const backend = fakeBackend()
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/auth/device/approve')) return json({ error: 'No pending approval for that code' }, 404)
      return backend.fetchImpl(input as never, init)
    }) as unknown as typeof fetch
    const standIn = await createStandInHuman(options(dir, fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)
    await expect(standIn.approveDeviceLogin('NOPE-0000')).rejects.toThrow('device approval failed (404)')
  })
})

describe('approveBudget — built from the SETUP, never from a hard-coded period', () => {
  it('reads allowance_amount and reset_period_min and builds the grant from them', async () => {
    const dir = await scratch()
    const backend = fakeBackend()
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)

    const grant = await standIn.approveBudget()
    expect(grant).toEqual({ delegationHash: '0xdeadbeef', budgetAtomic: '2500000', periodSeconds: 86_400 })

    const build = backend.calls.find((c) => c.path === `/agents/${AGENT_ID}/delegations/build`)!
    expect(build.body).toMatchObject({ budget_atomic: '2500000', period_seconds: 86_400 })
    // The activate call carries the owner's signature, and the approval is the
    // LAST step — the setup only flips to active after the grant is live.
    const order = backend.calls.map((c) => c.path)
    expect(order.indexOf(`/agents/${AGENT_ID}/delegations/build`)).toBeLessThan(
      order.indexOf(`/agents/${AGENT_ID}/delegations/0xdeadbeef/activate`),
    )
    expect(order.indexOf(`/agents/${AGENT_ID}/delegations/0xdeadbeef/activate`)).toBeLessThan(
      order.indexOf(`/agent-connection-setups/${SETUP_ID}/budget-approval`),
    )
  })

  it('follows a setup that asks for a DIFFERENT period — the harness 86_400 is not assumed', async () => {
    const dir = await scratch()
    const backend = fakeBackend({
      setupStatus: {
        setup_id: SETUP_ID,
        agent_id: AGENT_ID,
        delegate_address: DELEGATE,
        agent_budget: [
          {
            token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            token_symbol: 'USDC',
            allowance_amount: '1250000',
            reset_period_min: 60,
          },
        ],
      },
    })
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)

    const grant = await standIn.approveBudget()
    expect(grant.budgetAtomic).toBe('1250000')
    expect(grant.periodSeconds).toBe(3600)
    const build = backend.calls.find((c) => c.path === `/agents/${AGENT_ID}/delegations/build`)!
    expect(build.body).toMatchObject({ budget_atomic: '1250000', period_seconds: 3600 })
  })

  it('refuses when the connector has not registered (no agent_id)', async () => {
    const dir = await scratch()
    const backend = fakeBackend({
      setupStatus: { setup_id: SETUP_ID, agent_id: null, agent_budget: [] },
    })
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)
    await expect(standIn.approveBudget()).rejects.toThrow('the connector has not registered yet')
  })

  it('surfaces a refused activation instead of approving the budget anyway', async () => {
    const dir = await scratch()
    const backend = fakeBackend({ activateStatus: 409 })
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)
    await expect(standIn.approveBudget()).rejects.toThrow('grant activation failed (409)')
    expect(backend.calls.some((c) => c.path.endsWith('/budget-approval'))).toBe(false)
  })
})

describe('teardown — #4678 order, warnings never verdicts', () => {
  it('sweeps, returns, closes and revokes in that order', async () => {
    const dir = await scratch()
    const backend = fakeBackend()
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)

    const result = await standIn.teardown()
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
    const order = backend.calls.map((c) => `${c.method} ${c.path}`)
    expect(order).toContain(`GET /agent-connection-setups/${SETUP_ID}`)
    expect(order).toContain(`POST /agents/${AGENT_ID}/revoke`)
  })

  it('reports stranded delegate funds as a warning it cannot fix', async () => {
    const dir = await scratch()
    const backend = fakeBackend()
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(
      options(dir, backend.fetchImpl, {
        manifest,
        readUsdcBalance: async (address: string) => (address === DELEGATE ? 7n : 0n),
      }),
    )
    if ('error' in standIn) throw new Error(standIn.error)

    const result = await standIn.teardown()
    expect(result.ok).toBe(false)
    expect(result.warnings.join('\n')).toContain('7 atomic USDC is stranded on the delegate EOA')
    expect(result.warnings.join('\n')).toContain('the agent must run the sweep')
  })

  it('reports a failed revoke as a warning, not a throw', async () => {
    const dir = await scratch()
    const backend = fakeBackend({ revokeStatus: 500 })
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)

    const result = await standIn.teardown()
    expect(result.ok).toBe(false)
    expect(result.warnings.join('\n')).toContain('was NOT revoked (500)')
  })

  it('is idempotent — a second run does not repeat the steps', async () => {
    const dir = await scratch()
    const backend = fakeBackend()
    const manifest = await manifestAt(dir)
    const standIn = await createStandInHuman(options(dir, backend.fetchImpl, { manifest }))
    if ('error' in standIn) throw new Error(standIn.error)
    await standIn.teardown()
    const afterFirst = backend.calls.length
    await standIn.teardown()
    expect(backend.calls.length).toBe(afterFirst)
  })
})
