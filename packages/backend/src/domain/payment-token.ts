/**
 * Payment-token resolution (#997, epic #980 M4) — the ONE place that maps a
 * request's `(chainId, asset address)` pair to the chain registry's token
 * config, shared verbatim by the x402 module (`modules/x402/`) and the mpp
 * module (`modules/mpp/`). Extracted from `lib/machine-payments.ts` rather
 * than left there, because folding the rest of that file into `modules/mpp/`
 * as a private internal (this issue's own scope) would otherwise force
 * `modules/x402/` to reach past `modules/mpp/index.ts` into a private file —
 * exactly the deep cross-module import `no-deep-cross-module-import` exists
 * to catch. `src/domain/` is the stable end of both modules' dependency
 * graph: it depends only on the chain registry (`lib/chains.ts`), never the
 * reverse.
 *
 * PURITY NOTE: this does not (yet) satisfy the strict `domain/` bar in
 * `docs/architecture/10-module-boundaries.md` (no ethers/viem/pg/fastify —
 * true here — but also no I/O of any kind transitively, and `lib/chains.ts`
 * layers `config.ts` env wiring over the shared registry). The backend's own
 * `domain/` layer is still `#998` work; this file is the pragmatic seam that
 * unblocks #997 without duplicating the resolver in two modules. Revisit
 * when #998 draws the full boundary — it may want this fed from a pre-loaded
 * registry value instead of importing `lib/chains.ts` directly.
 */
import { getChain } from './chains.js'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Resolve a token by its contract address (or `ZERO_ADDRESS` for the chain's
 * native asset) against the chain registry. Returns `null` when the chain
 * has no token at that address.
 */
export function resolveTokenByAddress(chainId: number, address: string) {
  const lower = address.toLowerCase()
  const chain = getChain(chainId)
  if (lower === ZERO_ADDRESS) {
    return Object.values(chain.tokens).find((t) => t.address === null) ?? null
  }
  return chain.tokenByAddress[lower] ?? null
}

export type ResolvePaymentTokenResult =
  | { ok: true; tokenConfig: NonNullable<ReturnType<typeof resolveTokenByAddress>>; tokenAddress: string }
  | { ok: false; error: string; supported: Array<{ symbol: string; address: string }> }

/**
 * Resolve a payment token from its contract address, returning the token
 * config and the AllowanceModule token address (`ZERO_ADDRESS` for the
 * native asset), or a structured 400-shaped error listing the chain's
 * supported tokens. The single token-resolution path for both the x402
 * route and the mpp module (each previously had its own identical copy of
 * this block, before both were shared here).
 */
export function resolvePaymentToken(chainId: number, asset: string): ResolvePaymentTokenResult {
  const tokenConfig = resolveTokenByAddress(chainId, asset)
  if (!tokenConfig) {
    const chain = getChain(chainId)
    return {
      ok: false,
      error: `Unsupported token asset: ${asset}`,
      supported: Object.values(chain.tokens).map((t) => ({
        symbol: t.symbol,
        address: t.address ?? ZERO_ADDRESS,
      })),
    }
  }
  return { ok: true, tokenConfig, tokenAddress: tokenConfig.address ?? ZERO_ADDRESS }
}
