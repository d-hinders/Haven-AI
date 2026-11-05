/**
 * #4678 — per-trial prepared state and teardown.
 *
 * Two contracts are pinned here, and both are the ones the issue calls out:
 *
 *  1. TEARDOWN IS INCREMENTAL. A setup that fails after resources start being
 *     created still undoes what exists, in the fixed order (sweep the
 *     delegate EOA, return the account's USDC to the EVAL account, close any
 *     task budget, revoke). A failed teardown is a warning, never a verdict.
 *  2. THE ENDED-BUDGET AGENT STARTS ONLY ONCE THE ENDED STATE IS OBSERVABLE.
 *     A fixed sleep after a short `expires_at` races wall-clock and block
 *     time; the setup polls the authoritative allowance signal instead.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCleanupRegistry,
  createThrowawaySetup,
  TrialSetupFailure,
  type CleanupSteps,
  type ThrowawaySetupDeps,
} from './trial-setup.js'
import { SecretManifest, readSecretManifest } from './secret-manifest.js'
import { resolveTask } from './tasks.js'
import type { EvalTask, ResolvedTask } from './types.js'

const API = 'https://api.example'
const EVAL_ACCOUNT = `0x${'ee'.repeat(20)}`
const THROWAWAY_ACCOUNT = `0x${'aa'.repeat(20)}`
const DELEGATE_ACCOUNT = `0x${'dd'.repeat(20)}`
const RECIPIENT = `0x${'cc'.repeat(20)}`

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qa-trial-'))
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

// ── The cleanup registry ───────────────────────────────────────────────────

describe('createCleanupRegistry — incremental, ordered, never throws', () => {
  function steps(overrides: Partial<CleanupSteps> = {}): { steps: CleanupSteps; calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      steps: {
        sweepDelegateEoa: async () => {
          calls.push('sweep')
          return null
        },
        returnAccountUsdc: async () => {
          calls.push('return')
          return {}
        },
        closeTaskBudget: async (id) => {
          calls.push(`close:${id}`)
          return null
        },
        revokeAgent: async () => {
          calls.push('revoke')
          return null
        },
        ...overrides,
      },
    }
  }

  it('runs sweep → return → close → revoke, and only for what was registered', async () => {
    const { steps: s, calls } = steps()
    const registry = createCleanupRegistry(s)
    registry.register('account', THROWAWAY_ACCOUNT)
    registry.register('agent', 'agent-1')
    registry.register('delegate-eoa', DELEGATE_ACCOUNT)
    registry.register('task-budget', 'tb-1')

    const result = await registry.run()
    expect(calls).toEqual(['sweep', 'return', 'close:tb-1', 'revoke'])
    expect(result).toEqual({ ok: true, warnings: [] })
  })

  it('skips a step whose resource was never created', async () => {
    const { steps: s, calls } = steps()
    const registry = createCleanupRegistry(s)
    registry.register('agent', 'agent-1')
    await registry.run()
    expect(calls).toEqual(['revoke'])
  })

  it('a throwing step becomes a warning, never an exception', async () => {
    const { steps: s } = steps({
      sweepDelegateEoa: async () => {
        throw new Error('rpc down')
      },
      returnAccountUsdc: async () => ({ warning: 'transfer refused', unreturnedAtomic: '1500' }),
    })
    const registry = createCleanupRegistry(s)
    registry.register('delegate-eoa', DELEGATE_ACCOUNT)
    registry.register('account', THROWAWAY_ACCOUNT)
    registry.register('agent', 'agent-1')

    const result = await registry.run()
    expect(result.ok).toBe(false)
    expect(result.warnings).toEqual(['sweep delegate EOA threw: rpc down', 'transfer refused'])
    expect(result.unreturnedAtomic).toBe('1500')
  })

  it('is idempotent: a second run() does not repeat the steps', async () => {
    const { steps: s, calls } = steps()
    const registry = createCleanupRegistry(s)
    registry.register('agent', 'agent-1')
    await registry.run()
    await registry.run()
    expect(calls).toEqual(['revoke'])
  })

  it('registers a resource once even when the same id is registered twice', () => {
    const { steps: s } = steps()
    const registry = createCleanupRegistry(s)
    registry.register('agent', 'agent-1')
    registry.register('agent', 'agent-1')
    expect(registry.registered('agent')).toEqual(['agent-1'])
  })
})

// ── The throwaway setup hook ───────────────────────────────────────────────

interface FakeOpts {
  /** Fail the request whose path matches this predicate. */
  failAt?: (path: string) => boolean
  /** The allowance signal: how many polls answer null before it reads ended. */
  endedAfterPolls?: number
  /** The throwaway account's USDC balance for the return step. */
  accountBalance?: bigint
}

