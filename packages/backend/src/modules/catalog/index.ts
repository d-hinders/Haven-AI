// Public entry point for the catalog module (#998).
//
// Merchant catalog storage and x402/MPP discovery. Cross-module imports must
// resolve here, never to a deep file in this directory.
export * from './catalog-discovery.js'
export * from './merchant-catalog.js'
export * from './ownership.js'
