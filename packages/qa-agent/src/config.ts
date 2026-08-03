/**
 * Shared configuration for the Haven QA harness (epic #573).
 *
 * Reads the `QA_*` environment the dev-stack verification checklist (#574)
 * provisions. Every value is **testnet/dev-only** — never a production
 * credential, mainnet RPC, or real funds. See `docs/operations/agent-qa.md`.
 *
 * Both the dev seed step (#574) and the deterministic money-flow harness (#575)
 * load their config from here so the env contract has a single source of truth.
 */

export interface QaConfig {
  /**
   * Shared dev backend base URL. QA runs hit this **directly, server-to-server**
   * (Node → API) — not through the Vercel `/api` proxy, and not subject to CORS.
   * e.g. `https://havenbackend-dev-8b95.up.railway.app`.
   */
  apiUrl: string
  /** QA agent API key (identity, not spend authority): `sk_agent_*`. */
  agentApiKey: string
  /**
   * QA delegate EOA private key. Signs payments locally on Base Sepolia; held
   * only by the QA runtime. A throwaway, capped, testnet-only key.
   */
  delegateKey: string
  /** Recipient address for direct-send scenarios. */
  paymentTo: string
  /**
   * Deployed dev demo-merchant base URL (x402 settlement target for #575).
   * Optional until the demo-merchant is confirmed deployed on dev (#574
   * verification checklist) and its URL recorded.
   */
  demoMerchantUrl?: string
  /**
   * A DELEGATION-RAIL agent's API key, for the EIP-3009 bridge scenario (#946).
   *
   * Separate from `agentApiKey` because the rail is a property of the ACCOUNT,
   * not the request: the seeded QA agent is a legacy AllowanceModule agent, and
   * no header can make it exercise the delegation rail. The 3009 bridge is the
   * delegation rail's path to EIP-3009-only merchants, so proving it needs a
   * second, delegation-rail identity.
   *
   * That agent needs an **open (unpinned) budget delegation** — a
   * recipient-pinned budget cannot fund the delegate EOA, and per the owner
   * decision (2026-07-15) we do not weaken a pin for interop, so pinned agents
   * are erc7710-only by design. Optional: absent, the scenario SKIPS.
   */
  delegationAgentApiKey?: string
  /**
   * The delegation-rail agent's delegate EOA private key. Signs both legs
   * client-side (the funding UserOp and the EIP-3009 header) — Haven signs
   * neither. Testnet-only throwaway, same discipline as `delegateKey`.
   */
  delegationDelegateKey?: string
}

/** Thrown when a required `QA_*` env var is missing, with a pointer to the doc. */
export class QaConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing required QA env: ${missing.join(', ')}. ` +
        `Set the QA_* vars (see docs/operations/agent-qa.md) — testnet/dev-only.`,
    )
    this.name = 'QaConfigError'
  }
}

/**
 * Load and validate the QA config from an environment object (defaults to
 * `process.env`). Throws {@link QaConfigError} listing every missing required
 * var, so a misconfigured run fails fast with a clear message rather than
 * hitting the backend with empty credentials.
 */
export function loadQaConfig(env: NodeJS.ProcessEnv = process.env): QaConfig {
  const required = {
    apiUrl: 'QA_HAVEN_API_URL',
    agentApiKey: 'QA_AGENT_API_KEY',
    delegateKey: 'QA_DELEGATE_PRIVATE_KEY',
    paymentTo: 'QA_PAYMENT_TO',
  } as const

  const missing: string[] = []
  const read = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) missing.push(name)
    return value ?? ''
  }

  const config: QaConfig = {
    apiUrl: read(required.apiUrl).replace(/\/+$/, ''),
    agentApiKey: read(required.agentApiKey),
    delegateKey: read(required.delegateKey),
    paymentTo: read(required.paymentTo),
    demoMerchantUrl: env.QA_DEMO_MERCHANT_URL?.trim()?.replace(/\/+$/, '') || undefined,
    delegationAgentApiKey: env.QA_DELEGATION_AGENT_API_KEY?.trim() || undefined,
    delegationDelegateKey: env.QA_DELEGATION_DELEGATE_PRIVATE_KEY?.trim() || undefined,
  }

  if (missing.length > 0) throw new QaConfigError(missing)
  return config
}
