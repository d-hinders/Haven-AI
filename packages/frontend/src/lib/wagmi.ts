import { createConfig, fallback, http, type Transport } from 'wagmi'
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors'
import type { Chain } from 'viem'
import { SUPPORTED_CHAINS } from './chains'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

// Build connectors list — only include WalletConnect if a real project ID exists
const connectors = [
  injected(),
  coinbaseWallet({ appName: 'Haven' }),
  ...(projectId && projectId !== 'PLACEHOLDER'
    ? [walletConnect({ projectId })]
    : []),
]

// Read-heavy pages (Safe details and account activity) hammer the RPC. viem's
// default endpoints are aggressively rate-limited and surface as "over rate
// limit" errors, so the wallet layer falls back across reliable endpoints.
//
// Use a fallback transport per chain: prefer a dedicated provider via env, then
// rotate through reliable public nodes. If one endpoint rate-limits or fails,
// viem automatically falls through to the next. Set the per-chain env var in
// production to a dedicated provider (Alchemy/Infura/etc.) for best results.
const RPC_URLS: Record<number, (string | undefined)[]> = {
  8453: [
    process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim(),
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://mainnet.base.org',
  ],
  84532: [
    process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?.trim(),
    'https://base-sepolia-rpc.publicnode.com',
    'https://sepolia.base.org',
  ],
}

/**
 * ── Every chain Haven OFFERS must have a transport (#1971) ───────────────────
 *
 * This list used to be written out by hand as `chains: [base]`, with a
 * "TEMPORARY: Base-only while we ship a single-chain UX" note — while
 * `lib/chains.ts` went on offering **two** chains (`SUPPORTED_CHAIN_IDS` =
 * 8453 + 84532) in every network picker, and the dev deployment set
 * `NEXT_PUBLIC_HAVEN_CHAIN_ID=84532` so Base Sepolia was its DEFAULT.
 *
 * The gap between those two lists did not fail loudly. `@wagmi/core`'s
 * `getClient` CATCHES `ChainNotConfiguredError` and returns `undefined`
 * (`actions/getClient.js`), so `usePublicClient({ chainId: 84532 })` was
 * `undefined` and every consumer bailed at its first line. No request was
 * issued, no error was raised, and the affected surface rendered its empty
 * branch. The transport list is derived from the offered chains so this class
 * of silent mismatch cannot disable a supported account surface.
 *
 * So the list is DERIVED rather than restated: whatever `chains.ts` offers, we
 * build a transport for. Adding a chain to `ENABLED_CHAIN_IDS` can no longer
 * produce a chain the wallet layer cannot talk to. `wagmi-transport-parity`
 * asserts the property against `getClient` itself, not against this code.
 */
function transportFor(chainId: number): Transport {
  const urls = (RPC_URLS[chainId] ?? []).filter((url): url is string => Boolean(url))
  // No pinned endpoints for a newly offered chain: fall back to the chain's own
  // default RPC rather than registering nothing. A slow default endpoint is a
  // performance problem; a missing transport is the silent-empty-state defect
  // this whole comment is about.
  return urls.length > 0 ? fallback(urls.map((url) => http(url))) : http()
}

const CHAINS = SUPPORTED_CHAINS.map((c) => c.viemChain) as unknown as readonly [Chain, ...Chain[]]

export const config = createConfig({
  chains: CHAINS,
  connectors,
  transports: Object.fromEntries(
    CHAINS.map((chain) => [chain.id, transportFor(chain.id)]),
  ) as Record<number, Transport>,
  ssr: true,
})
