/**
 * One reader for `payment_intents.machine_metadata` (#4765).
 *
 * The column is JSONB (`db/migrations/012_machine_payment_metadata.ts:13`), so
 * `pg` hands back a parsed value or null — yet fifteen sites across twelve
 * `modules/` files each carried their own defensive `JSON.parse` branch, and
 * `machine_metadata.settlement_scheme` (the field that selects erc7710 vs the
 * EIP-3009 bridge) was read on eight code lines by five differently-shaped
 * readers. Their parity was held by comment.
 *
 * The parsers below are deliberately NOT one parser with options. Today's
 * readers disagree on what an unusable value becomes — `null`, `{}`, or a
 * throw at the call site — and #4765 forbids silently unifying them: each
 * named function is the exact shape one call site reads today, pinned cell by
 * cell in `src/__tests__/machine-metadata-reader.characterization.test.ts`.
 * The scheme readers are the same rule: one shared reader for the five call
 * sites whose bodies were identical, plus the two named variants whose
 * behaviour differs (the strict dereference in `mpp/evidence.ts` and the
 * narrowed read with the `{child, budget}` fallback in `x402/intent-by-key.ts`).
 *
 * Lives in `domain/` because it is a pure parser: no framework, no `pg`, no
 * chain SDK, no `modules|infra|http|rails` import (`domain-stays-pure`). Both
 * `modules/x402/` and `modules/mpp/` may import it. It is on the money-path
 * perimeter (`.github/money-path-globs.json`) because `settlement_scheme`
 * selects the settlement path.
 */

/** The column's value as the driver hands it back: parsed jsonb, a JSON string, or null. */
export type MachineMetadataValue = unknown

/**
 * `null` when the value is unusable, otherwise the parsed value.
 *
 * Today's `parsedMachineMetadata` (`mpp/budget-precheck.ts`,
 * `payments/agent-payment-status.ts`) and `metadataOf`
 * (`x402/eip3009-settlement-evidence.ts`): falsy → null; a string is parsed
 * and a throw becomes null; anything else is returned as-is. A JSON text that
 * parses to a primitive is returned as that primitive — every caller
 * optional-chains a field off it, so the primitive itself is never observed.
 */
export function machineMetadataOrNull(value: MachineMetadataValue): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return value as Record<string, unknown>
}

/**
 * `{}` when the value is unusable, otherwise the parsed value.
 *
 * Today's `metadataOf` / `metadataRecord` (`x402/eip3009-receipt-settlement.ts`)
 * and the inline parse in `mpp/evidence.ts`. A JSON text that parses to a
 * non-object is returned AS THAT VALUE (null for the JSON text `null`), not
 * `{}` — the call sites that dereference it without a guard throw on it today,
 * and #4765 keeps that. The return type says `Record` because that is what the
 * call sites assume; the runtime value can be null.
 */
export function machineMetadataObjectOrEmpty(value: MachineMetadataValue): Record<string, unknown> {
  if (!value) return {}
  if (typeof value !== 'string') return value as Record<string, unknown>
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * `{}` when the value is unusable, otherwise a non-array object.
 *
 * Today's `metadataObject` (`payments/agent-payment-status.ts`): arrays and
 * primitives become `{}`, and a JSON text that parses to anything but a
 * non-array object becomes `{}`.
 */
export function machineMetadataRecord(value: MachineMetadataValue): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return {}
  }
  return {}
}

/**
 * `null` when the value is unusable, otherwise an object (arrays included).
 *
 * Today's `parseObject` (`x402/intent-by-key.ts`) as applied to
 * `machine_metadata`: a JSON text that parses to a non-object becomes null.
 * `parseObject` itself stays in that file for `prepared_user_op`, which is the
 * same JSONB-object shape but not this column.
 */
export function machineMetadataObject(value: MachineMetadataValue): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * `machine_metadata.settlement_scheme` — the field that selects erc7710 vs the
 * EIP-3009 bridge — as a string, or null.
 *
 * The shared reader for the five call sites whose bodies were identical:
 * `mpp/budget-precheck.ts`, `payments/agent-payment-status.ts`,
 * `x402/settle.ts`, `x402/settlement-observed.ts`,
 * `x402/eip3009-receipt-settlement.ts` and
 * `x402/eip3009-settlement-evidence.ts`. Their parity used to be held by
 * comment; the characterization table holds it now.
 */
export function settlementSchemeOf(machineMetadata: MachineMetadataValue): string | null {
  const scheme = machineMetadataOrNull(machineMetadata)?.settlement_scheme
  return typeof scheme === 'string' ? scheme : null
}

/**
 * The scheme read `mpp/evidence.ts` makes: it dereferences the parsed value
 * without a null guard, so a JSON text that parses to a non-object throws a
 * TypeError. Preserved deliberately (#4765): the characterization table records
 * that throw as a cell, and this PR may not change what a call site reads.
 */
export function settlementSchemeOfStrict(machineMetadata: MachineMetadataValue): string | null {
  const metadata = machineMetadataObjectOrEmpty(machineMetadata)
  const scheme = metadata.settlement_scheme
  return typeof scheme === 'string' ? scheme : null
}

/**
 * The narrowed scheme read `x402/intent-by-key.ts` makes: `'erc7710'` or
 * `'eip3009'` only, and when the field is absent it falls back to the stored
 * settlement state's shape — an erc7710 `{child, budget}` pair in
 * `prepared_user_op`. Anything else is unknown (null).
 *
 * `settlementState` is the already-parsed `prepared_user_op`; the caller keeps
 * its own `parseObject` for that column.
 */
export function settlementSchemeOfNarrowed(
  machineMetadata: MachineMetadataValue,
  settlementState: Record<string, unknown> | null,
): 'erc7710' | 'eip3009' | null {
  const scheme = machineMetadataObject(machineMetadata)?.settlement_scheme
  if (scheme === 'erc7710' || scheme === 'eip3009') return scheme
  if (settlementState?.child && settlementState?.budget) return 'erc7710'
  return null
}
