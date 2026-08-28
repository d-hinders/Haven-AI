/**
 * Protocol-rail (`mpp_*` vs `x402`) dispatch, consolidated (#997). Before this
 * file, the `rail === 'mpp_demo'` / `rail?.startsWith('mpp_')` checks that
 * decide protocol-specific behavior were scattered across
 * `lib/machine-payments.ts` and `lib/machine-payment-evidence.ts` — each
 * inside a function that ALSO did persistence or evidence writing, which is
 * exactly the shape the module-boundary doc calls out as a seam that exists
 * as a type but not a boundary (see `docs/architecture/10-module-boundaries.md`
 * → "Deletability is the test"). Every protocol-rail branch in the mpp module
 * goes through this file now.
 *
 * This is a DIFFERENT axis from `execution_rail` (delegation vs legacy
 * AllowanceModule, decided by `lib/execution-rail.ts`) — see the #997 issue
 * body for why #991 (which covered `execution_rail`) does not apply here.
 *
 * Two rail-membership predicates live here side by side deliberately, because
 * they answer different questions and must NOT be merged into one set:
 * - `isMppRail` classifies a rail for RESPONSE-SHAPE purposes (does this
 *   payment get the `.mpp` block?) — historically also accepted the bare
 *   `'mpp'` value alongside `mpp_*`.
 * - `isProtocolPaymentRail` is the EVIDENCE-ELIGIBILITY gate (which rails can
 *   ever get a `machine_payment_evidence` row?) — `stripe_deposit` is a
 *   deliberate `MachinePaymentRail` member that is NOT evidence-eligible, so
 *   this set is narrower than "every mpp/x402 rail" on purpose.
 */
// ── Response-shape dispatch (was lib/machine-payments.ts's isMppRail) ───────

export function isMppRail(rail: string | null | undefined): boolean {
  return rail === 'mpp' || Boolean(rail?.startsWith('mpp_'))
}

interface MachineMetadata {
  network?: unknown
  description?: unknown
}

// #1987 (epic #1440): `MachineRailContext`, `machineRailFields` and
// `approvalReasonFor` are gone with `modules/mpp/authorize.ts` — the legacy
// MPP AllowanceModule orchestration was their ONLY consumer, and it had no
// production caller left once #1328 stubbed `POST /machine-payments/authorize`
// and #1986 410'd the rail beneath it. `isMppRail`, `metadataObject`,
// `nullableString` and `isProtocolPaymentRail` STAY: they are read by
// `modules/payments/agent-payment-status.ts`, which serves the payment-status
// surface the epic keeps readable.

export function metadataObject(value: unknown): MachineMetadata {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as MachineMetadata
  if (typeof value !== 'string') return {}

  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MachineMetadata
    }
  } catch {
    return {}
  }

  return {}
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Per-protocol response field shaping: mpp rails get a `.mpp` block mirroring
 * the top-level fields (agent SDKs read either shape); x402 does not (its own
 * module shapes its own `.x402` block independently). Was `machineRailFields`.
 */

// ── Evidence-eligibility gate (was lib/machine-payment-evidence.ts) ─────────

const PROTOCOL_RAILS = new Set(['x402', 'mpp_demo', 'mpp_crypto', 'spt'])

export function isProtocolPaymentRail(rail: string | null | undefined): rail is string {
  return Boolean(rail && PROTOCOL_RAILS.has(rail))
}
