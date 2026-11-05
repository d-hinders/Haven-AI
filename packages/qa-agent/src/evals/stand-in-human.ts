/**
 * The stand-in human for the full-onboarding spike (#4682).
 *
 * The cold onboarding eval stops at the login wall because the next steps are
 * the HUMAN's: approve a device login, approve a budget. This module is the
 * script that plays that human, so one recorded run can go from the landing
 * URL to a settled first payment.
 *
 * ## What it holds, and what it must never hand over
 *
 * The stand-in owns the throwaway wallet's owner key, the signup password, the
 * signup bearer token, the device-login approval authority and the budget
 * approval. None of those may reach the agent under test — not its prompt, not
 * its child environment, not its tool stream, not its final result. Every one
 * of them is appended to #4678's per-trial exact-value manifest BEFORE the
 * agent launches, so the transcript redactor can prove the boundary rather
 * than assert it.
 *
 * ## The order the code requires
 *
 *   1. `POST /auth/signup` — the token carries no `purpose`, so
 *      `authMiddleware` accepts it on `POST /auth/device/approve`, which
 *      refuses an `owner_cli` token (`routes/auth.ts:321`);
 *   2. `POST /accounts/hybrid` with `owner_address` — the throwaway wallet is
 *      the account's owner, exactly as `throwaway-identity.ts` does it;
 *   3. `POST /agent-connection-setups` — the setup the agent's `agents connect`
 *      will resolve and register against;
 *   4. the agent runs `agents connect`, which REGISTERS the agent (the setup
 *      needs `agent_id` and `delegate_address` before a budget can exist);
 *   5. `POST /agents/:id/delegations/build` → owner signature → `/activate` →
 *      `POST /agent-connection-setups/:setupId/budget-approval`.
 *
 * Step 5 reads the SETUP's own `allowance_amount` and `reset_period_min` and
 * builds the grant from those. The harness's `86_400` is not used: the
 * backend compares the active delegation's `budget_atomic` and `period_seconds`
 * against the setup row (`verifyDelegationSetupAuthority`), so a hard-coded
 * period matches only a setup that happens to ask for it.
 *
 * ## Teardown
 *
 * Every attempt tears down through #4678's registry, in its fixed order:
 * sweep delegate-EOA leftovers, return the account's USDC to the eval account,
 * close any task budget left open, then revoke. The stand-in cannot sweep the
 * delegate EOA itself — that key belongs to the agent's connector, by design —
 * so the sweep step reads the EOA's on-chain balance and reports a warning
 * naming the amount when anything is stranded. A failed step is a warning,
 * never a verdict change.
 */

import { ethers } from 'ethers'
import { payViaDelegation, signTyped, type TypedData } from '../lib/throwaway-identity.js'
import { SEPOLIA_USDC } from '../lib/chain.js'
import { createCleanupRegistry, type CleanupSteps, type TrialTeardown } from './trial-setup.js'
import type { SecretManifest } from './secret-manifest.js'

/** The five values the stand-in generates, plus the approval authority it holds. */
export const STAND_IN_SECRET_NAMES = [
  'stand_in_owner_key',
  'stand_in_signup_password',
  'stand_in_signup_token',
  'stand_in_device_user_code',
  'stand_in_approval_authority',
] as const

export interface StandInHumanOptions {
  apiUrl: string
  chainId: number
  /** The throwaway identity's label; it rides the #4679 marker in name and email. */
  label: string
  /** The eval agent's key + delegate key: funding is made AS the eval agent. */
  evalAgentApiKey: string
  evalDelegateKey: string
  /** Where returned USDC goes — the eval account, never `QA_DELEGATION_*`. */
  evalAccountAddress: string
  /** The per-trial exact-value inventory (#4678). Every generated value lands here. */
  manifest: SecretManifest
  /** The budget the setup asks for, atomic. */
  budgetAtomic: string
  /** The period the setup asks for, seconds. */
  periodSeconds: number
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch
  /** Injectable USDC balance read (tests). */
  readUsdcBalance?: (address: string) => Promise<bigint>
}

