/**
 * Process-level custody guard for the hosted (keyless) MCP server.
 *
 * The runtime is already keyless in code — `createHostedHavenClient` throws
 * if a delegate key is ever attached. This guard catches the same mistake one
 * layer earlier, at the process boundary: a misconfigured deploy that
 * accidentally injects `HAVEN_DELEGATE_KEY` into the hosted environment fails
 * to boot rather than starting and silently violating the non-custodial
 * posture (see docs/architecture/06-hosted-mcp-connect-flow.md).
 */

export class CustodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyError'
  }
}

/**
 * Refuse to start the hosted server if any delegate-key material is present
 * in the environment. The hosted server must never hold one — signing happens
 * at the edge (#184).
 */
export function assertHostedEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (typeof env.HAVEN_DELEGATE_KEY === 'string' && env.HAVEN_DELEGATE_KEY.trim().length > 0) {
    throw new CustodyError(
      'HAVEN_DELEGATE_KEY is set in the environment of the hosted (keyless) MCP server. ' +
        'The hosted server must never hold a delegate key — that authority lives at the edge. ' +
        'Remove HAVEN_DELEGATE_KEY from this deployment before starting.',
    )
  }
}
