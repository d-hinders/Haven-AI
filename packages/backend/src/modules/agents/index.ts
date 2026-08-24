// Public entry point for the agents module (#998).
//
// Agent identity and credential onboarding: connection-setup mechanics,
// allowance-input validation, and account entitlements. Cross-module imports
// must resolve here, never to a deep file in this directory.
export * from './agent-allowance-validation.js'
export * from './agent-connection-setup.js'
export * from './entitlements.js'
// #1698 re-key: the ordering state machine, the budget-meter carry, and the
// two authority refusals. All three are pure — no I/O, no database handle —
// which is what lets the route, the repository and their tests share one copy
// of each rule instead of restating it.
export * from './rekey-carry.js'
export * from './rekey-guards.js'
export * from './rekey-stages.js'
