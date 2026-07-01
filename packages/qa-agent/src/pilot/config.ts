/**
 * Env config for the ERC-4337 pilot rig (#720, ADR #719 Stage 1).
 *
 * Testnet-only by construction: the chain is hard-wired to Base Sepolia and the
 * defaults point at public testnet infrastructure. The owner key must be a
 * throwaway — it owns nothing but the pilot Safe. The bundler URL doubles as a
 * credential (hosted bundlers embed the API key in the URL), so treat it as a
 * secret: keep it in an env file outside the repository, like the QA_* vars.
 */

export interface PilotRigConfig {
  /** Throwaway EOA that owns the pilot Safe. Never a production or QA-harness key. */
  ownerPrivateKey: `0x${string}`
  /** Bundler RPC URL (Pimlico-style: also serves paymaster sponsorship). Secret. */
  bundlerUrl: string
  /** Base Sepolia RPC for reads + account deployment simulation. */
  rpcUrl: string
  /** Safe7579 adapter — the module that gives the Safe its 4337 mailbox. */
  safe7579AdapterAddress: `0x${string}`
  /** Safe7579 launchpad used for counterfactual 7579 setup at deploy time. */
  erc7579LaunchpadAddress: `0x${string}`
  /** Module-registry attester the account trusts for module installs. */
  attesterAddress: `0x${string}`
  /** CREATE2 salt — bump to get a fresh counterfactual account. */
  saltNonce: bigint
}

// Canonical cross-chain deployments (deterministic vanity addresses). Verified
// against the live registry on the first operator run (#720's live half) — if
// that run fails at account creation, re-check these against the Rhinestone /
// Safe7579 docs before anything else.
const DEFAULT_SAFE7579_ADAPTER = '0x7579EE8307284F293B1927136486880611F20002'
const DEFAULT_ERC7579_LAUNCHPAD = '0x7579011aB74c46090561ea277Ba79D510c6C00ff'
const DEFAULT_RHINESTONE_ATTESTER = '0x000000333034E9f539ce08819E12c1b8Cb29084d'
const DEFAULT_BASE_SEPOLIA_RPC = 'https://sepolia.base.org'

const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/

function readAddress(env: NodeJS.ProcessEnv, name: string, fallback: string): `0x${string}` {
  const value = env[name] ?? fallback
  if (!HEX_ADDRESS.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 20-byte hex address, got "${value}"`)
  }
  return value as `0x${string}`
}

/**
 * Parse the PILOT_* environment. Throws a single aggregated error listing every
 * missing required variable (mirrors the QA harness's exit-2 UX) so an operator
 * fixes the env file once, not variable-by-variable.
 */
export function loadPilotRigConfig(env: NodeJS.ProcessEnv): PilotRigConfig {
  const missing: string[] = []
  const ownerPrivateKey = env.PILOT_OWNER_PRIVATE_KEY
  const bundlerUrl = env.PILOT_BUNDLER_URL
  if (!ownerPrivateKey) missing.push('PILOT_OWNER_PRIVATE_KEY (throwaway Base Sepolia key)')
  if (!bundlerUrl) missing.push('PILOT_BUNDLER_URL (bundler+paymaster RPC, e.g. Pimlico — secret)')
  if (missing.length > 0) {
    throw new Error(
      `Missing required pilot env:\n  - ${missing.join('\n  - ')}\n` +
        'See docs/research/erc4337-pilot-rig.md for the operator runbook.',
    )
  }
  if (!HEX_32_BYTES.test(ownerPrivateKey as string)) {
    throw new Error('PILOT_OWNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key')
  }

  let saltNonce = 0n
  if (env.PILOT_SALT_NONCE !== undefined) {
    try {
      saltNonce = BigInt(env.PILOT_SALT_NONCE)
    } catch {
      throw new Error(`PILOT_SALT_NONCE must be an integer, got "${env.PILOT_SALT_NONCE}"`)
    }
  }

  return {
    ownerPrivateKey: ownerPrivateKey as `0x${string}`,
    bundlerUrl: bundlerUrl as string,
    rpcUrl: env.PILOT_RPC_URL ?? DEFAULT_BASE_SEPOLIA_RPC,
    safe7579AdapterAddress: readAddress(env, 'PILOT_SAFE7579_ADAPTER', DEFAULT_SAFE7579_ADAPTER),
    erc7579LaunchpadAddress: readAddress(env, 'PILOT_ERC7579_LAUNCHPAD', DEFAULT_ERC7579_LAUNCHPAD),
    attesterAddress: readAddress(env, 'PILOT_ATTESTER', DEFAULT_RHINESTONE_ATTESTER),
    saltNonce,
  }
}
