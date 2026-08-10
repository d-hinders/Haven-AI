import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defaultSigningAuditPath } from './audit.js'
import { signerCapabilityAdvertisement, signerInstructions } from './capabilities.js'
import {
  ensureSignerConsent,
  registeredSignerToolNames,
  type SignerConsentDecision,
} from './consent.js'
import { isSupportedNodeVersion, unsupportedNodeVersionMessage } from '@haven_ai/sdk'
import { createEdgeSigner, type EdgeSigner } from './core.js'
import { loadSignerCredentials, type SignerCredentials } from './credentials.js'
import {
  createToolHandlers,
  toolDescriptions,
  toolSchemas,
  type SignerToolName,
  type ToolPayload,
} from './tools.js'
import { loadHavenIdentity } from './sign-context.js'

export const SIGNER_NAME = '@haven_ai/signer'
export const SIGNER_VERSION = '0.1.21-alpha.0'

export interface SignerOptions {
  /** Path to a Haven credential JSON file (delegate_key is read from it). */
  credentialsPath?: string
  /** Pre-resolved delegate key (skips credential loading). */
  delegateKey?: string
  /** Append local signing audit entries here. Defaults to a credential sidecar or ~/.haven. */
  auditPath?: string
  /** Overridable so the Node-floor refusal is testable without spawning a Node. */
  nodeVersion?: string
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
  // The choke point, deliberately (#1161 review). Every public way to obtain a
  // key-bound EdgeSigner from this package funnels through here —
  // `runSignerStdioServer`, `resolveEdgeSigner`, and any embedder calling it
  // directly (the `skipConsent` docs invite controlled embedding, so that is a
  // supported surface, not just a test seam). Asserting only in the stdio
  // entrypoint would have reproduced the exact bug this issue fixes: a guard
  // that exists but sits on one path while another reaches the delegate key
  // unchecked.
  //
  // First statement, before the `delegateKey` fast path and before credentials
  // are read, so an unsupported runtime never touches a key by either route.
  assertSupportedNodeVersion(options.nodeVersion)

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
 * edge signer that holds the delegate key. It exposes no construct/relay
 * tools — it only signs. Its ONE network capability (#1263) is an
 * authenticated READ: fetching a payment's exact signing context from Haven
 * by payment_id, so agents never have to relay multi-KB signing payloads
 * through a model context. The signer CORE below it stays network-free, and
 * fetched bytes pass the same verification as tool-argument bytes.
 */
export function buildSignerMcpServer(
  signer: EdgeSigner,
  options: Pick<SignerOptions, 'auditPath'> & { credentials?: SignerCredentials } = {},
): McpServer {
  // #1155: the handshake states what this signer can verify, so an agent can
  // detect expected-context skew before it quotes rather than after it signs.
  // `SIGNER_VERSION` is a *package* version and nothing derives capability from
  // it — both fields below are derived from the constants the signing path
  // enforces. Advisory only: no refusal is added here, the #1143 signing-time
  // guard remains the enforcement point.
  const server = new McpServer(
    { name: SIGNER_NAME, version: SIGNER_VERSION },
    {
      capabilities: signerCapabilityAdvertisement(),
      instructions: signerInstructions(),
    },
  )

  const credentialsPath = options.credentials?.sourcePath
  const handlers = createToolHandlers(signer, {
    audit: {
      auditPath: options.auditPath ?? defaultSigningAuditPath(credentialsPath),
      delegateAddress: signer.delegateAddress,
      safeAddress: options.credentials?.safeAddress,
      chainId: options.credentials?.chainId,
    },
    // #1263: the payment_id signing path — the ONLY network call this server
    // can make, an authenticated read of a signing context from Haven, using
    // the agent identity the connector stores next to the signer credential.
    // The signer CORE stays network-free; fetched bytes still pass the same
    // binding verification + digest re-derivation as tool-argument bytes.
    signContext: {
      loadIdentity: () => loadHavenIdentity(credentialsPath),
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

/**
 * Refuse to start on an unsupported Node (#1161).
 *
 * Asserted at STARTUP, not only at install, because the two can diverge: a user
 * upgrades Node, connects successfully, then downgrades — or a version manager
 * hands the agent runtime a different Node than the shell that ran setup. Only a
 * startup check sees the version this process is actually running on.
 *
 * This is the signer, so refusing is the conservative answer rather than the
 * aggressive one. It holds the delegate key and produces every payment
 * signature; on an unsupported runtime the plausible failure is a wrong or
 * absent signature, which is worse than not starting. The consent gate below
 * takes the same posture for the same reason.
 */
export function assertSupportedNodeVersion(nodeVersion: string = process.versions.node): void {
  if (isSupportedNodeVersion(nodeVersion)) return
  const err: NodeJS.ErrnoException = new Error(
    unsupportedNodeVersionMessage({ subject: 'The Haven signer', nodeVersion }),
  )
  err.code = 'HAVEN_SIGNER_UNSUPPORTED_NODE'
  throw err
}

export async function runSignerStdioServer(options: SignerOptions = {}): Promise<void> {
  // The Node floor is asserted inside resolveSignerRuntime — the choke point
  // every key-bound path shares — so it is enforced here too, before
  // credentials are read, without a second call site to keep in sync.
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
