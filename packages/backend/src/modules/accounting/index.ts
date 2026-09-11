// Public entry point for the ACCOUNTING module (#2859, epic #2858).
//
// Two halves live under this directory and only one is exported here:
//
//   this file    the non-asserting accounting FEED (#491) — connectors, the
//                dedup ledger, the orchestrator, Fortnox OAuth — plus the
//                shared `entry.ts` data assembly it reads settled payments
//                through.
//   legacy/      the asserting #462 bookkeeping export (SIE, vouchers,
//                booking lines, reconciliation), darkened behind
//                `HAVEN_LEGACY_BOOKKEEPING_ENABLED`. NOT re-exported here.
//
// The split is the product invariant made structural: the feed never asserts
// VAT, accounts or rows. `__tests__/legacy-import-guard.test.ts` enforces it.
export * from './entry.js'
export * from './connector.js'
export * from './feed-orchestrator.js'
export * from './feed-sync.js'
export * from './fortnox-connection.js'
export * from './fortnox-connector.js'
export * from './fortnox.js'
export * from './receipt-underlag.js'
export * from './feed-transaction.js'