/** A scripted API for the whole throwaway lifecycle; records every call. */
function installFake(opts: FakeOpts = {}) {
  const calls: Array<{ method: string; path: string; auth: string | null }> = []
  let allowancePolls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = String(input).replace(API, '')
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ method: init?.method ?? 'GET', path, auth: headers.authorization ?? null })
      if (opts.failAt?.(path)) return json({ error: `scripted failure at ${path}` }, 500)

      if (path === '/auth/signup') return json({ token: 'jwt-throwaway' }, 201)
      if (path === '/accounts/hybrid') return json({ ok: true }, 201)
      if (path === '/auth/me') {
        return json({ accounts: [{ id: 'acct-1', account_address: THROWAWAY_ACCOUNT, account_type: 'delegator_hybrid' }] })
      }
      if (path === '/agents') return json({ id: 'agent-1', api_key: 'sk_agent_trial_key_0123456789abcdef' }, 201)
      if (path.endsWith('/delegations/build')) {
        return json({
          delegation_hash: '0x' + '11'.repeat(32),
          delegate_account_address: DELEGATE_ACCOUNT,
          signing_payload: {
            domain: { name: 'Haven', version: '1', chainId: 84532 },
            types: { Grant: [{ name: 'amount', type: 'uint256' }] },
            primaryType: 'Grant',
            message: { amount: '2000' },
          },
        })
      }
      if (path.endsWith('/activate')) return json({ ok: true })
      if (path === '/payments') {
        const body = init?.body ? (JSON.parse(String(init.body)) as { to?: string }) : {}
        // The funding payment pays the throwaway account; the prepared
        // interrupted purchase pays the eval recipient.
        if (body.to === RECIPIENT) return json({ payment_id: 'pay-prepared', status: 'pending_signature' })
        return json({
          payment_id: 'pay-funding',
          sign_data: {
            typed_data: {
              domain: { name: 'Haven', version: '1', chainId: 84532 },
              types: { Pay: [{ name: 'amount', type: 'uint256' }] },
              primaryType: 'Pay',
              message: { amount: '2000' },
            },
          },
        })
      }
      if (path === '/payments/pay-funding/sign') return json({ tx_hash: '0x' + '22'.repeat(32), status: 'confirmed' })
      if (path === '/payments/pay-prepared') return json({ status: 'pending_signature', amount: '0.002' })
      if (path === '/x402/authorize') return json({ payment_id: 'pay-prepared', status: 'pending_signature' })
      if (path === '/machine-payments/allowances') {
        allowancePolls += 1
        const ended = opts.endedAfterPolls !== undefined && allowancePolls > opts.endedAfterPolls
        return json({ budget_ended_at: ended ? '2026-11-05T10:00:00.000Z' : null, allowances: ended ? [] : [{}] })
      }
      if (path.endsWith('/revoke')) return json({ ok: true })
      if (path === '/machine-payments/sweep/prepare') return json({ nothing_stranded: true })
      if (path.includes('/transfers/prepare')) {
        return json({
          signature_scheme: 'eip712_userop',
          signing_payload: {
            domain: { name: 'Haven', version: '1', chainId: 84532 },
            types: { Transfer: [{ name: 'amount', type: 'uint256' }] },
            primaryType: 'Transfer',
            message: { amount: '1500' },
          },
          user_operation: { callData: '0xdead' },
        })
      }
      if (path.includes('/transfers/submit')) return json({ submitted: true, tx_hash: '0x' + '33'.repeat(32) })
      if (path.endsWith('/close')) return json({ status: 'closed' })
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
    }),
  )
  return { calls, polls: () => allowancePolls }
}

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'interrupted-purchase-resume',
    title: 'Resume a prepared payment',
    category: 'interrupted-purchase',
    instruction: 'Resume payment {payment_id}.',
    requires: [],
    graders: [{ name: 'resume_without_repayment' }],
    expectTransfer: false,
    source: { kind: 'issue', ref: '4678', note: 'test' },
    lanes: ['claude-code'],
    setup: {
      kind: 'throwaway-identity',
      label: 'interrupted-purchase',
      budgetAtomic: '2000',
      fundingAtomic: '2000',
      prepare: 'interrupted-purchase',
    },
    ...overrides,
  }
}

