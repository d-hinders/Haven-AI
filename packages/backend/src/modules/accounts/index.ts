// Public entry point for the accounts module (#998).
//
// Safe account READS (details), passkey signer verification, the mainnet
// single-signer floor, and portfolio/balance aggregation across a user's
// accounts. Cross-module imports must resolve here, never to a deep file in
// this directory.
//
// The deploy half (`safe-deployer.ts`) and the owner-change builders
// (`safe-owner-tx.ts`) were deleted in #1988 (epic #1440, the Safe-rail
// retirement) together with the routes that were their only callers.
export * from './mainnet-gate.js'
export * from './passkey-signer.js'
export * from './portfolio.js'
export * from './safe-details.js'