/** What the stand-in did, for the run's evidence table. */
export interface StandInEvidence {
  ownerAddress: string
  accountAddress: string
  accountId: string
  setupId: string
  approvalUrl: string
  connectorCommand: string
  /** The values the grant was built from — read from the setup, never assumed. */
  grant?: { delegationHash: string; budgetAtomic: string; periodSeconds: number }
  /** The device-login approvals this stand-in performed. */
  deviceApprovals: string[]
  /** The funding payment, when one was made. */
  funding?: { amountAtomic: string; tx?: string }
  /** Atomic USDC the teardown returned to the eval account. */
  returnedAtomic?: string
  /** Atomic USDC left stranded on the delegate EOA (the stand-in cannot sweep it). */
  sweptAtomic?: string
}

export interface StandInHuman {
  readonly evidence: StandInEvidence
  /** `POST /auth/device/approve` with the signup token (no `purpose`). */
  approveDeviceLogin(userCode: string): Promise<{ status: string }>
  /** Fund the throwaway account from the eval account. */
  fund(amountAtomic: string): Promise<{ tx?: string }>
  /** Read the setup's exact values, build + activate the grant, approve the budget. */
  approveBudget(): Promise<{ delegationHash: string; budgetAtomic: string; periodSeconds: number }>
  /** #4678's registered teardown, in its fixed order. Never throws. */
  teardown(): Promise<TrialTeardown>
  /** Every value the leak test scans for. */
  inventory(): Array<{ name: string; value: string }>
}

/** A stand-in that could not be provisioned; `cleanupWarning` when a half-built one could not be undone. */
export interface StandInError {
  error: string
  cleanupWarning?: string
}

interface SetupStatus {
  setup_id?: string
  agent_id?: string | null
  approval_url?: string
  status?: string
  delegate_address?: string | null
  agent_budget?: Array<{
    token_address?: string
    token_symbol?: string
    allowance_amount?: string
    reset_period_min?: number
  }>
  error?: string
}

/**
 * Provision the stand-in: signup, hybrid account, and the connection setup the
 * agent will register against. Every generated value is recorded in the
 * manifest BEFORE the request that uses it.
 */
