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
export interface ConnectErrorDetails {
  /**
   * The `--runtime` values a retry may use, when the refusal is about runtime
   * selection (#2091). The values lived only in `message` prose, which the
   * `--json` contract discards entirely — while the backend's setup prompt
   * instructs an agent to retry only with "one of the values that refusal
   * lists". Carrying them structurally is what makes that retry reachable
   * from automation.
   */
  allowedRuntimes?: readonly string[]
}

export class ConnectError extends Error {
  readonly code: string
  readonly nextAction: string
  readonly details: ConnectErrorDetails

  constructor(code: string, message: string, nextAction: string, details: ConnectErrorDetails = {}) {
    super(message)
    this.name = 'ConnectError'
    this.code = code
    this.nextAction = nextAction
    this.details = details
  }
}

export function isConnectError(err: unknown): err is ConnectError {
  return err instanceof ConnectError
}
