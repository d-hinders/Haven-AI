// Public entry point for the LEGACY asserting bookkeeping code (#462, darkened
// by #491 behind `HAVEN_LEGACY_BOOKKEEPING_ENABLED`).
//
// This code ASSERTS: it picks BAS accounts, builds balanced double-entry
// booking lines, writes SIE verifikat and pushes Fortnox vouchers. The
// non-asserting feed one directory up must never reach it — #491's whole
// premise is that Haven is a data source and the accountant books it.
//
// Deliberately NOT re-exported from `../index.ts` (#2859). The import guard in
// `../__tests__/legacy-import-guard.test.ts` fails if a feed file imports from
// here; only the legacy routes (`routes/accounting.ts`, `routes/fortnox.ts`)
// may, and only while they remain dark.
export * from './booking.js'
export * from './ledger-exporter.js'
export * from './reconcile.js'
export * from './sie-exporter.js'
export * from './fortnox-voucher.js'
