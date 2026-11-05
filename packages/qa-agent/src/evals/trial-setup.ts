/**
 * Per-trial prepared state and teardown (#4678).
 *
 * Today one fixed agent serves every trial. This module lets a task run
 * against state prepared FOR THAT TRIAL — a throwaway delegation-rail
 * identity, funded from the eval account, with the trial's own agent key —
 * and clean up after it, including when setup fails partway.
 *
 * ## Why the cleanup is a REGISTRY, not a `finally` block
 *
 * "Teardown after every trial" has to include setup that fails after
 * resources start being created, not only trials that reached the agent. So
 * each resource is registered the moment it exists, and the teardown runs
 * over whatever is registered — a crash after any phase still undoes what
 * exists, and nothing that was never created is attempted.
 *
 * ## The order, and why it is not negotiable
 *
 *   1. sweep delegate-EOA leftovers — the bridge can strand USDC on the
 *      delegate EOA; it is recovered gaslessly while the agent key is still
 *      valid;
 *   2. return account USDC — the throwaway account's balance goes back to the
 *      EVAL ACCOUNT, never `QA_DELEGATION_*` (`agent-evals.yml`). A revoked
 *      key gets a 401, so this uses the OWNER-signed
 *      `POST /accounts/hybrid/:address/transfers/prepare` then `/submit`;
 *   3. close any task budget left open — BEFORE the revoke, because the close
 *      route is agent-authenticated and the revoke invalidates the key;
 *   4. revoke the agent.
 *
 * A failed teardown is a WARNING, never a change to the trial's verdict — the
 * same rule as `withThrowawayIdentity`'s `cleanupWarning`.
 *
 * ## Money
 *
 * The funding payment is made BY the eval agent, so it is the only amount a
 * throwaway trial takes from the eval agent's period budget. Returned USDC
 * does NOT restore period budget, which is why the task files state their
 * per-trial cost explicitly.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ethers } from 'ethers'
import { buildSweepTypedData } from '@haven_ai/sdk'
import { provisionThrowawayIdentity, payViaDelegation, signTyped, type ThrowawayIdentity } from '../lib/throwaway-identity.js'
import { SEPOLIA_USDC } from '../lib/chain.js'
import type { SecretManifest } from './secret-manifest.js'
import type { EvalTask, GraderContext, ResolvedTask } from './types.js'

// ── Teardown ───────────────────────────────────────────────────────────────

/** What a trial's teardown did. `ok: false` is a warning, never a verdict change. */
export interface TrialTeardown {
  ok: boolean
  /** One line per step that did not land. Never a secret value. */
  warnings: string[]
  /** USDC the teardown could NOT return to the eval account, atomic. */
  unreturnedAtomic?: string
}

/** The resources a trial may create, in the order they come into existence. */
export type CleanupResourceKind = 'account' | 'agent' | 'funding' | 'delegate-eoa' | 'task-budget'

/**
 * The teardown steps, injected so a unit test can prove the ORDER and the
 * incremental registration without a network.
 */
export interface CleanupSteps {
  /** Gasless sweep of the delegate EOA's stranded USDC. Warning or null. */
  sweepDelegateEoa(): Promise<string | null>
  /** Owner-signed return of the account's USDC to the eval account. */
  returnAccountUsdc(): Promise<{ warning?: string; unreturnedAtomic?: string }>
  /** Close one task budget left open. Warning or null. */
  closeTaskBudget(id: string): Promise<string | null>
  /** Revoke the trial's agent(s). Warning or null. */
  revokeAgent(): Promise<string | null>
}

export interface CleanupRegistry {
  /** Record that a resource now exists. Idempotent per (kind, id). */
  register(kind: CleanupResourceKind, id: string): void
  /** The ids registered for one kind, in registration order. */
  registered(kind: CleanupResourceKind): string[]
  /** Run the teardown over whatever is registered. Never throws. */
  run(): Promise<TrialTeardown>
}

/**
 * Build the registry. `run()` is safe to call more than once (a second call
 * is a no-op) and never throws: a step that throws becomes a warning.
 */