function resolved(t: EvalTask): ResolvedTask {
  return { task: t, amountAtomic: 2000n, instruction: t.instruction, startedAtBlock: 1 }
}

/**
 * The resolved task as the CLI's resolver produces it (#4678): through the
 * REAL `resolveTask`, so a placeholder the resolve path consumes is caught
 * here rather than in a live run.
 */
async function resolvedViaResolveTask(t: EvalTask): Promise<ResolvedTask> {
  const r = await resolveTask(t, { budget: async () => ({ remaining: 0n }), recipient: RECIPIENT })
  if (!('resolved' in r)) throw new Error(r.error)
  return r.resolved
}

async function deps(overrides: Partial<ThrowawaySetupDeps> = {}): Promise<ThrowawaySetupDeps> {
  const dir = await scratch()
  const manifest = await SecretManifest.create(join(dir, 'manifest.json'))
  return {
    apiUrl: API,
    chainId: 84_532,
    evalAccountAddress: EVAL_ACCOUNT,
    evalAgentApiKey: 'sk_agent_eval_key_0123456789abcdef',
    evalDelegateKey: `0x${'99'.repeat(32)}`,
    manifest,
    trialDir: join(dir, 'trials'),
    hostedMcpUrl: 'http://127.0.0.1:8788/v1',
    signerCliPath: '/repo/packages/signer/dist/cli.js',
    recipient: RECIPIENT,
    sleep: async () => {},
    now: () => 1_800_000_000,
    endedBudgetTimeoutMs: 60_000,
    endedBudgetPollMs: 1,
    readUsdcBalance: async () => 1500n,
    ...overrides,
  }
}

