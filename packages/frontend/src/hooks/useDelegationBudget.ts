'use client'

/**
 * Delegation-rail budget lifecycle for the dashboard (#833, epic #821).
 *
 * The owner-facing counterpart of the delegation lifecycle API (#828): grant a
 * budget with ONE signature, list budgets with status, revoke with ONE
 * signature. An EOA owner signs the EIP-712 typed data the backend returns
 * VERBATIM — never a reconstructed payload, never a bare hash (the #829/#832
 * lesson; the account validates exactly that typed data). A PASSKEY-owned
 * account signs through the kit's WebAuthn path instead (#887): delegations
 * via account.signDelegation, treasury ops via account.signUserOperation —
 * the exact encoding the #884 spike proved on-chain. Haven signs nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import { useActiveSigner, hasPasskeyCredentialOnDevice, credentialIdFromKeyId } from '@/lib/signer'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import type { AccountSigners, DelegationMessage } from '@/lib/delegationPasskeySigner'
import { findOccupyingBudget, sameSlot, slotOccupantHashesForEdit, type BudgetSlot } from '@/lib/budget-slot'

/**
 * Which signer to use for THIS device, given the account's signer set (the
 * multi-signer fix): a Hybrid account accepts ANY of its enrolled signers
 * on-chain, so "the account has an EOA owner" must never disable the passkey
 * path — that stranded every passkey user who enrolled a wallet as backup.
 * Preference: a passkey enrolled on this device → the connected wallet WHEN
 * it is the set's named owner → any passkey (the authenticator can find
 * credentials our device markers missed). Null only when the account has no
 * reachable signer from here.
 *
 * #2068: the EOA rung takes the connected ADDRESS, not a boolean — "a wallet
 * is connected" never satisfied "the owner is connected". An unrelated
 * connected wallet used to be picked here for a mixed account, and its
 * signature then failed at verification; a signer offered but failing at
 * signature time is worse than absent, so a non-owner wallet now falls
 * through to the passkey rung (or to null for an owner-only set).
 */
export function pickSigningPath(
  signers: AccountSigners | null,
  connectedEoaAddress: string | null | undefined,
): 'passkey' | 'eoa' | null {
  if (!signers) return null
  const hasPasskeys = signers.passkeys.length > 0
  const onDevice =
    hasPasskeys &&
    signers.passkeys.some((p) => hasPasskeyCredentialOnDevice(credentialIdFromKeyId(p.key_id)))
  if (onDevice) return 'passkey'
  if (
    signers.owner_address &&
    connectedEoaAddress &&
    signers.owner_address.toLowerCase() === connectedEoaAddress.toLowerCase()
  ) {
    return 'eoa'
  }
  if (hasPasskeys) return 'passkey'
  return null
}

/**
 * True when the account has passkeys but none is marked on THIS device
 * (#1097): signing still works — the optimistic fallback hands the ceremony
 * to the browser, which offers its cross-device (QR) flow — but the user
 * deserves a heads-up that the sheet may point at another device. This is a
 * HINT condition, never a gate: removing the fallback would strand every
 * legitimate cross-device signer.
 */
export function passkeyLikelyElsewhere(signers: AccountSigners | null): boolean {
  if (!signers || signers.passkeys.length === 0) return false
  return !signers.passkeys.some((p) => hasPasskeyCredentialOnDevice(credentialIdFromKeyId(p.key_id)))
}

export interface DelegationBudget {
  id: string
  token_address: string
  recipient_address: string | null
  delegation_hash: string
  version: number
  status: 'pending' | 'active' | 'replaced' | 'revoked'
  budget_atomic: string
  period_seconds: number
  expires_at: number
  /**
   * #3806: the period ANCHOR — a Unix-second digit string on the wire (the
   * driver decodes the BIGINT as a string). A period runs from
   * `start_date + k × period_seconds`, not from creation time: budgets are
   * signed with `startDate: nowSec - 60` and a re-key's carry/steady pair
   * keeps the old boundary. The caption helper anchors refills here.
   */
  start_date: string
  /** #3806: ordering anchor for the multi-budget primary selection. */
  created_at: string
  /**
   * The merchant a merchant-locked budget (#3331) was issued for, or null for
   * every other row (and after that merchant is deleted). All three travel
   * together — a row either names all three or none.
   */
  merchant_id?: string | null
  merchant_slug?: string | null
  merchant_name?: string | null
  /**
   * #3922: the server's budget-VIEW liveness — `active` and unexpired (the start
   * date is not consulted, so a dormant re-key row is live). Clients read this
   * instead of recomputing from `status` and `expires_at`.
   */
  is_live: boolean
  /**
   * #3693: remaining-this-period for LIVE rows (#3923). `remaining_from_chain:
   * false` means the on-chain read failed and `remaining_atomic` is the full
   * budget. All three are null for non-live rows (an expired active one too).
   */
  remaining_atomic?: string | null
  remaining_from_chain?: boolean | null
  period_end?: string | null
}

interface BuildResponse {
  delegation_hash: string
  version: number
  signing_payload: TypedDataPayload
}

interface RevokePrepare {
  signature_scheme?: 'eip712_userop' | 'webauthn_userop'
  signing_payload?: TypedDataPayload
  user_op_hash?: string
  user_operation: unknown
}

interface RevokeAllPrepare extends RevokePrepare {
  delegation_hashes: string[]
}