export function createCleanupRegistry(steps: CleanupSteps): CleanupRegistry {
  const byKind = new Map<CleanupResourceKind, string[]>()
  let ran: TrialTeardown | undefined

  const register = (kind: CleanupResourceKind, id: string): void => {
    const list = byKind.get(kind) ?? []
    if (!list.includes(id)) list.push(id)
    byKind.set(kind, list)
  }
  const registered = (kind: CleanupResourceKind): string[] => [...(byKind.get(kind) ?? [])]

  const attempt = async (label: string, fn: () => Promise<string | null>): Promise<string | null> => {
    try {
      return await fn()
    } catch (err) {
      return `${label} threw: ${(err as Error)?.message ?? String(err)}`
    }
  }

  const run = async (): Promise<TrialTeardown> => {
    if (ran) return ran
    const warnings: string[] = []
    let unreturnedAtomic: string | undefined

    // 1. sweep delegate-EOA leftovers
    if (registered('delegate-eoa').length > 0) {
      const warning = await attempt('sweep delegate EOA', () => steps.sweepDelegateEoa())
      if (warning) warnings.push(warning)
    }
    // 2. return account USDC to the eval account
    if (registered('account').length > 0) {
      try {
        const result = await steps.returnAccountUsdc()
        if (result.warning) warnings.push(result.warning)
        if (result.unreturnedAtomic !== undefined) unreturnedAtomic = result.unreturnedAtomic
      } catch (err) {
        warnings.push(`return account USDC threw: ${(err as Error)?.message ?? String(err)}`)
      }
    }
    // 3. close any task budget left open — before the revoke, which would
    //    invalidate the agent key the close route needs.
    for (const id of registered('task-budget')) {
      const warning = await attempt(`close task budget ${id}`, () => steps.closeTaskBudget(id))
      if (warning) warnings.push(warning)
    }
    // 4. revoke
    if (registered('agent').length > 0) {
      const warning = await attempt('revoke agent', () => steps.revokeAgent())
      if (warning) warnings.push(warning)
    }

    ran = {
      ok: warnings.length === 0,
      warnings,
      ...(unreturnedAtomic !== undefined ? { unreturnedAtomic } : {}),
    }
    return ran
  }

  return { register, registered, run }
}

// ── The setup hook ─────────────────────────────────────────────────────────

/** What a setup hook hands back to the runner. */
export interface TrialPreparedState {
  /** Fields merged onto the resolved task before the adapter runs. */
  resolved?: Partial<ResolvedTask>
  /** The trial's OWN grader context (its own key), when it differs. */
  graderContext?: Omit<GraderContext, 'resolved'>
  /**
   * Undo whatever this trial created, in the fixed order. Never throws: a
   * failed step is a warning on the returned {@link TrialTeardown}.
   */
  teardown(): Promise<TrialTeardown>
}

/**
 * A setup that failed partway. It carries the teardown for whatever was
 * already created, so the runner can still undo it — "teardown after every
 * trial" includes setup that fails after resources start being created.
 */
export class TrialSetupFailure extends Error {
  constructor(
    message: string,
    readonly teardown: () => Promise<TrialTeardown>,
  ) {
    super(message)
    this.name = 'TrialSetupFailure'
  }
}

/** The runner's setup seam. Absent = the shared eval agent, no teardown. */
export interface TrialSetupHook {
  prepare(ctx: { task: EvalTask; trial: number; resolved: ResolvedTask }): Promise<TrialPreparedState>
}