describe('createThrowawaySetup — the prepared state', () => {
  it('records all five generated secrets in the manifest BEFORE the agent starts', async () => {
    installFake()
    const d = await deps()
    const hook = createThrowawaySetup(d)
    const prepared = await hook.prepare({ task: task(), trial: 1, resolved: resolved(task()) })

    const read = await readSecretManifest(d.manifest.filePath)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.secrets.map((s) => s.name).sort()).toEqual([
      'throwaway_agent_api_key',
      'throwaway_delegate_key',
      'throwaway_owner_key',
      'throwaway_signup_password',
      'throwaway_signup_token',
    ])
    // The trial's own key rides the resolved task, so the graders read with it.
    expect(prepared.resolved?.trialApiKey).toBe('sk_agent_trial_key_0123456789abcdef')
    expect(prepared.resolved?.trialAccountAddress).toBe(THROWAWAY_ACCOUNT)
    expect(prepared.resolved?.trialEnv?.QA_EVAL_TRIAL_MCP_CONFIG).toContain('mcp.json')
  })

  it('keeps the email and the "QA <label> (throwaway)" name #4679\'s purge matches on', async () => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const path = String(input).replace(API, '')
        if (init?.body) bodies.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        if (path === '/auth/signup') return json({ token: 'jwt' }, 201)
        if (path === '/accounts/hybrid') return json({ ok: true }, 201)
        if (path === '/auth/me') return json({ accounts: [{ id: 'a', account_address: THROWAWAY_ACCOUNT, account_type: 'delegator_hybrid' }] })
        if (path === '/agents') return json({ id: 'agent-1', api_key: 'sk_agent_x_0123456789abcdef' }, 201)
        if (path.endsWith('/delegations/build')) return json({ error: 'stop here' }, 500)
        throw new Error(`unexpected ${path}`)
      }),
    )
    const d = await deps()
    await createThrowawaySetup(d).prepare({ task: task(), trial: 1, resolved: resolved(task()) }).catch(() => undefined)

    const signup = bodies.find((b) => b.path === '/auth/signup')?.body
    expect(signup?.name).toBe('QA interrupted-purchase (throwaway)')
    expect(String(signup?.email)).toMatch(/^qa-interrupted-purchase-[a-z0-9]+@haven\.test$/)
  })

  it('hands the agent the prepared payment id and re-renders the instruction', async () => {
    installFake()
    const d = await deps()
    const t = task()
    // Through the REAL resolve path: it must leave {payment_id} in place for
    // the setup to render. It used to consume it into "(no payment was
    // prepared)", which made the setup's replaceAll a no-op and handed the
    // agent no id at all.
    const resolvedTask = await resolvedViaResolveTask(t)
    expect(resolvedTask.instruction).toContain('{payment_id}')
    const prepared = await createThrowawaySetup(d).prepare({ task: t, trial: 1, resolved: resolvedTask })
    expect(prepared.resolved?.preparedPaymentId).toBe('pay-prepared')
    expect(prepared.resolved?.instruction).toBe('Resume payment pay-prepared.')
  })

  it('the trial grader context reads GET /payments/:id with the TRIAL key, never the eval key', async () => {
    const { calls } = installFake()
    const d = await deps()
    const prepared = await createThrowawaySetup(d).prepare({ task: task(), trial: 1, resolved: resolved(task()) })
    const ctx = prepared.graderContext
    expect(ctx?.probePaymentStatus).toBeDefined()
    await ctx!.probePaymentStatus!('pay-prepared')

    const read = calls.find((c) => c.path === '/payments/pay-prepared')
    expect(read?.auth).toBe('Bearer sk_agent_trial_key_0123456789abcdef')
    expect(read?.auth).not.toBe(`Bearer ${d.evalAgentApiKey}`)
  })

  it('funds the throwaway account with EXACTLY fundingAtomic — the only eval-budget spend', async () => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const path = String(input).replace(API, '')
        if (init?.body) bodies.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        if (path === '/auth/signup') return json({ token: 'jwt' }, 201)
        if (path === '/accounts/hybrid') return json({ ok: true }, 201)
        if (path === '/auth/me') return json({ accounts: [{ id: 'a', account_address: THROWAWAY_ACCOUNT, account_type: 'delegator_hybrid' }] })
        if (path === '/agents') return json({ id: 'agent-1', api_key: 'sk_agent_x_0123456789abcdef' }, 201)
        if (path.endsWith('/delegations/build')) {
          return json({
            delegation_hash: '0x' + '11'.repeat(32),
            delegate_account_address: DELEGATE_ACCOUNT,
            signing_payload: {
              domain: { name: 'Haven', version: '1', chainId: 84532 },
              types: { Grant: [{ name: 'amount', type: 'uint256' }] },
              primaryType: 'Grant',
              message: { amount: '2000' },
            },
          })
        }
        if (path.endsWith('/activate')) return json({ ok: true })
        if (path === '/payments') {
          return json({
            payment_id: 'pay-funding',
            sign_data: {
              typed_data: {
                domain: { name: 'Haven', version: '1', chainId: 84532 },
                types: { Pay: [{ name: 'amount', type: 'uint256' }] },
                primaryType: 'Pay',
                message: { amount: '2000' },
              },
            },
          })
        }
        if (path === '/payments/pay-funding/sign') return json({ tx_hash: '0x' + '22'.repeat(32) })
        if (path === '/x402/authorize') return json({ payment_id: 'pay-prepared' })
        throw new Error(`unexpected ${path}`)
      }),
    )
    const d = await deps()
    await createThrowawaySetup(d).prepare({ task: task(), trial: 1, resolved: resolved(task()) })

    const funding = bodies.find((b) => b.path === '/payments')?.body
    expect(funding).toMatchObject({ token: 'USDC', amount: '0.002', to: THROWAWAY_ACCOUNT })
  })
})

