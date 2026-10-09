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
   * #3693: remaining-this-period for ACTIVE rows. `remaining_from_chain: false`
   * means the on-chain read failed and `remaining_atomic` is the full budget.
   * All three are null for non-active rows.
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
 */
export type BudgetResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'failed' | 'too_many' | 'refused'; detail?: string }

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
 */
export type EditBudgetResult =
  | { ok: true; newDelegationHash: string; oldDelegationRevoked: boolean }
  | { ok: false; reason: 'cancelled' | 'failed' | 'refused' | 'revoke_unfinished'; detail?: string; newDelegationHash?: string }

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
    async (input: GrantInput): Promise<BudgetResult> => {
      setBusy(true)
      try {
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
        await api.post(`/agents/${agentId}/delegations/${built.delegation_hash}/activate`, { signature })
        await reload()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, signingPath, reload, signer, signers],
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
  // - activation raced a revoke-all: the 409 "no longer pending" surfaces as
  //   `failed` with the old state untouched (the grant did not land).
  // - the old budget was ALREADY revoked by the time the stop signature is
  //   asked for (the same revoke-all race, other side): the goal — old grant
  //   dead — is already met, so the flow reports success.
  const editBudget = useCallback(
    async (
      oldDelegationHash: string,
      input: GrantInput,
      opts: { expiresAt?: number } = {},
    ): Promise<EditBudgetResult> => {
      setBusy(true)
      try {
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
          })
        } catch (err) {
          // The build refusals are named 409s the owner can act on — pass the
          // backend's own sentence through instead of a generic failure.
          if (err instanceof Error && err.message.trim()) {
            return { ok: false, reason: 'refused', detail: err.message }
          }
          throw err
        }
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
          await api.post(`/agents/${agentId}/delegations/${built.delegation_hash}/activate`, {
            signature: grantSignature,
          })
        } catch (err) {
          // Nothing was granted — the old budget is exactly what it was.
          return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
        }
        // The new grant is live and the old one is retired in the mirror.
        // Kill it on-chain with ONE more owner signature.
        let prep: RevokePrepare
        try {
          prep = await api.post<RevokePrepare>(
            `/agents/${agentId}/delegations/${oldDelegationHash}/revoke`,
            { signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop' },
          )
        } catch (err) {
          // "Already revoked" means the goal is met (a concurrent revoke-all
          // or the reconciliation heal got there first) — not a failure.
          if (err instanceof Error && /already revoked/i.test(err.message)) {
            await reload()
            return { ok: true, newDelegationHash: built.delegation_hash, oldDelegationRevoked: false }
          }
          // The new grant is LIVE; only the on-chain stop of the old one is
          // unfinished. Report the partial state honestly so the UI can tell
          // the owner to finish it from the budget card's Stop button.
          return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
        }
        let revokeSignature: string
        try {
          if (prep.signature_scheme === 'webauthn_userop') {
            if (!signers) {
              return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
            }
            // ONE passkey ceremony — the account signs its own UserOperation.
            const { signUserOpWithPasskey } = await import('@/lib/delegationPasskeySigner')
            revokeSignature = await signUserOpWithPasskey(
              signers,
              prep.user_operation as Record<string, unknown>,
            )
          } else {
            if (!signer || !prep.signing_payload) {
              return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
            }
            revokeSignature = await signTyped(signer, prep.signing_payload)
          }
        } catch {
          // A cancelled or failed STOP signature is NOT the generic outcome:
          // the new grant is already live, so the partial state — not
          // "nothing changed" — is what the owner must be told.
          return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
        }
        try {
          await api.post(`/agents/${agentId}/delegations/${oldDelegationHash}/revoke/submit`, {
            signature: revokeSignature,
            user_operation: prep.user_operation,
          })
        } catch {
          // Same partial-state shape: new grant live, old grant still to stop.
          return { ok: false, reason: 'revoke_unfinished', newDelegationHash: built.delegation_hash }
        }
        await reload()
        return { ok: true, newDelegationHash: built.delegation_hash, oldDelegationRevoked: true }
      } catch (err) {
        return { ok: false, reason: cancelled(err) ? 'cancelled' : 'failed' }
      } finally {
        setBusy(false)
      }
    },
    [agentId, signingPath, reload, signer, signers],
  )

  const revoke = useCallback(
    async (delegationHash: string): Promise<BudgetResult> => {
      setBusy(true)
      try {
        // Tell the backend which signer this device will use — the prepared
        // op's gas estimation is shaped by the signature kind, and the server
        // cannot know what is available here.
        const prep = await api.post<RevokePrepare>(`/agents/${agentId}/delegations/${delegationHash}/revoke`, {
          signature_scheme: signingPath === 'passkey' ? 'webauthn_userop' : 'eip712_userop',
        })
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
    reload,
    budgetsError,
    signersError,
    reloadSigners,
  }
}

function cancelled(err: unknown): boolean {
  // The passkey path (ox SignFailedError wrapping a NotAllowedError
  // DOMException) is covered by the shared predicate — the #1076 regression.
  // The EOA wallet path additionally says "User rejected the request".
  if (isPasskeyCancellation(err)) return true
  const m = err instanceof Error ? err.message.toLowerCase() : ''
  return m.includes('rejected')
}