export async function createStandInHuman(
  options: StandInHumanOptions,
): Promise<StandInHuman | StandInError> {
  const doFetch = options.fetchImpl ?? fetch
  const owner = ethers.Wallet.createRandom()
  const password = 'Qa-' + ethers.Wallet.createRandom().privateKey.slice(2, 26)
  const email = `qa-${options.label}-${Math.random().toString(36).slice(2, 10)}@haven.test`
  const inventory: Array<{ name: string; value: string }> = []

  const record = async (name: string, value: string): Promise<void> => {
    inventory.push({ name, value })
    await options.manifest.append(name, value)
  }

  // The key and password exist before any request; record them first so a
  // crash during signup still leaves them in the inventory.
  await record('stand_in_owner_key', owner.privateKey)
  await record('stand_in_signup_password', password)

  async function call<T>(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const res = await doFetch(`${options.apiUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json().catch(() => ({}))) as T }
  }

  const signup = await call<{ token?: string; error?: string }>('POST', '/auth/signup', null, {
    name: `QA ${options.label} (throwaway)`,
    email,
    password,
  })
  const token = signup.json.token
  if (!token) return { error: `stand-in signup failed (${signup.status}): ${signup.json.error ?? ''}` }
  await record('stand_in_signup_token', token)
  // The signup token IS the approval authority: it is what `POST
  // /auth/device/approve` accepts, and what the budget approval is made with.
  await record('stand_in_approval_authority', token)

  const hybrid = await call<{ error?: string }>('POST', '/accounts/hybrid', token, {
    chain_id: options.chainId,
    owner_address: owner.address,
  })
  if (hybrid.status !== 201) {
    return { error: `stand-in hybrid provisioning failed (${hybrid.status}): ${hybrid.json.error ?? ''}` }
  }
  const me = await call<{ accounts?: Array<{ id: string; account_address: string; account_type?: string }> }>(
    'GET',
    '/auth/me',
    token,
  )
  const account = me.json.accounts?.find((a) => a.account_type === 'delegator_hybrid')
  if (!account) return { error: 'the stand-in account is missing from /auth/me' }

  const periodMinutes = Math.round(options.periodSeconds / 60)
  const setup = await call<{
    setup_id?: string
    setup_token?: string
    approval_url?: string
    connector_command?: string
    error?: string
  }>('POST', '/agent-connection-setups', token, {
    account_id: account.id,
    name: `QA ${options.label} agent`,
    allowances: [
      {
        token_address: SEPOLIA_USDC,
        token_symbol: 'USDC',
        allowance_amount: options.budgetAtomic,
        reset_period_min: periodMinutes,
      },
    ],
  })
  if (setup.status !== 201 || !setup.json.setup_id) {
    return { error: `stand-in setup creation failed (${setup.status}): ${setup.json.error ?? ''}` }
  }

  const evidence: StandInEvidence = {
    ownerAddress: owner.address,
    accountAddress: account.account_address,
    accountId: account.id,
    setupId: setup.json.setup_id,
    approvalUrl: setup.json.approval_url ?? '',
    connectorCommand: setup.json.connector_command ?? '',
    deviceApprovals: [],
  }

  // ── Teardown (#4678's registry, its fixed order) ──────────────────────────
  const cleanup = createCleanupRegistry(
    standInCleanupSteps(options, {
      token,
      owner,
      accountAddress: account.account_address,
      setupId: evidence.setupId,
      doFetch,
      evidence,
    }),
  )
  cleanup.register('account', account.account_address)
  // The agent and its delegate EOA do not exist until the CONNECTOR registers
  // them, so the stand-in registers the SETUP as their marker: the teardown
  // steps resolve the agent id and delegate address from the setup row at
  // teardown time. Registering them here is what makes the sweep and the
  // revoke run at all — an unregistered kind is a step the registry skips.
  cleanup.register('agent', evidence.setupId)
  cleanup.register('delegate-eoa', evidence.setupId)

  return {
    evidence,
    async approveDeviceLogin(userCode: string) {
      // The user code is a value the stand-in holds (it is the approval
      // authority's input), so it enters the inventory before the approval is
      // made — the leak test scans for it like every other value.
      await record('stand_in_device_user_code', userCode)
      const res = await call<{ status?: string; error?: string }>('POST', '/auth/device/approve', token, {
        user_code: userCode,
      })
      if (res.status !== 200) {
        throw new Error(`device approval failed (${res.status}): ${res.json.error ?? ''}`)
      }
      evidence.deviceApprovals.push(userCode)
      return { status: res.json.status ?? 'approved' }
    },

    async fund(amountAtomic: string) {
      const human = ethers.formatUnits(BigInt(amountAtomic), 6)
      const funded = await payViaDelegation(
        options.apiUrl,
        options.evalAgentApiKey,
        options.evalDelegateKey,
        account.account_address,
        human,
      )
      if (!funded.ok) {
        throw new Error(`funding the stand-in account failed (${human} USDC): ${funded.error}`)
      }
      evidence.funding = { amountAtomic, ...(funded.tx ? { tx: funded.tx } : {}) }
      return { ...(funded.tx ? { tx: funded.tx } : {}) }
    },

    async approveBudget() {
      // Read the SETUP's values. The backend compares the active delegation's
      // budget and period against this row, so building from anything else
      // (the harness's 86_400, for one) matches only by coincidence.
      const status = await call<SetupStatus>('GET', `/agent-connection-setups/${evidence.setupId}`, token)
      if (status.status !== 200) {
        throw new Error(`reading the setup failed (${status.status}): ${status.json.error ?? ''}`)
      }
      const agentId = status.json.agent_id
      if (!agentId) {
        throw new Error('the setup has no agent_id — the connector has not registered yet')
      }
      const allowance = status.json.agent_budget?.[0]
      // `allowance_amount` is ALREADY atomic (the create route validates it as
      // a digits-only atomic string and stores it verbatim). Converting it as
      // a human decimal multiplies it by 1e6 and the backend then refuses the
      // grant with "budget does not match this setup" — the first live attempt
      // found exactly that.
      const budgetAtomic =
        typeof allowance?.allowance_amount === 'string' && /^\d+$/.test(allowance.allowance_amount)
          ? allowance.allowance_amount
          : undefined
      const periodSeconds = typeof allowance?.reset_period_min === 'number' ? allowance.reset_period_min * 60 : undefined
      if (!budgetAtomic || periodSeconds === undefined) {
        throw new Error('the setup carries no readable allowance_amount / reset_period_min')
      }
      const tokenAddress = allowance?.token_address ?? SEPOLIA_USDC

      const built = await call<{
        delegation_hash?: string
        signing_payload?: TypedData
        error?: string
      }>('POST', `/agents/${agentId}/delegations/build`, token, {
        token_address: tokenAddress,
        budget_atomic: budgetAtomic,
        period_seconds: periodSeconds,
      })
      if (!built.json.delegation_hash || !built.json.signing_payload) {
        throw new Error(`grant build failed (${built.status}): ${built.json.error ?? ''}`)
      }
      const signature = await signTyped(owner, built.json.signing_payload)
      const activated = await call<{ error?: string }>(
        'POST',
        `/agents/${agentId}/delegations/${built.json.delegation_hash}/activate`,
        token,
        { signature },
      )
      if (activated.status !== 200) {
        throw new Error(`grant activation failed (${activated.status}): ${activated.json.error ?? ''}`)
      }
      const approved = await call<{ status?: string; error?: string }>(
        'POST',
        `/agent-connection-setups/${evidence.setupId}/budget-approval`,
        token,
        {},
      )
      if (approved.status !== 200) {
        throw new Error(`budget approval failed (${approved.status}): ${approved.json.error ?? ''}`)
      }
      evidence.grant = { delegationHash: built.json.delegation_hash, budgetAtomic, periodSeconds }
      return evidence.grant
    },

    async teardown() {
      return cleanup.run()
    },

    inventory() {
      return [...inventory]
    },
  }
}

/**
 * The stand-in's teardown steps. The sweep is the one step the stand-in cannot
 * perform: the delegate EOA's key belongs to the agent's connector, so the
 * stand-in reads the EOA's balance and reports what is stranded instead of
 * pretending to recover it.
 */
export function standInCleanupSteps(
  options: StandInHumanOptions,
  ctx: {
    token: string
    owner: ethers.Wallet | ethers.HDNodeWallet
    accountAddress: string
    setupId: string
    doFetch: typeof fetch
    /** Mutated with what the teardown actually returned / left stranded. */
    evidence: StandInEvidence
  },
): CleanupSteps {
  const readBalance = options.readUsdcBalance ?? defaultUsdcBalance
  return {
    async sweepDelegateEoa() {
      // The delegate address is only known once the connector registered; the
      // setup row carries it. A setup with no delegate has nothing stranded.
      const res = await ctx.doFetch(`${options.apiUrl}/agent-connection-setups/${ctx.setupId}`, {
        headers: { authorization: `Bearer ${ctx.token}` },
      })
      if (!res.ok) return `could not read the setup to find the delegate EOA (HTTP ${res.status})`
      const body = (await res.json().catch(() => ({}))) as { delegate_address?: string | null }
      if (!body.delegate_address) return null
      const balance = await readBalance(body.delegate_address)
      if (balance === 0n) return null
      ctx.evidence.sweptAtomic = balance.toString()
      return (
        `${balance} atomic USDC is stranded on the delegate EOA ${body.delegate_address}; ` +
        'the stand-in cannot sweep it (that key belongs to the agent connector) — ' +
        'the agent must run the sweep before the run ends'
      )
    },

    async returnAccountUsdc() {
      let balance: bigint
      try {
        balance = await readBalance(ctx.accountAddress)
      } catch (err) {
        return { warning: `could not read the stand-in account's USDC balance: ${(err as Error)?.message ?? String(err)}` }
      }
      if (balance === 0n) return {}
      const prepared = await ctx.doFetch(
        `${options.apiUrl}/accounts/hybrid/${ctx.accountAddress}/transfers/prepare?chain_id=${options.chainId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({
            token_address: SEPOLIA_USDC,
            to: options.evalAccountAddress,
            amount_atomic: balance.toString(),
          }),
        },
      )
      const prep = (await prepared.json().catch(() => ({}))) as {
        signing_payload?: TypedData
        user_operation?: unknown
        error?: string
      }
      if (!prepared.ok || !prep.signing_payload) {
        return {
          warning: `returning ${balance} atomic USDC failed at prepare (HTTP ${prepared.status}): ${prep.error ?? ''}`,
          unreturnedAtomic: balance.toString(),
        }
      }
      const signature = await signTyped(ctx.owner, prep.signing_payload)
      const submitted = await ctx.doFetch(
        `${options.apiUrl}/accounts/hybrid/${ctx.accountAddress}/transfers/submit?chain_id=${options.chainId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.token}` },
          body: JSON.stringify({
            token_address: SEPOLIA_USDC,
            to: options.evalAccountAddress,
            amount_atomic: balance.toString(),
            signature,
            user_operation: prep.user_operation,
          }),
        },
      )
      if (!submitted.ok) {
        const body = (await submitted.json().catch(() => ({}))) as { error?: string }
        return {
          warning: `returning ${balance} atomic USDC failed at submit (HTTP ${submitted.status}): ${body.error ?? ''}`,
          unreturnedAtomic: balance.toString(),
        }
      }
      ctx.evidence.returnedAtomic = balance.toString()
      return {}
    },

    async listOpenTaskBudgets() {
      // The stand-in holds no agent key, so it cannot read the agent's open
      // budgets. The agent's own teardown (#4678) closes them; this step is
      // empty by design rather than silently skipped.
      return []
    },

    async closeTaskBudget(id) {
      return `task budget ${id} was NOT closed: the stand-in holds no agent key`
    },

    async revokeAgent() {
      const res = await ctx.doFetch(`${options.apiUrl}/agent-connection-setups/${ctx.setupId}`, {
        headers: { authorization: `Bearer ${ctx.token}` },
      })
      if (!res.ok) return `could not read the setup to find the agent (HTTP ${res.status})`
      const body = (await res.json().catch(() => ({}))) as { agent_id?: string | null }
      if (!body.agent_id) return null
      const revoked = await ctx.doFetch(`${options.apiUrl}/agents/${body.agent_id}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.token}` },
        body: '{}',
      })
      if (revoked.ok) return null
      const err = (await revoked.json().catch(() => ({}))) as { error?: string }
      return `stand-in agent ${body.agent_id} was NOT revoked (${revoked.status}): ${err.error ?? ''}`
    },
  }
}

/** The default USDC balance read, against the observer node. */
async function defaultUsdcBalance(address: string): Promise<bigint> {
  const { observerProvider, ERC20_BALANCE_ABI } = await import('../lib/chain.js')
  const usdc = new ethers.Contract(SEPOLIA_USDC, [...ERC20_BALANCE_ABI], observerProvider() as never)
  return (await usdc.balanceOf(address)) as bigint
}
