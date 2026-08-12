/**
 * Public entry point for the mpp module (#997, epic #980 M4). Outside
 * callers (routes, other modules, tests) must import ONLY from this file —
 * see the `no-deep-cross-module-import` dependency-cruiser rule in
 * `.dependency-cruiser.cjs`. Internal files (`rail-dispatch.ts`,
 * `challenge.ts`, `authorize.ts`, `send.ts`, `allowances.ts`, `evidence.ts`,
 * `merchant-receipt.ts`, `reconciliation.ts`, `sweep.ts`) are private.
 *
 * `routes/machine-payments.ts` keeps request validation, auth middleware
 * wiring, rate-limit config, and response serialization; the authorize
 * orchestration, the send flow, sweep prepare/submit orchestration,
 * evidence/receipt assembly, and the rail-aware allowances read live here
 * (#997, epic #980 M4). See `docs/architecture/10-module-boundaries.md` for
 * the boundary rationale.
 *
 * The protocol-rail (`mpp_*` vs `x402`) dispatch cluster this issue was
 * scoped to consolidate lives in `rail-dispatch.ts` — not re-exported here,
 * since every module-internal caller already sits inside this package; a
 * future consumer outside the module should ask whether it actually needs
 * `MachinePaymentRail` (exported below via `types.js`) rather than the
 * dispatch helpers themselves.
 */

export { authorizeMachinePayment, type AuthorizeMachinePaymentInput } from './authorize.js'
export { mppDemoRetired } from './challenge.js'
export { handleSend } from './send.js'
export { handleGetAllowances } from './allowances.js'
export {
  attachEvidenceHandler,
  listReceipts,
  mapEvidence,
  recordMachinePaymentEvidenceBase,
  recordMachinePaymentEvidenceBaseById,
  tryRecordMachinePaymentEvidenceBaseById,
  reconcileDelegateResidueAfterSettlement,
  type MachinePaymentEvidenceRow,
  type MachinePaymentEvidenceSource,
} from './evidence.js'
export { handleMerchantReceiptCapture } from './merchant-receipt.js'
export {
  handleReconciliationEvent,
  RECONCILIATION_EVENT_TYPES,
} from './reconciliation.js'
export { prepareSweep, submitSweep } from './sweep.js'

export type {
  MachinePaymentRail,
  MachinePaymentChallengeBody,
  AuthorizeBody,
  ReconciliationEventBody,
  EvidenceBody,
  SendAsset,
  SendBody,
  SweepSubmitBody,
  MppHandlerResult,
} from './types.js'
export { SUPPORTED_ASSETS } from './types.js'
