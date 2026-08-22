import { MCP_VERSION, registeredToolNames } from '@haven_ai/mcp'
import { toolSchemas as signerToolSchemas } from '@haven_ai/signer'
import { HAVEN_MINIMUM_NODE_VERSION } from '@haven_ai/sdk'

// The required-tools list is derived from `@haven_ai/mcp`'s canonical
// `registeredToolNames()` rather than maintained as a literal here. An earlier
// hand-maintained list drifted out of sync with the MCP package (it advertised
// tools the local MCP no longer exposed, and missed `haven_pay_x402` when it
// landed), which broke the consent screen and the post-setup probe. Sourcing
// from the MCP package directly is now the only way new tools can ship.
export const MCP_RUNTIME_MANIFEST = {
  mcpPackage: '@haven_ai/mcp',
  mcpVersion: MCP_VERSION,
  sdkPackage: '@haven_ai/sdk',
  sdkVersion: '0.1.29-alpha.0',
  signerPackage: '@haven_ai/signer',
  signerVersion: '0.1.29-alpha.0',
  // Sourced from the SDK, never a literal (#1161). This field read '20.0.0'
  // while every package's `engines` said `>=24` and the docs said `>=24.0.0`,
  // so the guard that was supposed to enforce the floor waved Node v23 through
  // — including on the `--local` path where it does run. A hand-maintained
  // second copy of a number is a drift waiting to happen; a guard test pins
  // this against `package.json`'s `engines.node`.
  minimumNodeVersion: HAVEN_MINIMUM_NODE_VERSION,
  supportedClients: ['codex-cli', 'codex-desktop', 'claude-code'] as const,
  requiredTools: registeredToolNames() as readonly string[],
  /**
   * The signer MCP's tool surface, DERIVED from the pinned @haven_ai/signer
   * package (#1587) — same anti-drift rule as `requiredTools` above: a
   * literal list here would rot the first time the signer gains a tool.
   * The handshake probe requires all of them.
   */
  requiredSignerTools: Object.keys(signerToolSchemas) as readonly string[],
} as const

export function mcpPackageSpec(): string {
  return `${MCP_RUNTIME_MANIFEST.mcpPackage}@${MCP_RUNTIME_MANIFEST.mcpVersion}`
}

export function sdkPackageSpec(): string {
  return `${MCP_RUNTIME_MANIFEST.sdkPackage}@${MCP_RUNTIME_MANIFEST.sdkVersion}`
}

export function signerPackageSpec(): string {
  return `${MCP_RUNTIME_MANIFEST.signerPackage}@${MCP_RUNTIME_MANIFEST.signerVersion}`
}
