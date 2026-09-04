import { CliApiError } from './api.js'

/**
 * Exit codes (#2525). Documented in README.md § For agents and scripts, and
 * asserted in `exit-codes.test.ts` — an agent branches on these, so they are a
 * contract rather than an implementation detail.
 */
export const EXIT = {
  ok: 0,
  /** Something failed and none of the specific codes below describe it. */
  failed: 1,
  /** The command line was wrong: unknown command, missing argument, bad flag. */
  usage: 2,
  /** No stored session, or the backend rejected the one we have. Log in again. */
  notAuthenticated: 3,
  /** Authenticated, and the backend refused anyway (403, 410, other 4xx). */
  refused: 4,
  /** The backend could not be reached at all. */
  network: 5,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** Machine-readable `error.code` values, one per exit code above 0. */
export type FailureCode = 'failed' | 'usage' | 'not_authenticated' | 'refused' | 'network'

/** A wrong command line. Carries `usage` so callers do not guess the exit code. */
export class UsageError extends Error {
  readonly hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'UsageError'
    this.hint = hint
  }
}

export interface Failure {
  code: FailureCode
  exit: ExitCode
  message: string
  hint?: string
}

/**
 * One place that decides what an error means, so the JSON body and the exit
 * code cannot disagree — they are read off the same object.
 *
 * **On 401 → `not_authenticated`, not `refused`.** The issue lists 401
 * alongside 403/410 under "refused by the backend", and separately lists
 * "not logged in / session expired" — the two overlap, and a 401 is exactly
 * the second one. An agent seeing `not_authenticated` knows to re-run
 * `haven login`; `refused` tells it the opposite (the session is fine, the
 * action is not allowed). Splitting them on the wire is the whole point of
 * having two codes, so 401 resolves to the one it can act on.
 */
export function toFailure(err: unknown): Failure {
  if (err instanceof UsageError) {
    return { code: 'usage', exit: EXIT.usage, message: err.message, hint: err.hint }
  }
  if (err instanceof CliApiError) {
    if (err.status === 0) {
      return {
        code: 'network',
        exit: EXIT.network,
        message: err.message,
        hint: 'Check the network and `--api`, then retry.',
      }
    }
    if (err.status === 401) {
      return {
        code: 'not_authenticated',
        exit: EXIT.notAuthenticated,
        message: err.message,
        hint: 'Run `haven login` (or set HAVEN_EMAIL and HAVEN_PASSWORD).',
      }
    }
    if (err.status >= 400 && err.status < 500) {
      // 403 and 410 are the named cases; every other 4xx is the same shape of
      // answer — the backend understood and said no — so it gets the same code
      // rather than falling through to the generic one.
      return { code: 'refused', exit: EXIT.refused, message: err.message }
    }
    return { code: 'failed', exit: EXIT.failed, message: err.message }
  }
  return { code: 'failed', exit: EXIT.failed, message: err instanceof Error ? err.message : String(err) }
}