export interface ThrowawaySetupDeps {
  apiUrl: string
  chainId: number
  /** Where returned USDC goes — the eval account, never `QA_DELEGATION_*`. */
  evalAccountAddress: string
  /** The eval agent's key + delegate key: the funding payment is made AS the eval agent. */
  evalAgentApiKey: string
  evalDelegateKey: string
  /** The per-trial exact-value inventory. Every generated secret lands here. */
  manifest: SecretManifest
  /** Where the trial's credential + MCP files go (mode 0600, outside every report/upload path). */
  trialDir: string
  /** The hosted MCP URL the trial's config points at. */
  hostedMcpUrl: string
  /** The signer CLI the trial's config points at. */
  signerCliPath: string
  /** The public address the signer verifies x402 expected-context bindings against. */
  x402BindingSigner?: string
  /**
   * The recipient the interrupted-purchase intent pays (#4678). The prepared
   * payment is a DIRECT payment authorized as the throwaway agent and left
   * unsigned — the agent must resume it, never pay again.
   */
  recipient?: string
  /** Injectable delay (tests). */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock, unix seconds (tests). */
  now?: () => number
  /** The bounded readiness poll for the ended-budget task. */
  endedBudgetTimeoutMs?: number
  endedBudgetPollMs?: number
  /** Injectable USDC balance read (tests). */
  readUsdcBalance?: (address: string) => Promise<bigint>
}

/** The default bounded readiness poll: 5 minutes, every 3 s. */
export const ENDED_BUDGET_TIMEOUT_MS = 300_000
export const ENDED_BUDGET_POLL_MS = 3_000

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The five secret classes the throwaway identity generates (#4678). */
export const THROWAWAY_SECRET_NAMES = [
  'throwaway_owner_key',
  'throwaway_delegate_key',
  'throwaway_signup_password',
  'throwaway_signup_token',
  'throwaway_agent_api_key',
] as const

/**
 * The throwaway setup hook. One instance per run; `prepare` is called once
 * per trial and owns that trial's identity, funding, prepared state and
 * teardown.
 */
export function createThrowawaySetup(deps: ThrowawaySetupDeps): TrialSetupHook {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const timeoutMs = deps.endedBudgetTimeoutMs ?? ENDED_BUDGET_TIMEOUT_MS
  const pollMs = deps.endedBudgetPollMs ?? ENDED_BUDGET_POLL_MS

  return {
    async prepare({ task, trial, resolved }) {
      const setup = task.setup
      if (!setup || setup.kind !== 'throwaway-identity') {
        throw new Error(`task ${task.id} has no throwaway setup — the hook was wired for a task that does not ask for one`)
      }

      // The registry is created as soon as the identity exists, and every
      // later phase registers its resource BEFORE using it. A failure after
      // any phase therefore still tears down what exists.
      let cleanup: CleanupRegistry | undefined
      // Mutated by the revoked-agent prepared state, read by the teardown.
      const cleanupOpts: { alreadyRevoked?: boolean } = {}
      const teardown = async (): Promise<TrialTeardown> =>
        cleanup ? cleanup.run() : { ok: true, warnings: [] }

      try {
        // ── 1. the identity ──────────────────────────────────────────────
        // Every generated secret enters the manifest BEFORE the agent starts.
        const identity = await provisionThrowawayIdentity(deps.apiUrl, {
          chainId: deps.chainId,
          budgetAtomic: setup.budgetAtomic,
          label: setup.label,
          ...(setup.expiresInSeconds !== undefined ? { expiresAt: now() + setup.expiresInSeconds } : {}),
          onSecret: (name, value) => deps.manifest.append(name, value),
        })
        if ('error' in identity) {
          // The identity module revokes a half-built agent itself; nothing is
          // registered here because nothing survived.
          throw new Error(`throwaway provisioning failed for ${task.id} trial ${trial}: ${identity.error}`)
        }
        cleanup = createCleanupRegistry(throwawayCleanupSteps(deps, identity, cleanupOpts))
        cleanup.register('account', identity.accountAddress)
        cleanup.register('agent', identity.agentId)
        if (identity.delegateAccountAddress) cleanup.register('delegate-eoa', identity.delegateAccountAddress)

        // ── 2. funding ───────────────────────────────────────────────────
        // The ONLY amount this trial takes from the eval agent's period budget.
        const fundingAtomic = BigInt(setup.fundingAtomic)
        if (fundingAtomic > 0n) {
          const human = ethers.formatUnits(fundingAtomic, 6)
          const funded = await payViaDelegation(
            deps.apiUrl,
            deps.evalAgentApiKey,
            deps.evalDelegateKey,
            identity.accountAddress,
            human,
          )
          if (!funded.ok) {
            throw new Error(
              `funding the throwaway account failed for ${task.id} trial ${trial} (${human} USDC): ${funded.error}`,
            )
          }
          cleanup.register('funding', funded.tx ?? `${task.id}:${trial}`)
        }

        // ── 3. the trial's own credential + MCP config ───────────────────
        const trialEnv = await writeTrialConfig(deps, task, trial, identity)

        // ── 4. the prepared state ────────────────────────────────────────
        let preparedPaymentId: string | undefined
        let instruction = resolved.instruction
        if (setup.prepare === 'interrupted-purchase') {
          preparedPaymentId = await prepareInterruptedPurchase(deps, identity, setup.budgetAtomic)
          instruction = renderPreparedInstruction(resolved, preparedPaymentId)
        } else if (setup.prepare === 'ended-budget') {
          // A fixed sleep races wall-clock and block time. Poll the
          // AUTHORITATIVE allowance signal, within a bound, until the budget
          // reads as ended — the agent starts only once the ended state is
          // observable.
          await waitForEndedBudget(deps, identity, { timeoutMs, pollMs, sleep })
        } else if (setup.prepare === 'revoked-agent') {
          const warning = await identity.revoke()
          if (warning) throw new Error(`could not revoke the throwaway agent before launch: ${warning}`)
          cleanupOpts.alreadyRevoked = true
        }

        return {
          resolved: {
            trialApiKey: identity.agentApiKey,
            trialAccountAddress: identity.accountAddress,
            trialEnv,
            ...(task.commandTemplate !== undefined ? { commandTemplate: task.commandTemplate } : {}),
            ...(preparedPaymentId !== undefined ? { preparedPaymentId } : {}),
            instruction,
          },
          // The trial's graders read with the TRIAL's key, never the eval
          // agent's: a `GET /payments/:id` on a throwaway trial must not use
          // the eval key.
          graderContext: buildTrialGraderContext(deps, identity),
          teardown,
        }
      } catch (err) {
        throw new TrialSetupFailure((err as Error)?.message ?? String(err), teardown)
      }
    },
  }
}

/**
 * The trial's grader context. `probePaymentStatus` reads the payment with the
 * TRIAL's agent key — the eval key would answer 404/403 for a payment the
 * throwaway agent created, and a grader that cannot read its own trial's
 * payment is a grader that fails for the wrong reason.
 */
function buildTrialGraderContext(
  deps: ThrowawaySetupDeps,
  identity: ThrowawayIdentity,
): Omit<GraderContext, 'resolved'> {
  return {
    probePaymentStatus: async (paymentId) => {
      const res = await fetch(`${deps.apiUrl}/payments/${paymentId}`, {
        headers: { authorization: `Bearer ${identity.agentApiKey}` },
      })
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} reading payment ${paymentId} with the trial's key` }
      }
      const body = (await res.json().catch(() => ({}))) as { status?: string; amount?: unknown }
      const amountAtomic = parseHumanAmountToAtomic(body.amount)
      return { ok: true, status: body.status ?? 'unknown', ...(amountAtomic !== undefined ? { amountAtomic } : {}) }
    },
  }
}

