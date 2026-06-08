import { MCP_VERSION, registeredToolNames } from '@haven_ai/mcp'

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
  sdkVersion: '0.1.7',
  signerPackage: '@haven_ai/signer',
  signerVersion: '0.1.0-alpha',
  minimumNodeVersion: '20.0.0',
  supportedClients: ['codex-cli', 'codex-desktop', 'claude-code'] as const,
  requiredTools: registeredToolNames() as readonly string[],
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
