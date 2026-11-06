/**
 * The hand-off loop for the full-onboarding spike (#4682).
 *
 * `claude-code.ts` runs ONE prompt per task and records no `session_id`, so a
 * run that stops at a human hand-off cannot continue. This module is the loop
 * the spike exists to prove: run a turn, detect the hand-off the agent asked
 * for, let the stand-in perform it, then RESUME the same session with a
 * message that says what the human did.
 *
 * ## The boundary
 *
 * The resume message is written by this module, never by the stand-in, and it
 * carries no value the stand-in holds. `assertNoStandInValues` is a runtime
 * guard, not only a test: if a resume message ever contained one of the
 * stand-in's inventory values, the loop refuses to send it. The leak test
 * exercises the same guard against the prompt, the child environment, the tool
 * stream and the final result.
 *
 * ## The tool profile changes partway through
 *
 * `agents connect` is refused by the cold profile's allowlist until the human
 * has approved the device login. The loop therefore passes a per-turn
 * `trialEnv` to `runTurn` and adds `QA_EVAL_COMMAND_ALLOW_CONNECT=1` to it only
 * AFTER a device-login hand-off has been performed — the flag is set by the
 * loop, never by the caller, and never before the wall.
 *
 * ## What counts as a hand-off
 *
 * The agent hands over a URL or a code, in its final text or in a tool result
 * (the CLI prints the device link). Two shapes exist today:
 *
 *   - a device login: `/device?code=<USER_CODE>` (or "approve the code X");
 *   - a budget approval: `/agents?setup=<SETUP_ID>`.
 *
 * Anything else is not a hand-off, and the loop stops rather than guessing.
 */

import type { AgentRunLog } from './types.js'
import { CONNECT_ALLOW_ENV } from './command-tool.js'

export type HandoffKind = 'device-login' | 'budget-approval'

export interface Handoff {
  kind: HandoffKind
  /** The user code the human approves (device login). */
  userCode?: string
  /** The setup id the human approves the budget for. */
  setupId?: string
  /** The URL the agent handed over, when it printed one. */
  url?: string
}

/** A user code is the backend's shape: uppercase alphanumerics, dash-separated. */
const USER_CODE = /[A-Z0-9]{4,}(?:-[A-Z0-9]{2,})+/g
const DEVICE_URL = /\/device\?code=([A-Za-z0-9_-]+)/
const APPROVE_CODE = /approve (?:the )?code\s+([A-Z0-9][A-Z0-9-]{3,})/i
const SETUP_URL = /\/agents\?setup=([0-9a-fA-F-]{36})/
const SETUP_ID = /setup[ _-]?id[:\s]+([0-9a-fA-F-]{36})/i

/**
 * Detect the hand-off an agent asked for, from one turn's text. Returns null
 * when the text names none — the loop then stops instead of inventing a step.
 */
export function detectHandoff(text: string): Handoff | null {
  if (!text) return null
  const deviceUrl = DEVICE_URL.exec(text)
  if (deviceUrl?.[1]) {
    return { kind: 'device-login', userCode: deviceUrl[1], url: deviceUrl[0] }
  }
  const approve = APPROVE_CODE.exec(text)
  if (approve?.[1]) {
    return { kind: 'device-login', userCode: approve[1] }
  }
  const setupUrl = SETUP_URL.exec(text)
  if (setupUrl?.[1]) {
    return { kind: 'budget-approval', setupId: setupUrl[1], url: setupUrl[0] }
  }
  const setupId = SETUP_ID.exec(text)
  if (setupId?.[1]) {
    return { kind: 'budget-approval', setupId: setupId[1] }
  }
  // A bare user code is only a hand-off when the text also says "device" or
  // "approve" — otherwise every transaction hash would look like one.
  if (/\bdevice\b/i.test(text) && /\bapprove\b/i.test(text)) {
    const codes = text.match(USER_CODE)
    if (codes && codes.length > 0) {
      return { kind: 'device-login', userCode: codes[0] }
    }
  }
  return null
}

/**
 * The text one turn produced: its final message, plus the RAW stream when the
 * adapter kept it.
 *
 * The normalized log drops tool-result text on purpose (it is the grader
 * model, not a transcript), but the hand-off the agent asks for is often
 * printed by a TOOL — `haven login` prints the device link. So the loop scans
 * the raw stream when it has one, and falls back to the final message.
 */
export function turnText(log: AgentRunLog, raw?: string): string {
  const parts: string[] = []
  if (log.finalMessage) parts.push(log.finalMessage)
  if (raw) parts.push(raw)
  return parts.join('\n')
}

/**
 * Refuse a message that carries a stand-in value. Fail-closed: the loop would
 * rather stop than hand the agent a secret.
 */
export function assertNoStandInValues(message: string, inventory: Array<{ name: string; value: string }>): void {
  for (const entry of inventory) {
    if (entry.value.length > 0 && message.includes(entry.value)) {
      throw new Error(`the resume message carries the stand-in value ${entry.name} — refusing to send it`)
    }
  }
}