/** Strict decimal → atomic at USDC's 6 decimals; undefined for anything else. */
function parseHumanAmountToAtomic(amount: unknown): string | undefined {
  if (typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount)) return undefined
  const [whole, frac = ''] = amount.split('.')
  if (frac.length > 6) return undefined
  return BigInt(`${whole}${frac.padEnd(6, '0')}`).toString()
}

/**
 * Write the trial's credential file and MCP config, mode `0600`, and return
 * the env the adapter's child process gets. The delegate key NEVER reaches
 * the hosted server env — only the signer process reads it, via the
 * credential file (the custody guard would refuse to boot otherwise).
 */
async function writeTrialConfig(
  deps: ThrowawaySetupDeps,
  task: EvalTask,
  trial: number,
  identity: ThrowawayIdentity,
): Promise<Record<string, string>> {
  const dir = join(deps.trialDir, `${task.id}-trial${trial}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const credentials = join(dir, 'agent.json')
  const mcpConfig = join(dir, 'mcp.json')
  await writeFile(credentials, JSON.stringify({ delegate_key: identity.delegate.privateKey }, null, 2), { mode: 0o600 })
  const config = {
    mcpServers: {
      'haven-eval': {
        type: 'http',
        url: deps.hostedMcpUrl,
        headers: { Authorization: `Bearer ${identity.agentApiKey}` },
      },
      'haven-signer-eval': {
        type: 'stdio',
        command: 'node',
        args: [deps.signerCliPath, '--ack'],
        env: {
          HAVEN_CREDENTIALS: credentials,
          ...(deps.x402BindingSigner ? { HAVEN_X402_BINDING_SIGNER: deps.x402BindingSigner } : {}),
        },
      },
    },
  }
  await writeFile(mcpConfig, JSON.stringify(config, null, 2), { mode: 0o600 })
  return {
    QA_EVAL_TRIAL_MCP_CONFIG: mcpConfig,
    QA_EVAL_TRIAL_CREDENTIALS: credentials,
    QA_EVAL_TRIAL_API_KEY: identity.agentApiKey,
    QA_EVAL_TRIAL_HOME: dir,
  }
}

/**
 * Prepare the interrupted purchase: authorize a DIRECT payment AS the
 * throwaway agent and leave it unsigned. The agent is handed the `payment_id`
 * and must resume it — `haven_get_payment_status`, then the signer handoff —
 * never pay again.
 *
 * A direct payment is the deterministic shape: it needs only the recipient
 * and the amount, both of which the harness owns. An x402 intent would need
 * the merchant's `payTo` from a live 402 challenge, which the harness does
 * not fetch.
 */
async function prepareInterruptedPurchase(
  deps: ThrowawaySetupDeps,
  identity: ThrowawayIdentity,
  budgetAtomic: string,
): Promise<string> {
  if (!deps.recipient) {
    throw new Error('the interrupted-purchase task needs QA_EVAL_RECIPIENT — the prepared payment pays it')
  }
  const res = await fetch(`${deps.apiUrl}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.agentApiKey}` },
    body: JSON.stringify({
      token: 'USDC',
      amount: ethers.formatUnits(BigInt(budgetAtomic), 6),
      to: deps.recipient,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { payment_id?: string; error?: string }
  if (!res.ok || !body.payment_id) {
    throw new Error(`could not prepare the interrupted purchase (HTTP ${res.status}): ${body.error ?? ''}`)
  }
  return body.payment_id
}

/** Re-render the instruction with the prepared payment id. */
function renderPreparedInstruction(resolved: ResolvedTask, paymentId: string): string {
  return resolved.instruction.replaceAll('{payment_id}', paymentId)
}

/**
 * Poll the AUTHORITATIVE allowance signal until the budget reads as ended.
 *
 * `GET /machine-payments/allowances` answers `budget_ended_at` only when the
 * agent's live `allowances[]` is empty and an ended row exists (#4352/#4668),
 * so a non-null value IS the ended state — not a proxy for it. A fixed sleep
 * after a short `expires_at` races wall-clock and block time; this does not.
 */
async function waitForEndedBudget(
  deps: ThrowawaySetupDeps,
  identity: ThrowawayIdentity,
  opts: { timeoutMs: number; pollMs: number; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs
  let lastError: string | undefined
  for (;;) {
    const res = await fetch(`${deps.apiUrl}/machine-payments/allowances`, {
      headers: { authorization: `Bearer ${identity.agentApiKey}` },
    })
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { budget_ended_at?: string | null }
      if (typeof body.budget_ended_at === 'string' && body.budget_ended_at.length > 0) return
      lastError = undefined
    } else {
      lastError = `HTTP ${res.status} reading the allowance signal`
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the ended-budget state never became observable within ${opts.timeoutMs}ms` +
          (lastError ? ` (last read: ${lastError})` : ' (budget_ended_at stayed null)'),
      )
    }
    await opts.sleep(opts.pollMs)
  }
}

