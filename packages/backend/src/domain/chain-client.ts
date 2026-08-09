/**
 * ChainClient port (#994, epic #980 M2) — the interface that stops the
 * choice between `ethers` (legacy AllowanceModule rail) and `viem`
 * (delegation rail) from being visible at the HTTP layer.
 *
 * PURE TYPES ONLY. This file must never import `ethers`, `viem`,
 * `permissionless`, `@metamask/smart-accounts-kit`, or anything under
 * `infra/`, `rails/`, `modules/` or `http/` — it is the stable end of the
 * stable-dependency rule in docs/architecture/10-module-boundaries.md.
 * `.dependency-cruiser.cjs`'s `chain-sdk-not-in-routes` rule is what a route
 * violates by reaching past this port for a chain SDK directly.
 *
 * Surface derivation (not speculated — audited against the ten route files
 * #994 names): every route that touches a chain SDK directly does so for
 * one of three things — reading a balance, checksum-normalising an address,
 * or (separately, NOT on this port — see below) formatting/parsing a token
 * amount. That audit is why the port has exactly three methods.
 *
 * What is deliberately NOT here:
 * - `formatUnits`/`parseUnits`-shaped amount conversion. Both SDKs implement
 *   these as pure, deterministic string<->bigint math with no chain I/O —
 *   the issue's own words: "those are not chain I/O and do not deserve an
 *   interface." The canonical implementation lives in
 *   `@haven_ai/core`'s `formatTokenAmount`/`parseTokenAmount` instead,
 *   characterized byte-identical to `ethers.formatUnits`/`parseUnits`
 *   against every registry token (see
 *   `routes/__tests__/amount-formatting.characterization.test.ts`).
 * - Explorer URL building. Already pure in `@haven_ai/core`'s
 *   `buildExplorerUrl` / the backend's `lib/chains.ts::getExplorerUrl` — no
 *   route ever reached a chain SDK for this.
 * - `isAddress` format checking. Already pure in `@haven_ai/core`.
 * - Safe deployment/execution (CREATE2 prediction, `execTransaction`,
 *   passkey-signer contract calls), the AllowanceModule calldata decode
 *   used to verify an on-chain x402 payment, and the x402 binding-signer's
 *   message signing. These are real chain-SDK usages that do NOT fit this
 *   port's shape — none of them is "the same operation on either rail," each
 *   is tied to one specific contract's ABI or one specific signing key, so a
 *   shared interface would be speculative. They move to `infra/chain/*` as
 *   their own modules (still zero SDK imports in `routes/**`, per the
 *   dependency rule) rather than being forced onto `ChainClient`. Reported,
 *   not forced, per #994's own instruction.
 */

/** The two live rails (`lib/execution-rail.ts`); selects which SDK backs a `ChainClient`. */
export type ChainRail = 'allowance_module' | 'delegation'

export interface ChainClient {
  /** The chain-native currency balance (wei-equivalent) for `address`. */
  getNativeBalance(chainId: number, address: string): Promise<bigint>

  /**
   * An ERC-20 `balanceOf` read for `address` against `tokenAddress`.
   *
   * `tokenAddress` must be a real ERC-20 contract. The chain-native currency
   * is `getNativeBalance`, and the token registry marks native with
   * `address: null` — never the zero address — so a null/empty/zero token
   * address here is a caller bug, and BOTH implementations throw on it
   * (#1149). They used to disagree: viem silently returned the native
   * balance, ethers built a contract at 0x0; same call, two answers, and
   * whichever you got depended on the rail.
   */
  getTokenBalance(chainId: number, tokenAddress: string, address: string): Promise<bigint>

  /**
   * Checksum-normalise (EIP-55) a possibly-mis-cased 40-hex address.
   * Format validation (is this even 40 hex chars?) is `@haven_ai/core`'s
   * `isAddress` — call that first; this assumes a well-formed address and
   * only fixes casing.
   */
  normaliseAddress(address: string): string
}

/**
 * Structurally identical to `viem`'s `Address`/`Hex` template-literal types
 * (both `` `0x${string}` `` in the installed viem version) — defined here,
 * not imported from `viem`, so a route that only needs the TYPE (never the
 * SDK) doesn't have to import the SDK to get it.
 */
export type Address = `0x${string}`
export type Hex = `0x${string}`