/** What one turn did, for the run's evidence. */
export interface HandoffTurn {
  turn: number
  resumed: boolean
  sessionId?: string
  handoff?: Handoff
  /** What the stand-in did, in one line. Never a secret value. */
  performed?: string
  finalMessage?: string
}

export interface HandoffLoopOptions {
  /**
   * Run one turn; `resumeSessionId` continues the same session, and
   * `trialEnv` is the per-turn env the adapter merges over its allowlist.
   */
  runTurn: (
    instruction: string,
    opts: { resumeSessionId?: string; trialEnv?: Record<string, string> },
  ) => Promise<{ log: AgentRunLog; session: { sessionId?: string }; raw?: string }>
  instruction: string
  /**
   * The trial's own env, passed on EVERY turn. The loop adds
   * `QA_EVAL_COMMAND_ALLOW_CONNECT=1` to it after the device hand-off, which
   * is what enables `agents connect` on the post-login turns (#4682).
   */
  trialEnv?: Record<string, string>
  /** The stand-in's two actions. */
  standIn: {
    approveDeviceLogin(userCode: string): Promise<{ status: string }>
    approveBudget(): Promise<{ delegationHash: string; budgetAtomic: string; periodSeconds: number }>
  }
  /** The stand-in's inventory, for the fail-closed guard. */
  inventory: Array<{ name: string; value: string }>
  /** How many hand-offs one run may perform. Default 4. */
  maxHandoffs?: number
  /** The message the agent receives after a hand-off. Defaults to a fixed, secret-free line. */
  resumeMessage?: (handoff: Handoff) => string
}

export interface HandoffLoopResult {
  turns: HandoffTurn[]
  handoffs: Handoff[]
  finalMessage?: string
  /** Set when the loop stopped without a hand-off to perform. */
  stoppedBecause?: string
}

const DEFAULT_RESUME_MESSAGE = (handoff: Handoff): string =>
  handoff.kind === 'device-login'
    ? 'The human approved the device login. Continue with the setup.'
    : 'The human approved the agent budget. Continue with the setup.'

/**
 * Run the agent turn by turn, performing each hand-off the stand-in owns.
 *
 * The loop stops when a turn asks for no hand-off (the agent is done, or it is
 * stuck), when the hand-off budget is exhausted, or when a hand-off repeats —
 * a repeated request means the step did not take, and retrying it silently
 * would hide that.
 */
export async function runWithHandoffs(options: HandoffLoopOptions): Promise<HandoffLoopResult> {
  const maxHandoffs = options.maxHandoffs ?? 4
  const resumeMessage = options.resumeMessage ?? DEFAULT_RESUME_MESSAGE
  const turns: HandoffTurn[] = []
  const handoffs: Handoff[] = []
  const performed = new Set<HandoffKind>()
  let sessionId: string | undefined
  let instruction = options.instruction
  // The per-turn env. `agents connect` stays refused until the device hand-off
  // has actually been performed, so the tool profile changes partway through
  // the run rather than being enabled from the start (#4682).
  let trialEnv: Record<string, string> = { ...options.trialEnv }
  let stoppedBecause: string | undefined

  for (let turn = 1; ; turn += 1) {
    const { log, session, raw } = await options.runTurn(instruction, {
      ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
      ...(Object.keys(trialEnv).length > 0 ? { trialEnv } : {}),
    })
    if (session.sessionId) sessionId = session.sessionId
    const record: HandoffTurn = {
      turn,
      resumed: turn > 1,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(log.finalMessage !== undefined ? { finalMessage: log.finalMessage } : {}),
    }
    turns.push(record)

    const handoff = detectHandoff(turnText(log, raw))
    if (!handoff) {
      stoppedBecause = 'the turn asked for no hand-off'
      break
    }
    record.handoff = handoff
    if (performed.has(handoff.kind)) {
      stoppedBecause = `the agent asked for a ${handoff.kind} hand-off twice — the first one did not take`
      break
    }
    if (handoffs.length >= maxHandoffs) {
      stoppedBecause = `the hand-off budget (${maxHandoffs}) is exhausted`
      break
    }

    if (handoff.kind === 'device-login') {
      if (!handoff.userCode) {
        stoppedBecause = 'the device-login hand-off carried no user code'
        break
      }
      const result = await options.standIn.approveDeviceLogin(handoff.userCode)
      record.performed = `approved the device login (${result.status})`
      // The login wall is behind us: the NEXT turn may run `agents connect`.
      trialEnv = { ...trialEnv, [CONNECT_ALLOW_ENV]: '1' }
    } else {
      const grant = await options.standIn.approveBudget()
      record.performed =
        `approved the budget: ${grant.budgetAtomic} atomic USDC per ${grant.periodSeconds}s ` +
        `(delegation ${grant.delegationHash})`
    }
    performed.add(handoff.kind)
    handoffs.push(handoff)

    const message = resumeMessage(handoff)
    assertNoStandInValues(message, options.inventory)
    instruction = message
  }

  const last = turns[turns.length - 1]
  return {
    turns,
    handoffs,
    ...(last?.finalMessage !== undefined ? { finalMessage: last.finalMessage } : {}),
    ...(stoppedBecause !== undefined ? { stoppedBecause } : {}),
  }
}
