import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defaultSigningAuditPath } from './audit.js'
import {
  ensureSignerConsent,
  registeredSignerToolNames,
  type SignerConsentDecision,
} from './consent.js'
import { createEdgeSigner, type EdgeSigner } from './core.js'
import { loadSignerCredentials, type SignerCredentials } from './credentials.js'
import {
  createToolHandlers,
  toolDescriptions,
  toolSchemas,
  type SignerToolName,
  type ToolPayload,
} from './tools.js'

export const SIGNER_NAME = '@haven_ai/signer'
export const SIGNER_VERSION = '0.1.17-alpha.0'

export interface SignerOptions {
  /** Path to a Haven credential JSON file (delegate_key is read from it). */
  credentialsPath?: string
  /** Pre-resolved delegate key (skips credential loading). */
  delegateKey?: string
  /** Append local signing audit entries here. Defaults to a credential sidecar or ~/.haven. */
  auditPath?: string
  /**
   * When true, write the consent sidecar file (`<credentials>.signer-ack.json`)
   * with the current consent hash and proceed. Surfaced via the `--ack` CLI flag.
   */
  writeAck?: boolean
  /**
   * When true, skip the consent gate entirely. Reserved for tests and controlled
   * embedding — production CLIs should not set this.
   */
  skipConsent?: boolean
  /** Override consent environment lookup. Reserved for tests and controlled embedding. */
  consentEnv?: Record<string, string | undefined>
  /** Override the stream the consent block is printed to. Reserved for tests. */
  consentOut?: { write: (chunk: string) => unknown }
  /** Trusted Haven signer address for x402 expected-context bindings. */
  x402BindingSigner?: string
}

export async function resolveEdgeSigner(options: SignerOptions = {}): Promise<EdgeSigner> {
  const { signer } = await resolveSignerRuntime(options)
  return signer
}

export interface ResolvedSignerRuntime {
  signer: EdgeSigner
  credentials?: SignerCredentials
}

export async function resolveSignerRuntime(
  options: SignerOptions = {},
): Promise<ResolvedSignerRuntime> {
  if (options.delegateKey) {
    return {
      signer: createEdgeSigner(options.delegateKey, {
        x402BindingSigner: options.x402BindingSigner ?? process.env.HAVEN_X402_BINDING_SIGNER,
      }),
    }
  }
  const creds = await loadSignerCredentials(options.credentialsPath)
  return {
    signer: createEdgeSigner(creds.delegateKey, {
      x402BindingSigner:
        options.x402BindingSigner ?? creds.x402BindingSigner ?? process.env.HAVEN_X402_BINDING_SIGNER,
    }),
    credentials: creds,
  }
}

/**
 * Build a local stdio MCP server exposing the sign-only tools, bound to an
 * edge signer that holds the delegate key. This server performs no network
 * I/O and exposes no construct/relay tools — it only signs.
 */
export function buildSignerMcpServer(
  signer: EdgeSigner,
  options: Pick<SignerOptions, 'auditPath'> & { credentials?: SignerCredentials } = {},
): McpServer {
  const server = new McpServer({ name: SIGNER_NAME, version: SIGNER_VERSION })

  const credentialsPath = options.credentials?.sourcePath
  const handlers = createToolHandlers(signer, {
    audit: {
      auditPath: options.auditPath ?? defaultSigningAuditPath(credentialsPath),
      delegateAddress: signer.delegateAddress,
      safeAddress: options.credentials?.safeAddress,
      chainId: options.credentials?.chainId,
    },
  })
  const registerTool = (server as unknown as {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: (args: unknown) => Promise<unknown>,
    ) => void
  }).tool.bind(server)

  for (const name of Object.keys(toolSchemas) as SignerToolName[]) {
    registerTool(name, toolDescriptions[name], toolSchemas[name], async (args: unknown) =>
      toMcpResult(await handlers[name](args)),
    )
  }

  return server
}

export async function runSignerStdioServer(options: SignerOptions = {}): Promise<void> {
  const { signer, credentials } = await resolveSignerRuntime(options)

  if (!options.skipConsent) {
    const decision = await runSignerConsentGate(signer, credentials, options)
    if (!decision.ok) {
      const err: NodeJS.ErrnoException = new Error(
        decision.reason === 'env_var_mismatch'
          ? 'Haven edge signer consent acknowledgement does not match the current configuration.'
          : 'Haven edge signer requires a one-time consent acknowledgement before starting.',
      )
      err.code = 'HAVEN_SIGNER_NO_CONSENT'
      throw err
    }
  }

  const server = buildSignerMcpServer(signer, { credentials, auditPath: options.auditPath })
  await server.connect(new StdioServerTransport())
}

export async function runSignerConsentGate(
  signer: EdgeSigner,
  credentials: SignerCredentials | undefined,
  options: SignerOptions,
): Promise<SignerConsentDecision> {
  return ensureSignerConsent(
    {
      delegateAddress: signer.delegateAddress,
      safeAddress: credentials?.safeAddress,
      agentId: credentials?.agentId,
      chainId: credentials?.chainId,
      network: credentials?.network,
      toolNames: registeredSignerToolNames(),
    },
    {
      credentialsPath: options.credentialsPath ?? credentials?.sourcePath,
      writeAck: options.writeAck,
      env: options.consentEnv,
      out: options.consentOut,
    },
  )
}

function toMcpResult(payload: ToolPayload) {
  return {
    isError: !payload.success,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  }
}
