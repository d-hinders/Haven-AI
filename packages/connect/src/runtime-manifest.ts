import { MCP_VERSION } from '@haven_ai/mcp'

export const MCP_RUNTIME_MANIFEST = {
  mcpPackage: '@haven_ai/mcp',
  mcpVersion: MCP_VERSION,
  sdkPackage: '@haven_ai/sdk',
  sdkVersion: '0.1.6',
  signerPackage: '@haven_ai/signer',
  signerVersion: '0.1.0-alpha',
  minimumNodeVersion: '20.0.0',
  supportedClients: ['codex-cli', 'codex-desktop', 'claude-code'] as const,
  requiredTools: [
    'haven_quote_x402',
    'haven_pay_x402_quote',
    'haven_resume_x402_payment',
    'haven_quote_mpp',
    'haven_pay_mpp_challenge',
    'haven_resume_mpp_payment',
    'haven_get_payment_status',
    'haven_get_resume_state',
    'haven_get_agent',
    'haven_get_allowances',
    'haven_list_receipts',
  ] as const,
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
