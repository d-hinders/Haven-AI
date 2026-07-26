/**
 * `@haven_ai/core` — the shared Haven kernel.
 *
 * PRIVATE workspace package (never published to npm): `packages/backend`,
 * `packages/frontend` and other private consumers depend on it with `"*"` so
 * npm always links the workspace copy. Introduced by epic #980 (#983) to give
 * the backend and the dashboard ONE definition of the things they had both
 * been re-deriving.
 *
 * **This package must stay pure.** No `fastify`, no `pg`, no `ethers`/`viem`,
 * no environment or I/O of any kind — it is imported by a Node server and by a
 * browser bundle, and it is the "stable" end of the stable-dependency rule in
 * `docs/architecture/10-module-boundaries.md`. A dependency-cruiser rule
 * (`core-stays-pure`) enforces this with ZERO baseline entries; if it ever
 * fires, the new code belongs in the consumer, not here.
 */

export { ETH_ADDRESS_RE, isAddress } from './address.js'

// Wire shapes generated from the backend's OpenAPI spec (#984) — the single
// source for API response types. `ApiSchema<'TransactionsResponse'>` is the
// ergonomic entry point; `ApiPaths`/`ApiOperations` cover route-keyed lookups.
export type {
  paths as ApiPaths,
  components as ApiComponents,
  operations as ApiOperations,
} from './api-types.js'
export type { ApiSchema } from './api-schema.js'

// Shared chain + token registry (#986) — the single source for per-chain
// facts; backend/frontend layer environment wiring and representation on top.
export {
  CHAIN_REGISTRY,
  REGISTRY_CHAIN_IDS,
  getChainData,
  isRegisteredChain,
  resolveToken,
  buildExplorerUrl,
  type CoreChainConfig,
  type CoreTokenConfig,
} from './chains.js'

// Machine-payment lifecycle domain (#987) — rails, status unions, derivation.
export {
  MACHINE_PAYMENT_RAILS,
  machinePaymentLifecycle,
  type MachinePaymentFlowStatus,
  type MachinePaymentAttentionReason,
  type MachinePaymentLifecycle,
} from './machine-payment-lifecycle.js'