/**
 * The teardown steps for one throwaway trial. Built per trial because every
 * step needs that trial's identity.
 */
export function throwawayCleanupSteps(
  deps: ThrowawaySetupDeps,
  identity: ThrowawayIdentity,
  opts: { alreadyRevoked?: boolean } = {},
): CleanupSteps {
  const readBalance = deps.readUsdcBalance ?? defaultUsdcBalance
  return {
    async sweepDelegateEoa() {
      const res = await fetch(`${deps.apiUrl}/machine-payments/sweep/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.agentApiKey}` },
        body: '{}',
      })
      if (!res.ok) return `sweep prepare failed (HTTP ${res.status}) — stranded delegate funds may remain`
      const prep = (await res.json().catch(() => ({}))) as {
        authorization?: Record<string, unknown>
        nothing_stranded?: boolean
        below_min?: boolean
        error?: string
      }
      if (prep.nothing_stranded || prep.below_min || !prep.authorization) return null
      const typed = buildSweepTypedData(prep.authorization as never)
      const signature = await signTyped(identity.delegate, typed as never)
      const submit = await fetch(`${deps.apiUrl}/machine-payments/sweep/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.agentApiKey}` },
        body: JSON.stringify({ authorization: prep.authorization, signature }),
      })
      if (!submit.ok) return `sweep submit failed (HTTP ${submit.status}) — stranded delegate funds may remain`
      return null
    },

    async returnAccountUsdc() {
      let balance: bigint
      try {
        balance = await readBalance(identity.accountAddress)
      } catch (err) {
        return { warning: `could not read the throwaway account's USDC balance: ${(err as Error)?.message ?? String(err)}` }
      }
      if (balance === 0n) return {}
      const prepared = await fetch(`${deps.apiUrl}/accounts/hybrid/${identity.accountAddress}/transfers/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.token}` },
        body: JSON.stringify({ token_address: SEPOLIA_USDC, to: deps.evalAccountAddress, amount_atomic: balance.toString() }),
      })
      const prep = (await prepared.json().catch(() => ({}))) as {
        signing_payload?: Record<string, unknown>
        user_operation?: unknown
        error?: string
      }
      if (!prepared.ok || !prep.signing_payload) {
        return {
          warning: `returning ${balance} atomic USDC failed at prepare (HTTP ${prepared.status}): ${prep.error ?? ''}`,
          unreturnedAtomic: balance.toString(),
        }
      }
      const signature = await signTyped(identity.owner, prep.signing_payload as never)
      const submitted = await fetch(`${deps.apiUrl}/accounts/hybrid/${identity.accountAddress}/transfers/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.token}` },
        body: JSON.stringify({
          token_address: SEPOLIA_USDC,
          to: deps.evalAccountAddress,
          amount_atomic: balance.toString(),
          signature,
          user_operation: prep.user_operation,
        }),
      })
      if (!submitted.ok) {
        const body = (await submitted.json().catch(() => ({}))) as { error?: string }
        return {
          warning: `returning ${balance} atomic USDC failed at submit (HTTP ${submitted.status}): ${body.error ?? ''}`,
          unreturnedAtomic: balance.toString(),
        }
      }
      return {}
    },

    async closeTaskBudget(id) {
      const res = await fetch(`${deps.apiUrl}/task-budgets/${id}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.agentApiKey}` },
        body: '{}',
      })
      if (res.ok) return null
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      return `task budget ${id} was NOT closed (HTTP ${res.status}): ${body.error ?? ''}`
    },

    async revokeAgent() {
      // The revoked-agent task revokes BEFORE launch; a second revoke would
      // answer 409 and read as a teardown warning on a trial that behaved
      // exactly as asked.
      if (opts.alreadyRevoked) return null
      return identity.revoke()
    },
  }
}

/** The default USDC balance read, against the observer node. */
async function defaultUsdcBalance(address: string): Promise<bigint> {
  const { observerProvider, ERC20_BALANCE_ABI } = await import('../lib/chain.js')
  const usdc = new ethers.Contract(SEPOLIA_USDC, [...ERC20_BALANCE_ABI], observerProvider() as never)
  return (await usdc.balanceOf(address)) as bigint
}
