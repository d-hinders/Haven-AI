/**
 * The connector's machine-readable failure vocabulary (#1719).
 *
 * Before this, a refusal was a bare `throw new Error(...)` and the automation
 * contract recovered a code by regex-matching the message in
 * `failedConnectOutcome`. That works only for as long as nobody rewords a
 * sentence, and it gives the caller nothing to branch on that the wording did
 * not accidentally provide. Every refusal this module fronts carries:
 *
 * - `code` — stable, snake_case, safe to switch on;
 * - `nextAction` — the one thing to do next, in the same snake_case shape the
 *   install-status contract already uses for `next_action`;
 * - `message` — human/agent prose, still the thing printed to a terminal.
 *
 * Codes are additive and never renamed: a consumer pinned to an older
 * connector must keep recognising the ones it already knows.
 */
export class ConnectError extends Error {
  readonly code: string
  readonly nextAction: string

  constructor(code: string, message: string, nextAction: string) {
    super(message)
    this.name = 'ConnectError'
    this.code = code
    this.nextAction = nextAction
  }
}

export function isConnectError(err: unknown): err is ConnectError {
  return err instanceof ConnectError
}