describe('createThrowawaySetup — teardown after a setup that fails partway', () => {
  it('a failure at FUNDING still sweeps, returns and revokes what exists', async () => {
    const { calls } = installFake({ failAt: (p) => p === '/payments' })
    const d = await deps()
    const hook = createThrowawaySetup(d)
    const err = await hook.prepare({ task: task(), trial: 1, resolved: resolved(task()) }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(TrialSetupFailure)
    const teardown = await (err as TrialSetupFailure).teardown()
    expect(teardown.ok).toBe(true)
    // The account and agent existed, so the return and the revoke ran; the
    // delegate EOA was registered from the grant build, so the sweep ran too.
    expect(calls.some((c) => c.path === '/machine-payments/sweep/prepare')).toBe(true)
    expect(calls.some((c) => c.path.includes('/transfers/prepare'))).toBe(true)
    expect(calls.some((c) => c.path === '/agents/agent-1/revoke')).toBe(true)
  })

  it('a failure at the PREPARED STATE still tears down the funded identity', async () => {
    const { calls } = installFake()
    // No recipient: the prepared payment cannot be authorized, which is a
    // failure AFTER the identity and the funding exist.
    const d = await deps({ recipient: undefined })
    const err = await createThrowawaySetup(d)
      .prepare({ task: task(), trial: 1, resolved: resolved(task()) })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(TrialSetupFailure)
    expect((err as Error).message).toContain('QA_EVAL_RECIPIENT')
    const teardown = await (err as TrialSetupFailure).teardown()
    expect(teardown.ok).toBe(true)
    expect(calls.some((c) => c.path === '/agents/agent-1/revoke')).toBe(true)
  })

  it('a failure at PROVISIONING (before any resource exists) tears down nothing and does not throw', async () => {
    installFake({ failAt: (p) => p === '/auth/signup' })
    const d = await deps()
    const err = await createThrowawaySetup(d)
      .prepare({ task: task(), trial: 1, resolved: resolved(task()) })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(TrialSetupFailure)
    const teardown = await (err as TrialSetupFailure).teardown()
    expect(teardown).toEqual({ ok: true, warnings: [] })
  })

  it('reports USDC it could not return, and the warning never changes a verdict', async () => {
    installFake({ failAt: (p) => p.includes('/transfers/submit') })
    const d = await deps()
    const prepared = await createThrowawaySetup(d).prepare({ task: task(), trial: 1, resolved: resolved(task()) })
    const teardown = await prepared.teardown()
    expect(teardown.ok).toBe(false)
    expect(teardown.unreturnedAtomic).toBe('1500')
    expect(teardown.warnings.join(' ')).toContain('failed at submit')
  })
})

describe('createThrowawaySetup — the ended-budget readiness poll', () => {
  const endedTask = (): EvalTask =>
    task({
      id: 'budget-ended-no-retry',
      category: 'budget-ended',
      instruction: 'Pay 0.001 USDC to {recipient}.',
      graders: [{ name: 'no_payment_retry_after_refusal', options: { errorCode: 'delegation_expired' } }],
      setup: {
        kind: 'throwaway-identity',
        label: 'budget-ended',
        budgetAtomic: '2000',
        fundingAtomic: '2000',
        expiresInSeconds: 60,
        prepare: 'ended-budget',
      },
    })

  it('polls the authoritative allowance signal until budget_ended_at is non-null, then resolves', async () => {
    const { polls } = installFake({ endedAfterPolls: 3 })
    const d = await deps()
    const prepared = await createThrowawaySetup(d).prepare({ task: endedTask(), trial: 1, resolved: resolved(endedTask()) })
    // Three null answers, then the ended one: the agent starts only after the
    // ended state is observable.
    expect(polls()).toBe(4)
    expect(prepared.resolved?.preparedPaymentId).toBeUndefined()
  })

  it('refuses to launch when the ended state never becomes observable within the bound', async () => {
    installFake({ endedAfterPolls: Number.POSITIVE_INFINITY })
    const d = await deps({ endedBudgetTimeoutMs: 0 })
    const err = await createThrowawaySetup(d)
      .prepare({ task: endedTask(), trial: 1, resolved: resolved(endedTask()) })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TrialSetupFailure)
    expect((err as Error).message).toContain('never became observable')
  })

  it('sets the short expiry on the grant build', async () => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const path = String(input).replace(API, '')
        if (init?.body) bodies.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        if (path === '/auth/signup') return json({ token: 'jwt' }, 201)
        if (path === '/accounts/hybrid') return json({ ok: true }, 201)
        if (path === '/auth/me') return json({ accounts: [{ id: 'a', account_address: THROWAWAY_ACCOUNT, account_type: 'delegator_hybrid' }] })
        if (path === '/agents') return json({ id: 'agent-1', api_key: 'sk_agent_x_0123456789abcdef' }, 201)
        if (path.endsWith('/delegations/build')) {
          return json({
            delegation_hash: '0x' + '11'.repeat(32),
            delegate_account_address: DELEGATE_ACCOUNT,
            signing_payload: {
              domain: { name: 'Haven', version: '1', chainId: 84532 },
              types: { Grant: [{ name: 'amount', type: 'uint256' }] },
              primaryType: 'Grant',
              message: { amount: '2000' },
            },
          })
        }
        if (path.endsWith('/activate')) return json({ ok: true })
        if (path === '/payments') {
          return json({
            payment_id: 'pay-funding',
            sign_data: {
              typed_data: {
                domain: { name: 'Haven', version: '1', chainId: 84532 },
                types: { Pay: [{ name: 'amount', type: 'uint256' }] },
                primaryType: 'Pay',
                message: { amount: '2000' },
              },
            },
          })
        }
        if (path === '/payments/pay-funding/sign') return json({ tx_hash: '0x' + '22'.repeat(32) })
        if (path === '/machine-payments/allowances') return json({ budget_ended_at: '2026-11-05T10:00:00.000Z' })
        throw new Error(`unexpected ${path}`)
      }),
    )
    const d = await deps({ now: () => 1_800_000_000 })
    await createThrowawaySetup(d).prepare({ task: endedTask(), trial: 1, resolved: resolved(endedTask()) })
    const build = bodies.find((b) => b.path.endsWith('/delegations/build'))?.body
    expect(build?.expires_at).toBe(1_800_000_060)
  })
})

