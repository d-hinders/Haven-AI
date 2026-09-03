import { connectorRerunCommand, resolveConnectorChannel } from '@haven_ai/sdk'

/**
 * The connector dist-tag THIS DEPLOYMENT names in its re-run hints (#2423).
 *
 * The hosted MCP server is deployed per environment rather than published to
 * npm, so unlike `@haven_ai/sdk`, `signer` and `connect` it has no release at
 * which a channel could be baked in. It reads `HAVEN_CONNECTOR_CHANNEL` — the
 * same variable slice 2 of the epic gives the backend's connector handout
 * (#2422, open, not merged) — and falls back to the SDK's build-time constant,
 * which keeps an unconfigured deployment on the production channel: today's
 * behaviour, exactly.
 *
 * Resolution happens once, at module load, so a malformed value refuses the
 * BOOT rather than serving a mixture of correct and incorrect hints. A silent
 * fall back to the default would be the worse failure: a typo would land on
 * the production channel while the deployment looked configured.
 *
 * **Not a statement about any deployment's current configuration.** Whether a
 * given environment sets `HAVEN_CONNECTOR_CHANNEL`, and to what, is an
 * operator action this code cannot see and this comment does not assert.
 */
export const HOSTED_CONNECTOR_CHANNEL = resolveConnectorChannel(
  process.env.HAVEN_CONNECTOR_CHANNEL,
)

/** `npx @haven_ai/connect@<this deployment's channel> [args]`. */
export function hostedConnectorRerunCommand(args?: string): string {
  return connectorRerunCommand(args, { channel: HOSTED_CONNECTOR_CHANNEL })
}
