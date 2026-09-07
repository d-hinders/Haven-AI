import type { Failure } from './errors.js'

/**
 * The `--json` contract (#2525).
 *
 * Under `--json`, **stdout carries exactly one JSON value and nothing else** —
 * every line of human prose goes to stderr instead. That is what lets an agent
 * pipe stdout straight into a parser without stripping progress chatter, and
 * it is why `note()` exists: the same call site prints a sentence for a human
 * and stays silent (on stdout) for a machine.
 *
 * Success keeps the payload shape each command already emitted — including the
 * bare arrays that `agents list` and friends return — so this change adds a
 * failure contract without breaking a script that already parses a success.
 * Failures are always the object `{ ok: false, error: { code, message, hint? } }`.
 */
export interface Output {
  readonly json: boolean
  /** The command's success payload. At most one per run, on stdout. */
  data(payload: unknown, human: () => string): void
  /** Raw text (an export file). Printed as-is; wrapped under `--json`. */
  text(content: string, meta: Record<string, unknown>): void
  /** Human prose. Stdout in prose mode; stderr under `--json`. */
  note(line: string): void
  /** The one failure object. Always stdout under `--json`, stderr otherwise. */
  failure(failure: Failure): void
}

export function createOutput(
  json: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
): Output {
  return {
    json,
    data(payload, human) {
      out(json ? JSON.stringify(payload, null, 2) : human())
    },
    text(content, meta) {
      // A CSV/SIE body is the payload in prose mode. Under --json it becomes a
      // field of the single object, so the contract ("one JSON value on
      // stdout") holds for exports too and the content stays recoverable.
      out(json ? JSON.stringify({ ok: true, ...meta, content }, null, 2) : content)
    },
    note(line) {
      if (json) err(line)
      else out(line)
    },
    failure(failure) {
      const body = {
        ok: false as const,
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.hint ? { hint: failure.hint } : {}),
        },
      }
      if (json) out(JSON.stringify(body, null, 2))
      else err(failure.hint ? `${failure.message}\n${failure.hint}` : failure.message)
    },
  }
}