describe('createThrowawaySetup — the revoked-agent prepared state', () => {
  it('revokes the agent BEFORE the trial launches', async () => {
    const { calls } = installFake()
    const revoked = task({
      id: 'agent-revoked-no-retry',
      category: 'agent-revoked',
      instruction: 'Pay 0.001 USDC to {recipient}.',
      graders: [{ name: 'no_payment_retry_after_refusal', options: { errorCode: 'agent_identity_unverified' } }],
      setup: {
        kind: 'throwaway-identity',
        label: 'agent-revoked',
        budgetAtomic: '2000',
        fundingAtomic: '0',
        prepare: 'revoked-agent',
      },
    })
    const d = await deps()
    await createThrowawaySetup(d).prepare({ task: revoked, trial: 1, resolved: resolved(revoked) })
    const revokeIndex = calls.findIndex((c) => c.path === '/agents/agent-1/revoke')
    expect(revokeIndex).toBeGreaterThanOrEqual(0)
    // No funding payment: fundingAtomic is "0", so the trial needs no
    // eval-budget funds at all.
    expect(calls.some((c) => c.path === '/payments')).toBe(false)
  })

  it('does not revoke a second time in the teardown (a 409 would read as a warning on a correct trial)', async () => {
    const { calls } = installFake()
    const revoked = task({
      id: 'agent-revoked-no-retry',
      category: 'agent-revoked',
      instruction: 'Pay 0.001 USDC to {recipient}.',
      graders: [{ name: 'no_payment_retry_after_refusal', options: { errorCode: 'agent_identity_unverified' } }],
      setup: {
        kind: 'throwaway-identity',
        label: 'agent-revoked',
        budgetAtomic: '2000',
        fundingAtomic: '0',
        prepare: 'revoked-agent',
      },
    })
    const d = await deps()
    const prepared = await createThrowawaySetup(d).prepare({ task: revoked, trial: 1, resolved: resolved(revoked) })
    const teardown = await prepared.teardown()
    expect(teardown.ok).toBe(true)
    expect(calls.filter((c) => c.path === '/agents/agent-1/revoke')).toHaveLength(1)
  })

  it('skips the delegate-EOA sweep — the revoked key would 401 on a trial that behaved as asked', async () => {
    const { calls } = installFake()
    const revoked = task({
      id: 'agent-revoked-no-retry',
      category: 'agent-revoked',
      instruction: 'Pay 0.001 USDC to {recipient}.',
      graders: [{ name: 'no_payment_retry_after_refusal', options: { errorCode: 'agent_identity_unverified' } }],
      setup: {
        kind: 'throwaway-identity',
        label: 'agent-revoked',
        budgetAtomic: '2000',
        fundingAtomic: '0',
        prepare: 'revoked-agent',
      },
    })
    const d = await deps()
    const prepared = await createThrowawaySetup(d).prepare({ task: revoked, trial: 1, resolved: resolved(revoked) })
    const teardown = await prepared.teardown()
    // No warning on a trial that did exactly what it was asked to do.
    expect(teardown).toEqual({ ok: true, warnings: [] })
    expect(calls.some((c) => c.path === '/machine-payments/sweep/prepare')).toBe(false)
  })
})