interface TypedDataPayload {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

export interface GrantInput {
  tokenAddress: Address
  recipientAddress?: Address | null
  budgetAtomic: string
  periodSeconds: number
  /**
   * A merchant-locked budget (#3331): the server pins the recipient to this
   * live merchant's verified payTo on the agent's chain and records the
   * merchant on the row. `recipientAddress` MAY be sent alongside it; it must
   * then equal the merchant's current verified payTo, or the build is a 409.
   * Left omitted (or null), the server derives the recipient itself.
   */
  merchantSlug?: string
}

/**
 * `too_many` (#1437) is distinct from `failed` on purpose: the backend refuses
 * an oversized batch by NAMING per-budget revocation as the remedy, and a
 * caller that flattens it into the generic failure strands the user on a
 * screen that repeats a refusal without ever saying what to do instead.
 *
 * `refused` is any NAMED build refusal the backend answers with a sentence —
 * not only the merchant-locked build's four 409s (#3331: no verified payTo,
 * not every offer ERC-7710, the payTo is one of the agent's own addresses, a
 * sent recipient disagrees with the payTo), but also the ordinary grant
 * refusals `POST /delegations/build` can answer for ANY caller (a revoked
 * agent, an account off the delegation rail, a chain the rail is not enabled
 * on, an in-flight re-key). `detail` is the backend's own sentence, the same
 * shape `editBudget`'s `refused` already carries — a caller decides how much
 * of it to show; `FundMerchantModal` maps the named ones to plain copy and
 * falls back to a generic sentence for anything it does not recognise
 * (`refusalCopy` in `components/marketplace/FundMerchantModal.tsx`).
 * Additive: every existing caller that does not name it keeps folding it into
 * its generic failure copy, exactly as it already does for `too_many`.
 *
 * `unconfirmed` (#3930) is the lost-activate-response outcome: the activation
 * POST threw and the re-read could not prove what happened (the row is still
 * `pending`, is absent, or the re-read itself failed). The activation may
 * HAVE committed — a proxy 5xx can arrive while the backend is still
 * deploying — so this is never "nothing changed": the grant may already be
 * live. (Before #3933 a retry that trusted it minted a second enabled grant;
 * the backend now refuses a second live budget in the slot, #3971.) Renderers must send the owner to check the
 * agent's budgets before trying again, and never name Haven as the approver.
 */
export type BudgetResult =
  | {
      ok: true
      /**
       * `revoke` only (#3933): the per-hash revoke answered "Already revoked"
       * (409) — the row was already revoked, or disabled on-chain and healed
       * by the route. The goal of a Stop is met; nothing was signed.
       */
      alreadyStopped?: boolean
    }
  | { ok: false; reason: 'cancelled' | 'failed' | 'too_many' | 'refused' | 'unconfirmed'; detail?: string }

/**
 * #3933: the (token, recipient) slot already holds a live budget, so the
 * backend refused a PLAIN grant into it (409 `BUDGET_SLOT_OCCUPIED`, at build
 * or at activate; nothing was written). Activating it would have retired the
 * old budget in Haven's mirror only, leaving it enabled on-chain. The way
 * forward is the edit flow (`editBudget`), which names the old budget as
 * `replaces` and then stops it. `existingDelegationHash` is the backend's
 * `existing_delegation_hash`, the budget to edit, or null when the answer did
 * not carry one. Mapped from the 409's `error_code`, never from its sentence.
 *
 * Only `grant` returns this, so it is its own type rather than another
 * `BudgetResult` reason: `revoke`/`revokeAll` callers never see it.
 */
export type SlotOccupiedResult = {
  ok: false
  reason: 'slot_occupied'
  existingDelegationHash: string | null
  detail?: string
}

export type GrantResult = BudgetResult | SlotOccupiedResult

/** The `error_code` the delegation build and activate routes answer for an occupied slot (#3933). */
export const BUDGET_SLOT_OCCUPIED = 'BUDGET_SLOT_OCCUPIED'

/**
 * #3933: read the occupied-slot refusal off a thrown API error, by its
 * `error_code` — never by message text. Duck-typed on purpose (`body` is the
 * `ApiRequestError` escape hatch, `lib/api.ts`): the test suites mock
 * `@/lib/api` without the class, and an `instanceof` against an undefined
 * export would throw instead of answering.
 */
function slotOccupiedFrom(err: unknown): SlotOccupiedResult | null {
  if (!err || typeof err !== 'object') return null
  const body = (err as { body?: unknown }).body
  if (!body || typeof body !== 'object') return null
  const b = body as { error_code?: unknown; existing_delegation_hash?: unknown; error?: unknown }
  if (b.error_code !== BUDGET_SLOT_OCCUPIED) return null
  return {
    ok: false,
    reason: 'slot_occupied',
    existingDelegationHash: typeof b.existing_delegation_hash === 'string' ? b.existing_delegation_hash : null,
    ...(typeof b.error === 'string' && b.error.trim() ? { detail: b.error } : {}),
  }
}

/**
 * The edit-in-place result (#3166). Distinct from `BudgetResult` because the
 * composition has states the single grant does not:
 *
 * - `refused` — the backend refused the BUILD step by name (revoked agent,
 *   re-key in flight, off-rail account). `detail` is the backend's own
 *   sentence; the old budget is live and untouched.
 * - `revoke_unfinished` — the new grant is LIVE but the old one is not yet
 *   revoked on-chain (the stop signature was cancelled or the submit failed).
 *   `newDelegationHash` lets the caller point at the live budget; the owner
 *   finishes the stop from the budget card's own Stop button.
 * - `oldDelegationRevoked` is false in the one success-shaped race where the
 *   old grant was already revoked before the flow asked for the stop
 *   signature — the goal is met, so this still reports `ok: true`.
 * - `slot_occupied` (#3933) — the budget being edited is no longer the slot's
 *   live budget (another edit or a re-key replaced it since the modal
 *   opened), so the backend refused the `replaces` it was sent. Nothing was
 *   written; the owner edits the current budget instead.
 * - `target_slot_occupied` (#3933 review finding 2) — the edit changes the
 *   recipient, and the NEW (token, recipient) slot already holds a live
 *   budget. The budget being edited is untouched; the owner edits that other
 *   budget instead, or picks another recipient. Decided by comparing slots
 *   (the edit moved), never by the refusal's sentence; caught before any
 *   signature when the loaded list shows the occupant.
 * - `revoke_unfinished` carries `unstoppedDelegationHashes`: the old budget's
 *   rows whose Stop did not finish, in the order the flow would sign them. A
 *   budget carried as a re-key pair is two rows, and each needs its own Stop.
 */
export type EditBudgetResult =
  | {
      ok: true
      newDelegationHash: string
      oldDelegationRevoked: boolean
      /**
       * #3933: the replacement finished was an earlier, unconfirmed attempt
       * that landed with OTHER limits — the live budget carries those, not
       * the ones last asked for. Set by the modal's finish-Stop, carried
       * from the `revoke_unfinished` that reported it.
       */
      earlierLimits?: true
    }
  | {
      ok: false
      reason:
        | 'cancelled'
        | 'failed'
        | 'refused'
        | 'revoke_unfinished'
        | 'unconfirmed'
        | 'slot_occupied'
        | 'target_slot_occupied'
      detail?: string
      newDelegationHash?: string
      /** `slot_occupied` / `target_slot_occupied`: the live budget in the slot the grant was refused for. */
      existingDelegationHash?: string | null
      /**
       * `revoke_unfinished` only: an earlier, unconfirmed attempt of this
       * edit landed with OTHER limits than the ones now asked for — the live
       * budget carries the earlier limits (#3933 round 4/5).
       */
      earlierLimits?: true
      /** `revoke_unfinished` only: whether the edit that left it MOVED the recipient (the old rows then still pay, in Haven too). */
      moved?: boolean
      /** `revoke_unfinished` only: the old budget's rows still to Stop. */
      unstoppedDelegationHashes?: string[]
    }

/**
 * #3930: the slot identity the retry guard keys on — the SAME (token,
 * recipient) slot the backend's pending-row reuse and its activate-time sweep
 * use. Both are lower-cased: hashes and addresses are compared
 * case-insensitively everywhere on this path.
 */
function slotKey(tokenAddress: string, recipientAddress?: string | null): string {
  return `${tokenAddress.toLowerCase()}:${(recipientAddress ?? '').toLowerCase()}`
}

/**
 * #3930: the outcome of re-reading ONE attempted delegation hash from the
 * plain `GET /agents/:id/delegations` list. `absent` (no row for the hash) is
 * distinct from `read_failed` (the GET itself threw) — both mean the outcome
 * is unproven, but tests pin them separately.
 */
type AttemptedHashReread =
  | { kind: 'row'; status: DelegationBudget['status'] }
  | { kind: 'absent' }
  | { kind: 'read_failed' }

/** The activation committed (or was swept there): the grant is live. */
function rereadLanded(r: AttemptedHashReread): boolean {
  return r.kind === 'row' && (r.status === 'active' || r.status === 'replaced')
}

/**
 * #3930: what the pre-build retry guard decided for this slot. `proceed`
 * covers both "nothing remembered" and "the remembered attempt is
 * definitively dead" — a fresh `/build` is safe in both. `landed` carries the
 * hash that committed; `unconfirmed` means still unknown.
 */
type RetryGuardOutcome =
  | { outcome: 'proceed' }
  | { outcome: 'landed'; hash: string }
  | { outcome: 'unconfirmed' }

async function signTyped(
  signer: NonNullable<ReturnType<typeof useActiveSigner>>,
  payload: TypedDataPayload,
): Promise<`0x${string}`> {
  if (signer.type !== 'eoa') {
    // Owner EIP-712 signing over the account payload needs a wallet client;
    // passkey-owner budget signing lands with #836's recovery/WebAuthn work.
    throw new Error('Connect your account owner wallet to set or stop a budget.')
  }
  // ethers/wallet derives EIP712Domain itself; strip it if present.
  const types = { ...payload.types }
  delete (types as Record<string, unknown>).EIP712Domain
  return signer.walletClient.signTypedData({
    account: signer.address,
    domain: payload.domain,
    types,
    primaryType: payload.primaryType,
    message: payload.message,
  } as never)
}

export function useDelegationBudget(
  agentId: string,
  chainId: number,
  {
    enabled = true,
    includeRemaining = false,
  }: {
    enabled?: boolean
    /**
     * #3695: ask `GET /agents/:id/delegations` for remaining-this-period
     * (`?include=remaining`, #3693). Off by default: that read costs a chain
     * RPC per active row server-side, this hook polls, and only the agent
     * page's budget card renders the figure. The other callers (connect,
     * remove, fund-merchant, edit) keep the plain, poller-cheap read.
     */
    includeRemaining?: boolean
  } = {},
) {
  const [budgets, setBudgets] = useState<DelegationBudget[] | null>(null)
  const [signers, setSigners] = useState<AccountSigners | null>(null)
  const [signersError, setSignersError] = useState(false)
  const [budgetsError, setBudgetsError] = useState(false)
  const [busy, setBusy] = useState(false)
  // #3331 review finding F4, corrected round 3 (doc F7): a caller can switch
  // WHICH agent this same mounted hook instance is scoped to
  // (`FundMerchantModal`'s agent picker) — a monotonic counter per read,
  // bumped every time `reload`/`reloadSigners` actually runs, so a response
  // for a PREVIOUS agentId that resolves after a newer request started is
  // discarded rather than overwriting fresh state with stale data. Both reads
  // (`/agents/:id/delegations`, `/agents/:id/account-signers`) are keyed on
  // agentId ONLY, never chainId — see the reset effect below. Two independent
  // counters: a budgets read and a signer-set read can be in flight on
  // different schedules (polling reloads only the former).
  const budgetsGeneration = useRef(0)
  const signersGeneration = useRef(0)
  // R2-4: a background silent poll and a manual (non-silent) `reload()` share
  // the same generation counter above — without this flag, a poll tick that
  // starts WHILE a manual retry is in flight bumps the generation past the
  // manual call's `mine`, so the manual call's own (possibly successful)
  // result is discarded as "stale" the moment it resolves — even though nothing
  // else answered in between with fresher data. A manual reload is a direct
  // response to the owner clicking Try again; it must never lose to a poll
  // tick that fired for no reason the owner asked for. Silent ticks simply
  // skip themselves while a manual reload is in flight (rather than racing it) —
  // the next poll a few seconds later covers the same ground.
  //
  // #3331 round 3 finding F4: a COUNTER, not a boolean — a second manual
  // reload can start before the first one's `finally` runs (a fast double
  // click on "Try again", or two callers of this same hook instance sharing
  // one agent). A boolean here would read `false` the instant either manual
  // call finished, letting a poll tick through and race the OTHER manual call
  // still in flight; the counter only reaches zero once every overlapping
  // manual call has finished, so polls stay suppressed for the whole window.
  const manualBudgetsReloadInFlight = useRef(0)
  // #3930: the last hash whose activation was ATTEMPTED but left `unconfirmed`,
  // per (token, recipient) slot. The re-read after a lost activate POST can see
  // `pending` while the backend is still deploying, and the commit can land
  // later — so the NEXT /build for the same slot re-reads this hash BEFORE
  // minting a new one, so a landed attempt is reported as landed (before
  // #3933 the retry also added a second enabled grant; the backend now
  // refuses one in an occupied slot, #3971). Cleared when
  // the agent changes (the reset effect below): hashes are agent-scoped.
  const lastAttempted = useRef(new Map<string, string>())
  // #3933: an `unconfirmed` EDIT remembers its own attempt, keyed by the
  // budget it edits — never by slot, so a landed attempt is only ever taken
  // for the edit of THAT budget (round-3 review: a slot-keyed memory let an
  // edit of an unrelated budget, or of the landed grant itself, adopt the
  // attempt and Stop the wrong rows). It holds the old rows the attempt was
  // going to Stop: on the retry that finds the grant landed, the loaded list
  // has moved on — the new grant is the slot's active row and the old rows
  // read `replaced` — so recomputing the set from it would Stop the owner's
  // NEW budget and miss a re-key's steady half. `inputKey` is the limits the
  // attempt asked for: a retry asking for different ones must not report
  // them as live. No slot-keyed `lastAttempted` entry is written for an edit:
  // since #3933 the backend refuses a second grant into a slot whose live
  // rows it does not name, so a late commit cannot mint a second budget.
  const editAttempts = useRef(new Map<string, { newHash: string; stopSet: string[]; inputKey: string; moved: boolean }>())
  // The ACCOUNT address scopes the signer lookup (#1079): without it the
  // stored-passkey/hybrid branches are unreachable and `ready` would depend
  // on any globally-connected wallet with no per-account check.
  const signer = useActiveSigner({
    accountAddress: signers ? (signers.account_address as Address) : undefined,
    chainId,
  })

  // A failed budget fetch is RETRYABLE, exactly like the signer set below
  // (#2473): it used to collapse into `budgets === null`, which the card
  // reads as "still loading" and renders as nothing at all — so an API
  // failure looked identical to a first paint, and the page's "Add budget"
  // button scrolled to an empty div with no error anywhere.
  //
  // #2732: the `silent` variant (visible-only polling) must change no visible
  // state on a failed tick — `setBudgetsError(true)` flips the card to its
  // error branch, and one swallowed 500 mid-demo would wipe the budget rows
  // the presenter is pointing at. Success still refreshes the rows and
  // clears a stale error flag.
  const reload = useCallback(
    async (silent = false) => {
      if (!enabled) return
      // R2-4: never let a background poll tick race an in-flight manual
      // reload — see the ref's own comment above.
      if (silent && manualBudgetsReloadInFlight.current > 0) return
      if (!silent) manualBudgetsReloadInFlight.current += 1
      const mine = ++budgetsGeneration.current
      try {
        // #3693 (corrected body): remaining-this-period is OPT-IN, per caller
        // (#3695) — the plain read is the poller-cheap shape (no chain RPC
        // server-side).
        const res = await api.get<{ delegations: DelegationBudget[] }>(
          `/agents/${agentId}/delegations${includeRemaining ? '?include=remaining' : ''}`,
        )
        if (mine !== budgetsGeneration.current) return // a newer read has since started (F4)
        // `?? []` — an absent key must degrade, not crash the route (#3093).
        setBudgets(res.delegations ?? [])
        setBudgetsError(false)
      } catch {
        if (mine !== budgetsGeneration.current) return
        if (silent) return
        setBudgets(null)
        setBudgetsError(true)
      } finally {
        // #3331 round 3 finding F3: cleared here — in `finally`, on BOTH the
        // success and failure paths — so a manual reload that rejects does
        // not leave polling suppressed forever; only the success branch was
        // ever exercised by the pre-existing test, which is why the earlier
        // shape (a plain assignment reachable from either path) was never
        // proven to cover the failure path until this round's test did.
        if (!silent) manualBudgetsReloadInFlight.current -= 1
      }
    },
    [agentId, enabled, includeRemaining],
  )

  // The signer set feeds pickSigningPath (#1086): the DEVICE picks which of
  // the account's signers to use — never the account's shape. A failed fetch
  // is RETRYABLE (#1079): it sets an error flag instead of stranding the hook
  // at a permanent null.
  const reloadSigners = useCallback(async () => {
    if (!enabled) return
    const mine = ++signersGeneration.current
    try {
      const res = await api.get<AccountSigners>(`/agents/${agentId}/account-signers`)
      if (mine !== signersGeneration.current) return // a newer read has since started (F4)
      // `passkeys ?? []` — `pickSigningPath` reads `.length` during render;
      // an answer without the array must degrade, not crash the route (#3093).
      setSigners({ ...res, passkeys: res.passkeys ?? [] })
      setSignersError(false)
    } catch {
      if (mine !== signersGeneration.current) return
      setSigners(null)
      setSignersError(true)
    }
  }, [agentId, enabled])

  // ── #3930: re-reading a lost activate response ───────────────────────────
  // The activate route commits in ONE transaction and answers `{ activated:
  // true }`; if the browser never receives that response, the grant may still
  // have LANDED. Before reporting anything, the hook re-reads the outcome from
  // the plain delegations list — deliberately a DIRECT `api.get` and not
  // `reload()`: `reload` swallows its errors and returns nothing, so a failed
  // re-read would be indistinguishable from "no row". Deliberately the PLAIN
  // read, never `?include=remaining`: this path needs only each row's status,
  // and the remaining variant costs a chain RPC per active row server-side.
  const readAttemptedHash = useCallback(
    async (hash: string): Promise<AttemptedHashReread> => {
      try {
        const res = await api.get<{ delegations?: Array<Pick<DelegationBudget, 'delegation_hash' | 'status'>> }>(
          `/agents/${agentId}/delegations`,
        )
        const row = (res.delegations ?? []).find(
          (d) => d.delegation_hash.toLowerCase() === hash.toLowerCase(),
        )
        return row ? { kind: 'row', status: row.status } : { kind: 'absent' }
      } catch {
        return { kind: 'read_failed' }
      }
    },
    [agentId],
  )

  /**
   * #3930 retry guard: the last attempt for this slot ended `unconfirmed` —
   * re-read that hash BEFORE a new `/build`, so a landed attempt is not
   * reported as a fresh failure (since #3933 the backend refuses a second
   * live grant in the slot; before it, the retry minted one). `proceed` covers both "nothing remembered" and "the remembered
   * attempt is definitively dead" (`revoked`, or the row is gone) — a fresh
   * build is safe in both. `unconfirmed` keeps the entry: still unknown, and
   * a build would risk the second grant.
   */
  const guardRetriedSlot = useCallback(
    async (input: GrantInput): Promise<RetryGuardOutcome> => {
      const key = slotKey(input.tokenAddress, input.recipientAddress)
      const remembered = lastAttempted.current.get(key)
      if (remembered === undefined) return { outcome: 'proceed' }
      const reread = await readAttemptedHash(remembered)
      if (rereadLanded(reread)) {
        lastAttempted.current.delete(key)
        return { outcome: 'landed', hash: remembered }
      }
      if (reread.kind === 'row' && reread.status === 'pending') return { outcome: 'unconfirmed' }
      if (reread.kind === 'read_failed') return { outcome: 'unconfirmed' }
      lastAttempted.current.delete(key)
      return { outcome: 'proceed' }
    },
    [readAttemptedHash],
  )

  /**
   * #3933: the old rows an edit of `oldDelegationHash` will Stop — the set an
   * `unconfirmed` edit of this budget remembered (the list may already show
   * its new grant as the slot's live row), otherwise the slot's live rows.
   * The review copy's signature count and the Stop loop read the same set.
   */
  const editStopSet = useCallback(
    (oldDelegationHash: string, oldSlot: BudgetSlot, nowSec: number): string[] =>
      editAttempts.current.get(oldDelegationHash.toLowerCase())?.stopSet ??
      slotOccupantHashesForEdit(budgets, oldDelegationHash, oldSlot, nowSec),
    [budgets],
  )

  /**
   * #3933: whether `hash` is the grant an `unconfirmed` edit of
   * `oldDelegationHash` made — that edit's own attempt, not another budget.
   */
  const isOwnAttemptedGrant = useCallback(
    (hash: string, oldDelegationHash: string): boolean =>
      editAttempts.current.get(oldDelegationHash.toLowerCase())?.newHash.toLowerCase() === hash.toLowerCase(),
    [],
  )

  useEffect(() => {
    if (!enabled) {
      setBudgets(null)
      setBudgetsError(false)
      setSigners(null)
      setSignersError(false)
      setBusy(false)
      return
    }
    void reload()
    void reloadSigners()
  }, [enabled, reload, reloadSigners])

  // #3331 review finding F4 (R2-1 correction): reset IMMEDIATELY when the
  // AGENT changes — while the hook stays enabled (a caller that switches
  // agent mid-flow inside one mounted hook, e.g. `FundMerchantModal`'s agent
  // picker). Without this, the previous agent's budgets/signer set (and
  // therefore `ready`/`signingPath`) stay loaded — and actionable — for
  // the whole round trip of the new read, which is exactly the "signs with
  // the wrong agent's data" risk on a money path. `reload`/`reloadSigners`
  // above already refetch on this same change (their identity depends on
  // `agentId`); this only clears what a render can see in between.
  //
  // Deliberately NOT `chainId`: `/agents/:id/delegations` and
  // `/agents/:id/account-signers` are not chain-scoped — a chainId-only
  // rerender (same agent, network switch) must keep the already-loaded
  // budgets/signers on screen (and `ready` true) rather than blanking them
  // for no data reason. `useActiveSigner` above still re-derives the signing
  // path for the new chain from the SAME signer set.
  useEffect(() => {
    if (!enabled) return
    setBudgets(null)
    setBudgetsError(false)
    setSigners(null)
    setSignersError(false)
    // #3930: remembered attempted hashes are agent-scoped — a caller that
    // switches WHICH agent this instance serves must not re-read the previous
    // agent's hash (it would come back absent and the guard would just
    // fall through, but the state is stale regardless).
    lastAttempted.current.clear()
    editAttempts.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately NOT `enabled`/`chainId`: the effect above already resets on enable/disable; chainId is not part of this hook's read scope (see comment above).
  }, [agentId])

  // #2732 visible-only polling — budgets only. The signer set is a DEVICE
  // fact, not payment state; polling it every 10s would churn the signing
  // path under an active grant/revoke ceremony. Only `reload` is silent;
  // grant/revoke/revokeAll keep calling `reload()` non-silently after they
  // mutate, so their error surfaces are unchanged.
  useVisiblePolling(() => {
    void reload(true)
  })

  // The signing path is a DEVICE decision, not an account-shape decision:
  // an account with both an owner and passkeys signs with whichever is
  // reachable here (passkey preferred).
  const signingPath = pickSigningPath(signers, signer?.type === 'eoa' ? signer.address : null)

  const grant = useCallback(
    async (input: GrantInput): Promise<GrantResult> => {
      setBusy(true)
      try {
        // #3930 retry guard — BEFORE any /build. The previous attempt for this
        // slot may have ended `unconfirmed`; re-read it first, so a landed
        // attempt is reported as landed (the backend, since #3933, refuses a
        // SECOND live grant in the slot — before it, this retry minted one).
        const guard = await guardRetriedSlot(input)
        if (guard.outcome === 'landed') {
          await reload()
          return { ok: true }
        }
        if (guard.outcome === 'unconfirmed') return { ok: false, reason: 'unconfirmed' }
        let built: BuildResponse
        try {
          built = await api.post<BuildResponse>(`/agents/${agentId}/delegations/build`, {
            token_address: input.tokenAddress,
            recipient_address: input.recipientAddress ?? null,
            budget_atomic: input.budgetAtomic,
            period_seconds: input.periodSeconds,
            ...(input.merchantSlug ? { merchant_slug: input.merchantSlug } : {}),
          })
        } catch (err) {
          // #3933: the slot already holds a live budget — a plain grant is
          // refused before anything is signed. Refresh the list so the caller
          // can find `existingDelegationHash` in it and route to the edit flow.
          const occupied = slotOccupiedFrom(err)
          if (occupied) {
            await reload()
            return occupied
          }
          // Named build refusals (revoked agent, re-key in flight, off-rail
          // account, and — #3331 — the merchant-locked refusals) carry the
          // backend's own sentence; pass it through instead of the generic
          // failure, exactly as `editBudget` already does for its build step.
          if (err instanceof Error && err.message.trim()) {
            return { ok: false, reason: 'refused', detail: err.message }
          }
          throw err
        }
        let signature: string
        if (signingPath === 'passkey' && signers) {
          // ONE passkey ceremony — the kit signs the delegation itself; the
          // typed-data message IS the delegation (#828's payload).
          const { signDelegationWithPasskey } = await import('@/lib/delegationPasskeySigner')
          signature = await signDelegationWithPasskey(
            signers,
            built.signing_payload.message as unknown as DelegationMessage,
          )
        } else {
          if (!signer) return { ok: false, reason: 'failed' }
          signature = await signTyped(signer, built.signing_payload)
        }
        try {
          await api.post(`/agents/${agentId}/delegations/${built.delegation_hash}/activate`, { signature })
        } catch (err) {
          // #3933: the slot filled between build and activate. The route
          // refused under the agent lock and wrote nothing — a DEFINITE
          // answer, so no re-read and no remembered attempt (remembering this
          // still-pending hash would turn every retry into `unconfirmed`).
          const occupied = slotOccupiedFrom(err)
          if (occupied) {
            await reload()
            return occupied
          }
          // #3930: the response was lost — the activation may still have
          // committed (the counterfactual deploy is the slow path). Re-read
          // the outcome BEFORE reporting anything: a false `failed` tells the
          // owner nothing was granted when it may be live (#3971: the retry it
          // invites is refused by the backend since #3933, not a second grant).
          if (cancelled(err)) return { ok: false, reason: 'cancelled' }
          const reread = await readAttemptedHash(built.delegation_hash)
          if (rereadLanded(reread)) {
            await reload()
            return { ok: true }
          }
          if (reread.kind === 'row' && reread.status === 'revoked') {
            // Revoke-all raced the activation: nothing is live, nothing will be.
            return { ok: false, reason: 'failed' }
          }
          // `pending` (the commit can still land), the row absent, or the
          // re-read itself failed: the outcome is UNKNOWN — remember the hash
          // so the retry re-reads it before building, and never report
          // "nothing was granted".
          lastAttempted.current.set(slotKey(input.tokenAddress, input.recipientAddress), built.delegation_hash)
          return { ok: false, reason: 'unconfirmed' }
        }
        await reload()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, signingPath, reload, signer, signers, guardRetriedSlot, readAttemptedHash],
  )

  // #3933: one Stop of the edit flow — the per-hash revoke prepare, ONE owner
  // signature, submit. `already` is the route's already-done 409 (revoked, or
  // disabled on-chain and healed): the goal is met, nothing was signed.
  // Anything else short of a submitted Stop is `unfinished` — never thrown,
  // because the new grant is already live and only the partial state is true.
  const stopOldDelegation = useCallback(
    async (hash: string): Promise<'signed' | 'already' | 'unfinished'> => {
      let prep: RevokePrepare
      try {
        prep = await api.post<RevokePrepare>(`/agents/${agentId}/delegations/${hash}/revoke`, {
          signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
        })
      } catch (err) {
        return isAlreadyRevoked(err) ? 'already' : 'unfinished'
      }
      let signature: string
      try {
        if (prep.signature_scheme === 'webauthn_userop') {
          if (!signers) return 'unfinished'
          // ONE passkey ceremony — the account signs its own UserOperation.
          const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
          signature = await signUserOpWithPasskey(signers, prep.user_operation as Record<string, unknown>)
        } else {
          if (!signer || !prep.signing_payload) return 'unfinished'
          signature = await signTyped(signer, prep.signing_payload)
        }
      } catch {
        // A cancelled or failed STOP signature is not the generic outcome:
        // the new grant is already live.
        return 'unfinished'
      }
      try {
        await api.post(`/agents/${agentId}/delegations/${hash}/revoke/submit`, {
          signature,
          user_operation: prep.user_operation,
        })
      } catch {
        return 'unfinished'
      }
      return 'signed'
    },
    [agentId, signer, signers, signingPath],
  )

  // ── Edit budget limits in place (#3166) ──────────────────────────────────
  // REPLACE = grant(new) + revoke(old) — the composition the lifecycle API's
  // header comment defines. The DELEGATE KEY AND LOCAL SIGNER ARE NEVER
  // TOUCHED: both signatures below are OWNER signatures made client-side, and
  // no rotate/rekey endpoint is ever called. Ordering is activate-then-revoke,
  // deliberately: Haven cannot revoke on its own (the revoke UserOp needs an
  // owner signature), and revoking first would leave the agent with NO budget
  // if the new grant is abandoned — the issue's own criterion forbids that.
  // Once the owner signs the new delegation, activation retires the old grant
  // in Haven's mirror atomically (`activatePendingDelegationInSlot`); the
  // follow-up revoke kills it on-chain. Between the two signatures the two
  // grants briefly coexist on-chain (combined exposure = their sum, each
  // caveat-enforced) — that window is stated in the UI copy.
  //
  // Failure shapes, all leaving the old budget live and untouched:
  // - build refused (revoked agent, rekey in flight, off-rail account): the
  //   backend's named 409 travels as `refused`.
  // - new-grant signature cancelled or failed: nothing was granted, nothing
  //   was revoked (`cancelled` / `failed`).
  // - the activate response was LOST (#3930): the hook re-reads the outcome
  //   before reporting. The new grant landed → the Stop step runs as if the
  //   POST had returned; a revoke-all raced it → `failed`; still `pending`,
  //   absent, or the re-read itself failed → `unconfirmed` (NEVER "nothing
  //   was granted" — the old budget may already be `replaced`).
  // - activation raced a revoke-all: the 409 "no longer pending" is re-read
  //   like any other activate failure (#3930) — `failed` when the row shows
  //   `revoked`, the Stop step when it shows `active`/`replaced`.
  // - the old budget was ALREADY revoked by the time the stop signature is
  //   asked for (the same revoke-all race, other side): the goal — old grant
  //   dead — is already met, so the flow reports success.
  // - #3933: build and activate both carry `replaces`. The backend refuses a
  //   plain grant into an occupied slot (409 BUDGET_SLOT_OCCUPIED), because
  //   only this composition stops the old grant on-chain. If `replaces` no
  //   longer names the slot's live budgets (one was replaced since the modal
  //   opened), the same 409 travels as `slot_occupied`, and nothing was
  //   written.
  // - #3933 review finding 1: `replaces` names EVERY live row in the edited
  //   budget's slot, not only `oldDelegationHash` — a budget carried through
  //   "Replace signing key" is a carry/steady pair, activate marks every
  //   active row in the slot `replaced`, and the backend accepts the edit only
  //   when `replaces` names exactly those rows. The Stop step then stops each
  //   of them, one owner signature apiece, so the set stopped is the set
  //   swept. A Stop that does not finish ends the flow in `revoke_unfinished`
  //   with the rows still to stop.
  // - #3933 review finding 2: an edit that changes the recipient MOVES to
  //   another slot. Activate's sweep is scoped to the new slot, so it retires
  //   nothing in the old one: the edited budget stays `active` (Haven still
  //   uses it) until its Stop lands. So a move sends no `replaces` (the new
  //   slot must be empty, and the backend refuses it otherwise), and then
  //   Stops the old slot's rows exactly as a same-slot edit does. If the new
  //   slot already holds a live budget the result is `target_slot_occupied` —
  //   before any signature when the loaded list shows it, or from the
  //   backend's 409 when the list was stale.
  const editBudget = useCallback(
    async (
      oldDelegationHash: string,
      input: GrantInput,
      opts: {
        expiresAt?: number
        /**
         * The edited budget's (token, recipient) slot. Read from the loaded
         * list when omitted, and assumed to be the new grant's slot when the
         * list does not hold the row either.
         */
        oldSlot?: BudgetSlot
      } = {},
    ): Promise<EditBudgetResult> => {
      setBusy(true)
      try {
        const nowSec = Math.floor(Date.now() / 1000)
        const newSlot: BudgetSlot = { tokenAddress: input.tokenAddress, recipientAddress: input.recipientAddress }
        const oldRow = (budgets ?? []).find((b) => b.delegation_hash.toLowerCase() === oldDelegationHash.toLowerCase())
        const oldSlot: BudgetSlot =
          opts.oldSlot ??
          (oldRow ? { tokenAddress: oldRow.token_address, recipientAddress: oldRow.recipient_address } : newSlot)
        const moved = !sameSlot(oldSlot, newSlot)
        const editKey = oldDelegationHash.toLowerCase()
        const inputKey = JSON.stringify([
          slotKey(input.tokenAddress, input.recipientAddress),
          input.budgetAtomic,
          input.periodSeconds,
          input.merchantSlug ?? null,
          opts.expiresAt ?? null,
        ])
        // A 409 BUDGET_SLOT_OCCUPIED is about the slot the grant goes INTO:
        // for a move, that is the target slot, not the edited budget.
        const occupiedResult = (err: unknown): EditBudgetResult | null => {
          const occupied = slotOccupiedFrom(err)
          if (!occupied) return null
          return moved ? { ...occupied, reason: 'target_slot_occupied' } : occupied
        }

        // #3930 retry, for THIS budget's edit only — BEFORE any /build. When
        // the remembered attempt has landed, the new grant IS that hash: skip
        // build/sign/activate and go straight to the Stop step with the set
        // the attempt computed, as if the lost POST had just returned.
        let newHash: string | null = null
        let oldBudgetHashes: string[] | null = null
        const attempt = editAttempts.current.get(editKey)
        if (attempt) {
          const reread = await readAttemptedHash(attempt.newHash)
          if (rereadLanded(reread)) {
            editAttempts.current.delete(editKey)
            // The earlier attempt replaced this budget: nothing new is built,
            // and its Stops are owed whatever this call asks for (the owner
            // signed that replacement; its old rows are `replaced` — or, for
            // a move, still active — and enabled on-chain). They are NOT
            // signed in this click: the review step described a grant, not
            // Stops (#3933 round 5). The result is the partial state, so the
            // modal names what is live and offers the Stop, saying how many
            // signatures it takes, before any is asked for.
            await reload()
            return {
              ok: false,
              reason: 'revoke_unfinished',
              newDelegationHash: attempt.newHash,
              unstoppedDelegationHashes: attempt.stopSet,
              moved: attempt.moved,
              ...(attempt.inputKey !== inputKey ? { earlierLimits: true as const } : {}),
            }
          } else if ((reread.kind === 'row' && reread.status === 'pending') || reread.kind === 'read_failed') {
            return { ok: false, reason: 'unconfirmed' }
          } else {
            // Revoked or gone: the attempt is dead, and the old budget is what
            // it was. Build fresh from the current list.
            editAttempts.current.delete(editKey)
          }
        }
        if (newHash === null) {
          // The old budget's rows: what a same-slot edit names as `replaces`
          // (and activate sweeps), and what every edit then Stops.
          const stopSet = slotOccupantHashesForEdit(budgets, oldDelegationHash, oldSlot, nowSec)
          oldBudgetHashes = stopSet
          const replaces = moved ? {} : { replaces: stopSet }
          if (moved) {
            // Finding 2's pre-check: the chosen recipient already has a live
            // budget for this token. Nothing is built or signed.
            const occupant = findOccupyingBudget(budgets, newSlot, nowSec)
            if (occupant) {
              return { ok: false, reason: 'target_slot_occupied', existingDelegationHash: occupant.delegation_hash }
            }
          }
          let built: BuildResponse
          try {
            built = await api.post<BuildResponse>(`/agents/${agentId}/delegations/build`, {
              token_address: input.tokenAddress,
              recipient_address: input.recipientAddress ?? null,
              budget_atomic: input.budgetAtomic,
              period_seconds: input.periodSeconds,
              // #3331 review finding F3: a merchant-locked budget's edit-in-place
              // must keep naming the merchant — omitting this silently turned the
              // replacement into a plain pinned budget (the label lost, the row
              // dropped out of the merchant page) the moment `EditBudgetModal`
              // wired an `input.merchantSlug` through.
              ...(input.merchantSlug ? { merchant_slug: input.merchantSlug } : {}),
              ...(opts.expiresAt !== undefined ? { expires_at: opts.expiresAt } : {}),
              // #3933: the edit flow's declaration. Without it the backend
              // refuses a grant into this (occupied) slot; with it, the route
              // checks it names exactly the slot's live budgets.
              ...replaces,
            })
          } catch (err) {
            // #3933: `replaces` no longer names the slot's live budgets, or
            // (a move) the target slot is occupied. Nothing was written.
            const occupied = occupiedResult(err)
            if (occupied) return occupied
            // The build refusals are named 409s the owner can act on — pass the
            // backend's own sentence through instead of a generic failure.
            if (err instanceof Error && err.message.trim()) {
              return { ok: false, reason: 'refused', detail: err.message }
            }
            throw err
          }
          const builtHash = built.delegation_hash
          newHash = builtHash
          let grantSignature: string
          if (signingPath === 'passkey' && signers) {
            // ONE passkey ceremony — the kit signs the delegation itself; the
            // typed-data message IS the delegation (#828's payload).
            const { signDelegationWithPasskey } = await import('@/lib/delegationPasskeySigner')
            grantSignature = await signDelegationWithPasskey(
              signers,
              built.signing_payload.message as unknown as DelegationMessage,
            )
          } else {
            if (!signer) return { ok: false, reason: 'failed' }
            grantSignature = await signTyped(signer, built.signing_payload)
          }
          try {
            await api.post(`/agents/${agentId}/delegations/${builtHash}/activate`, {
              signature: grantSignature,
              // #3933: named on activate too — the route re-checks it under
              // the agent lock, because the slot can change after build.
              ...replaces,
            })
          } catch (err) {
            // #3933: refused under the lock, nothing written — a definite
            // answer, never the #3930 re-read (which would see `pending` and
            // remember the hash, turning every retry into `unconfirmed`).
            const occupied = occupiedResult(err)
            if (occupied) return occupied
            // #3930: the response was lost — re-read before reporting anything,
            // exactly as `grant` does. The new grant may already be live (and
            // the old one already `replaced` in the mirror): telling the owner
            // "nothing was granted" here is false.
            if (cancelled(err)) return { ok: false, reason: 'cancelled' }
            const reread = await readAttemptedHash(builtHash)
            if (rereadLanded(reread)) {
              // The new grant is live — fall through to the Stop step as if
              // the POST had returned.
            } else if (reread.kind === 'row' && reread.status === 'revoked') {
              // Revoke-all raced the activation: nothing was granted, and the
              // old budget is exactly what it was.
              return { ok: false, reason: 'failed' }
            } else {
              // `pending` (the commit can still land), the row absent, or the
              // re-read itself failed: the outcome is UNKNOWN — remember the
              // hash so the retry re-reads it before building. NEVER "nothing
              // was granted".
              editAttempts.current.set(editKey, { newHash: builtHash, stopSet, inputKey, moved })
              return { ok: false, reason: 'unconfirmed' }
            }
          }
        }
        // The new grant is live and (same slot) the old rows are retired in
        // the mirror. Kill each on-chain with ONE more owner signature apiece,
        // stopping at the first that does not finish: the owner who cancels
        // one Stop is not asked for the next one straight away.
        const toStop = oldBudgetHashes ?? []
        let signedAny = false
        for (let i = 0; i < toStop.length; i++) {
          const stop = await stopOldDelegation(toStop[i])
          if (stop === 'unfinished') {
            // The new grant is LIVE; only the on-chain stop of the old rows
            // is unfinished. Report the partial state honestly so the UI can
            // tell the owner to finish it, naming the rows still to stop.
            return {
              ok: false,
              reason: 'revoke_unfinished',
              newDelegationHash: newHash,
              unstoppedDelegationHashes: toStop.slice(i),
              moved,
            }
          }
          if (stop === 'signed') signedAny = true
        }
        await reload()
        // `oldDelegationRevoked: false` only when every row was ALREADY
        // stopped (a concurrent revoke-all or the reconciliation heal got
        // there first) — the goal is met, nothing was signed for it.
        return { ok: true, newDelegationHash: newHash, oldDelegationRevoked: signedAny }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [
      agentId,
      budgets,
      signingPath,
      reload,
      signer,
      signers,
      readAttemptedHash,
      stopOldDelegation,
    ],
  )

  const revoke = useCallback(
    async (delegationHash: string): Promise<BudgetResult> => {
      setBusy(true)
      try {
        // Tell the backend which signer this device will use — the prepared
        // op's gas estimation is shaped by the signature kind, and the server
        // cannot know what is available here.
        let prep: RevokePrepare
        try {
          prep = await api.post<RevokePrepare>(`/agents/${agentId}/delegations/${delegationHash}/revoke`, {
            signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
          })
        } catch (err) {
          // #3933: "Already revoked" is the route's already-done answer — the
          // row is revoked, or the chain shows it disabled and the route
          // healed the record. A Stop whose goal is met is finished, not
          // failed: this is what makes the replaced-budget finish action safe
          // on a row that was stopped out-of-band.
          if (isAlreadyRevoked(err)) {
            await reload()
            return { ok: true, alreadyStopped: true }
          }
          throw err
        }
        let signature: string
        if (prep.signature_scheme === 'webauthn_userop') {
          if (!signers) return { ok: false, reason: 'failed' }
          // ONE passkey ceremony — the account signs its own UserOperation.
          const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
          signature = await signUserOpWithPasskey(
            signers,
            prep.user_operation as Record<string, unknown>,
          )
        } else {
          if (!signer || !prep.signing_payload) return { ok: false, reason: 'failed' }
          signature = await signTyped(signer, prep.signing_payload)
        }
        await api.post(`/agents/${agentId}/delegations/${delegationHash}/revoke/submit`, {
          signature,
          user_operation: prep.user_operation,
        })
        await reload()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, reload, signer, signers, signingPath],
  )

  // #1402/#1400: ONE signature kills every live (pending/active/replaced) budget. Mirrors
  // `revoke` exactly; the 409 'Nothing to revoke' is SUCCESS here — it means
  // step 1 of the remove flow is already satisfied (never granted, or a
  // prior partial remove already killed the budgets), so a retry can finish
  // the filing steps.
  const revokeAll = useCallback(async (): Promise<BudgetResult> => {
    setBusy(true)
    try {
      let prep: RevokeAllPrepare
      try {
        prep = await api.post<RevokeAllPrepare>(`/agents/${agentId}/delegations/revoke-all`, {
          signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
        })
      } catch (err) {
        if (err instanceof Error && /nothing to revoke/i.test(err.message)) {
          return { ok: true }
        }
        // #1437: the batch/reconcile refusals are recoverable and name their
        // own remedy — surface them as such instead of "the budget could not
        // be stopped", which tells the user nothing they can act on.
        if (err instanceof Error && /too many delegations/i.test(err.message)) {
          return { ok: false, reason: 'too_many' }
        }
        throw err
      }
      let signature: string
      if (prep.signature_scheme === 'webauthn_userop') {
        if (!signers) return { ok: false, reason: 'failed' }
        const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
        signature = await signUserOpWithPasskey(
          signers,
          prep.user_operation as Record<string, unknown>,
        )
      } else {
        if (!signer || !prep.signing_payload) return { ok: false, reason: 'failed' }
        signature = await signTyped(signer, prep.signing_payload)
      }
      await api.post(`/agents/${agentId}/delegations/revoke-all/submit`, {
        signature,
        user_operation: prep.user_operation,
        delegation_hashes: prep.delegation_hashes,
      })
      await reload()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
    } finally {
      setBusy(false)
    }
  }, [agentId, reload, signer, signers, signingPath])

  // Ready: some signer for this account is reachable from THIS device — a
  // passkey enrolled here, or the connected owner wallet.
  return {
    budgets,
    grant,
    editBudget,
    editStopSet,
    isOwnAttemptedGrant,
    revoke,
    revokeAll,
    busy,
    ready: signingPath !== null,
    // #3542 review: `ready` reads false while the signer set is still loading,
    // which is not the same as "this device cannot sign". Callers that act on
    // `!ready` wait on this first.
    signersLoading: signers === null && !signersError,
    // #3845: whether the signer set has ANY enrolled passkey, on any device
    // (the ceremony can hand off to another one). Null until the set is read,
    // so a caller never drops a passkey clause on a guess.
    hasPasskeys: signers ? signers.passkeys.length > 0 : null,
    // #3825: the #1097 cross-device heads-up, for the flows that sign
    // through this hook (the global wallet menu that disclosed it is gone).
    // #3825 design review: only when the PASSKEY will sign — with the owner
    // wallet connected the EOA path signs and nothing hands off.
    passkeyElsewhere: signingPath === 'passkey' && passkeyLikelyElsewhere(signers),
    reload,
    budgetsError,
    signersError,
    reloadSigners,
  }
}

/** The `error_code` the per-hash revoke prepare answers when the row is already revoked (#3933). */
export const DELEGATION_ALREADY_REVOKED = 'DELEGATION_ALREADY_REVOKED'

/**
 * #3933: the per-hash revoke prepare's already-done 409
 * (`routes/agent-delegations.ts`) — the row is revoked, or the chain shows it
 * disabled and the route healed the record. Read by its `error_code`, never by
 * message text; duck-typed for the same reason as `slotOccupiedFrom`.
 */
function isAlreadyRevoked(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const body = (err as { body?: unknown }).body
  if (!body || typeof body !== 'object') return false
  return (body as { error_code?: unknown }).error_code === DELEGATION_ALREADY_REVOKED
}

function cancelled(err: unknown): boolean {
  // The passkey path (ox SignFailedError wrapping a NotAllowedError
  // DOMException) is covered by the shared predicate — the #1076 regression.
  // The EOA wallet path additionally says "User rejected the request".
  if (isPasskeyCancellation(err)) return true
  const m = err instanceof Error ? err.message.toLowerCase() : ''
  return m.includes('rejected')
}
