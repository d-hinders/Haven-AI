// Public entry point for the feedback module (#3597).
//
// The backend's re-run of the CLI's own secret-check layers 1 (labelled
// secrets), 3 (key-backed-address derivation) and 4 (recovery phrases) —
// see `secret-check.ts`'s own header. Cross-module imports must resolve
// here, never to a deep file in this directory.
export * from './secret-check.js'
