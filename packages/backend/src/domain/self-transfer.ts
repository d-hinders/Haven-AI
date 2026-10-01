/**
 * #3528 — the self-transfer prepare hint. When a payment's recipient is one of
 * the owner's OWN Haven account addresses, the prepare response carries an
 * additive, WARNING-GRADE hint naming that; a stranger's address carries none.
 *
 * What this deliberately is NOT, in both directions:
 *
 * - NOT a refusal. A self-transfer is legitimate (sweeping between own
 *   accounts), and the on-chain authority for the send is unchanged either
 *   way — the budget delegation's caveat enforcers remain the only gate. This
 *   module adds no refusal, writes no refusal-ledger row, and never flips
 *   `safe_to_continue`: every caller merges the hint into an already-decided
 *   success response. Red Line #4/#5 posture unchanged — advisory
 *   pre-validation that narrows nothing and authorises nothing.
 * - NOT discretionary. The comparison is a pure equality against addresses
 *   the backend ALREADY owns in its owner directory (`smart_accounts`:
 *   account_address + owner_address). No chain read, no heuristics, no
 *   "never paid this address" bookkeeping — the owner's own account is the
 *   one case a live run flagged (#3328).
 */
import { listOwnerAddressesForUser } from '../infra/repositories/smart-accounts.js'

/**
 * The warning code as it rides the prepare wire (snake_case, like every
 * other backend response field). The SDK maps it onto its own
 * `AgentPaymentWarningCode` vocabulary; the literal here is the wire value.
 */
export const SELF_TRANSFER_WARNING_CODE = 'SELF_TRANSFER'

/** The message the warning carries — names the situation, prescribes nothing. */
export const SELF_TRANSFER_WARNING_MESSAGE =
  'This recipient is one of your own Haven accounts. A payment here is a transfer between ' +
  'accounts you (or your owner) control, not a payment to a third party.'

/**
 * True when `recipient` equals one of the user's own account addresses — the
 * owner's accounts, resolved where the backend already resolves them: the
 * owner-directory read (`smart_accounts`, one query for every address the
 * user's delegation-rail accounts answer to, their smart-account address and
 * current EOA owner alike). DELIBERATELY FAIL-OPEN: any error reading the
 * directory resolves to `false` — a degraded read must never refuse,
 * warn-spam, or otherwise perturb a prepare the enforcers would allow, which
 * is the same posture as every budget read on these routes (#2082/#2706/#3503).
 * Case-insensitive by construction: addresses are compared lower-cased on
 * both sides.
 */
export async function isSelfTransferRecipient(
  userId: string,
  recipient: string,
): Promise<boolean> {
  try {
    const wanted = recipient.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(wanted)) return false
    const addresses = await listOwnerAddressesForUser(userId)
    return addresses.some((addr) => typeof addr === 'string' && addr.toLowerCase() === wanted)
  } catch {
    // Fail open, always: the hint is additive telemetry, never a gate.
    return false
  }
}

/**
 * The additive warning block for a prepare response body: `undefined` when the
 * recipient is NOT one of the owner's own accounts (strangers' prepares are
 * byte-identical to today's), and the one-entry `warnings` array when it is.
 * Attach with `...(await selfTransferWarning(userId, recipient))` — spread of
 * undefined is a no-op, so the field is PRESENT exactly when the hint applies.
 */
export async function selfTransferWarning(
  userId: string,
  recipient: string,
): Promise<{ warnings: Array<{ code: string; message: string }> } | undefined> {
  if (!(await isSelfTransferRecipient(userId, recipient))) return undefined
  return {
    warnings: [
      {
        code: SELF_TRANSFER_WARNING_CODE,
        message: SELF_TRANSFER_WARNING_MESSAGE,
      },
    ],
  }
}
