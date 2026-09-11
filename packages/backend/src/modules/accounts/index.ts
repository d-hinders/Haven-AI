// Public entry point for the accounts module (#998).
//
// Safe account READS (details) and passkey signer verification left with the
// Safe rail's last live behaviour: #2847 (epic #1440) deleted
// `modules/accounts/safe-details.ts` with `GET /safe/:addr/details` and
// `modules/accounts/passkey-signer.ts` with `POST /passkeys` +
// `POST /safe/exec`. The mainnet single-signer floor and portfolio/balance
// aggregation across a user's accounts remain. Cross-module imports must
// resolve here, never to a deep file in this directory.
//
// The deploy half (`safe-deployer.ts`) and the owner-change builders
// (`safe-owner-tx.ts`) were deleted in #1988 (epic #1440, the Safe-rail
// retirement) together with the routes that were their only callers.
export * from './mainnet-gate.js'
export * from './portfolio.js'
