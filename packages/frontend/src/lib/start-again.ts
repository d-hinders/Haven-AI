/**
 * "Start again" for an unfinished connect (#4710).
 *
 * Closing the connect dialog before the agent registers used to leave no way
 * back in the app. The dashboard's "still connecting" row offers two actions:
 * Open (the existing `/agents?setup=<id>` resume link) and Start again, which
 * cancels the old setup and reopens the flow with its name, budget and wallet
 * prefilled, producing a NEW prompt.
 *
 * ── The order is the safety property ──────────────────────────────────────
 *
 * The setup's status is read FIRST, and the replacement is only offered after
 * the cancel succeeds. Two cases must not create anything:
 *
 * - the setup has moved on (no longer `awaiting_connection`) — the agent may
 *   already have registered, and cancelling would revoke a pending agent that
 *   is about to be approved. Open it through the resume link instead;
 * - the cancel answers 409 — the same race, caught under the row lock. Open
 *   the setup through the resume link instead.
 *
 * This module owns that decision as a pure-ish function over two injected
 * calls, so each order is testable without a browser or a live backend.
 */

import type { ApiSchema } from '@haven_ai/core'
import { ApiRequestError } from './api'
import { defaultTokenUnitDecimals, formatAllowanceAmount } from './allowance-format'

export type SetupStatusResponse = ApiSchema<'AgentConnectionSetupStatus'>

/** What the connect flow needs to reopen on step 1 with the old inputs. */
export interface StartAgainPrefill {
  name: string
  description: string | null
  /** The Haven wallet the setup was created against. */
  accountId: string
  /** Human-decimal budget amount for the policy step's input ('' when none). */
  amount: string
  resetPeriodMin: number
}

export type StartAgainOutcome =
  /** Do not create anything: open this setup through the resume link. */
  | { kind: 'resume'; setupId: string }
  /** The old setup is cancelled; reopen the flow prefilled. */
  | { kind: 'prefilled'; prefill: StartAgainPrefill }

export interface StartAgainDeps {
  readSetup: (setupId: string) => Promise<SetupStatusResponse>
  cancelSetup: (setupId: string) => Promise<void>
}

/** A 409 from the cancel route means the setup moved on under us. */
function isConflict(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 409
}

/**
 * The budget the setup asked for, as the policy step's input expects it.
 *
 * `agent_budget[].allowance_amount` is an ATOMIC bigint string (#2295); the
 * input takes a human decimal. The connect flow only ever creates a USDC
 * budget, and `defaultTokenUnitDecimals` knows USDC's six decimals; an
 * unknown symbol falls back to six rather than guessing a scale from the
 * digits.
 */
function prefillAmount(status: SetupStatusResponse): string {
  const budget = status.agent_budget?.[0]
  if (!budget) return ''
  const decimals = defaultTokenUnitDecimals(budget.token_symbol) ?? 6
  return formatAllowanceAmount(budget.allowance_amount, decimals, {
    symbol: budget.token_symbol,
    minimumFractionDigits: 0,
  })
}

export function prefillFromStatus(status: SetupStatusResponse): StartAgainPrefill {
  return {
    name: status.agent.name,
    description: status.agent.description ?? null,
    accountId: status.haven_wallet.id,
    amount: prefillAmount(status),
    resetPeriodMin: status.agent_budget?.[0]?.reset_period_min ?? 1440,
  }
}

/**
 * Read the setup, cancel it only while it is still awaiting a connector, and
 * hand back either the prefill for a new setup or the resume link to open.
 *
 * A read failure propagates: the caller shows it and creates nothing.
 */
export async function startAgainSetup(
  setupId: string,
  deps: StartAgainDeps,
): Promise<StartAgainOutcome> {
  const status = await deps.readSetup(setupId)
  if (status.status !== 'awaiting_connection') {
    return { kind: 'resume', setupId }
  }
  try {
    await deps.cancelSetup(setupId)
  } catch (err) {
    if (isConflict(err)) return { kind: 'resume', setupId }
    throw err
  }
  return { kind: 'prefilled', prefill: prefillFromStatus(status) }
}
