'use client'

/**
 * "New account" — create an additional Haven account from a passkey the user
 * already holds (#4024, epic #4022 slice S2; owner decision 2026-10-16, route
 * B: the same passkey, a per-account deploy salt, no new passkey ceremony).
 *
 * The flow is one form and ONE passkey prompt:
 *
 * 1. The user names the account and picks a network (the chains the backend
 *    serves deploys on, `useDeployableChains` — the list signup offers).
 * 2. One WebAuthn ASSERTION (`navigator.credentials.get`, never `create`)
 *    restricted to the source account's passkeys, so the user picks the key
 *    with the device that holds it. Its credential id is the `key_id`.
 * 3. `POST /accounts/hybrid` with `{ source_account_id, key_id, chain_id,
 *    name, idempotency_key }` (#4023). The server copies that one passkey from
 *    the source account's stored signer set, so the new account's only signer
 *    is the passkey just used; it is never the default, and it starts with no
 *    agents and no budgets.
 * 4. The account list refreshes (`useAccounts().createAccount` re-reads the
 *    session payload), so the new card appears behind the dialog.
 *
 * What the assertion is and is not. The server checks that `key_id` is one of
 * the source account's passkeys; it does not receive or verify the assertion.
 * The session JWT is the authentication, and the assertion is the CHOICE of
 * key, made on the device that holds it. That is recorded in the delegation
 * rail security model (§ 6b) rather than implied here.
 *
 * Mounted only while open (`Modal` renders nothing when closed), so every open
 * starts from a clean form: no stale refusal, no reused idempotency key, no
 * in-flight flag carried over from a previous attempt.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAccounts } from '@/hooks/useAccounts'
import { useUserSigners } from '@/hooks/useUserSigners'
import { useDeployableChains } from '@/hooks/useDeployableChains'
import { getChainConfig } from '@/lib/chains'
import { getPasskeyAssertion, PasskeyUnsupportedError } from '@/lib/passkey'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import { rememberPasskeyCredentialOnDevice } from '@/lib/signer'
import {
  allowCredentialIdsFor,
  classifyCreateAccountError,
  defaultSource,
  findCreatedAccount,
  keyIdFromCredentialId,
  passkeySources,
  sourceChoiceMatters,
  sourceHoldsKey,
  submissionFingerprint,
  submissionFor,
  type CreateAccountRefusal,
  type PasskeySource,
  type PendingSubmission,
} from '@/lib/new-account'

export interface NewAccountDialogProps {
  open: boolean
  onClose: () => void
  /**
   * The account the caller is scoped to (an account page, #4021's tile). The
   * dialog starts on it when it has a passkey; otherwise on the default
   * account, otherwise on the first account that has one.
   */
  preferredSourceAccountId?: string | null
}

export default function NewAccountDialog({ open, onClose, preferredSourceAccountId }: NewAccountDialogProps) {
  if (!open) return null
  return <NewAccountDialogBody onClose={onClose} preferredSourceAccountId={preferredSourceAccountId} />
}

type Stage = 'form' | 'passkey' | 'creating' | 'done'

/** A refusal from the server, or from the passkey step before anything was sent. */
type DialogRefusal =
  | Exclude<CreateAccountRefusal, { kind: 'unknown_outcome' }>
  | { kind: 'passkey_unsupported' }
  | { kind: 'passkey_failed' }

/**
 * After an unknown outcome the dialog re-reads the account list once on its
 * own, this long after the failure, so a create that was still committing
 * when the response was lost is usually found without the owner doing
 * anything. Exported for the test's fake clock.
 */
export const AUTO_RECHECK_MS = 3_000

/**
 * What an unknown outcome is about: the submission that may have committed.
 * `baseline` is the account ids the dialog saw when that attempt started, so
 * "Check again" can tell a new account from one that was already there.
 */
interface UnknownOutcome {
  fingerprint: string
  chainId: number
  name: string
  baseline: ReadonlySet<string>
}

/**
 * The last "Check again" (or automatic re-check). `read_failed` is kept apart
 * from `none_found` on purpose: "no new account yet" is only true after a read
 * that succeeded.
 */
type CheckState = 'idle' | 'checking' | 'none_found' | 'read_failed'

function randomChallenge(): Uint8Array {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes
}

function NewAccountDialogBody({
  onClose,
  preferredSourceAccountId,
}: {
  onClose: () => void
  preferredSourceAccountId?: string | null
}) {
  const { accounts, createAccount, refreshAccounts } = useAccounts()
  const { signers, loadError, reload } = useUserSigners()
  const { chains } = useDeployableChains()

  const sources = useMemo(() => (signers ? passkeySources(accounts, signers) : []), [accounts, signers])
  const initialSource = useMemo(() => defaultSource(sources, preferredSourceAccountId), [sources, preferredSourceAccountId])

  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [stage, setStage] = useState<Stage>('form')
  /** The latest attempt's own message (a refusal, or a passkey-step failure). */
  const [refusal, setRefusal] = useState<DialogRefusal | null>(null)
  const [created, setCreated] = useState<{ id: string; chain_id: number; name: string } | null>(null)
  /**
   * The unknown outcome, STICKY. Exactly two things clear it: a create request
   * that was actually sent coming back definite (201, or a 4xx other than the
   * rate limit), or the check finding the account. Nothing that stops before
   * the request is sent — a cancelled or failed passkey prompt, the client's
   * key check, a 429 — says anything about the earlier attempt, so none of
   * them clears it; their own message shows beside it.
   */
  const [unknown, setUnknown] = useState<UnknownOutcome | null>(null)
  const [check, setCheck] = useState<CheckState>('idle')
  const pending = useRef<PendingSubmission | null>(null)
  // The account ids seen when the latest attempt began.
  const baseline = useRef<ReadonlySet<string>>(new Set())
  // Bumped when an attempt starts AND when it ends: a check whose read
  // overlapped an attempt has its result dropped, because the attempt's own
  // answer has moved the state past it (the `budgetsGeneration` pattern in
  // useDelegationBudget).
  const generation = useRef(0)
  const nameRef = useRef<HTMLInputElement>(null)

  const source: PasskeySource | null = sources.find((s) => s.account.id === sourceId) ?? initialSource
  // The network starts on the source account's own when the backend serves
  // deploys there, else on the first network it does.
  const sourceChainServed = source !== null && chains.some((c) => c.chainId === source.account.chain_id)
  const selectedChainId = chainId ?? (sourceChainServed ? source!.account.chain_id : chains[0]?.chainId ?? null)
  const networkName = selectedChainId !== null ? getChainConfig(selectedChainId).name : ''

  const busy = stage === 'passkey' || stage === 'creating'
  const checking = check === 'checking'
  const trimmedName = name.trim()
  const nameMissing = touched && trimmedName === ''
  const currentFingerprint =
    source && selectedChainId !== null
      ? submissionFingerprint({ name: trimmedName, chainId: selectedChainId, sourceAccountId: source.account.id })
      : null
  // An edit after an unknown outcome makes the next submit a NEW request with
  // a new key — one that could create a second account if the first went
  // through. The dialog says so instead of hiding the outcome.
  const unknownInputsChanged = unknown !== null && currentFingerprint !== unknown.fingerprint

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value)
      // The latest attempt's message describes the inputs it was given; once
      // they change it is stale. The unknown outcome is separate state and
      // stays: it is about an account that may exist whatever the inputs say.
      setRefusal(null)
    }
  }

  // ── The in-dialog check after an unknown outcome ─────────────────────────
  //
  // Closing the dialog would drop the idempotency key, and a retry from a
  // reopened dialog mints a new one — a second account if the first create
  // committed. So the check happens HERE: re-read the list ("Check again", and
  // once automatically), and when the account appears, show it as created.

  async function checkAgain({ quietOnFailure = false } = {}) {
    const startedAt = generation.current
    setCheck('checking')
    const ok = await refreshAccounts()
    // An attempt started or ended meanwhile: this result is about a state
    // that attempt has moved past, so it is dropped. (The re-read list itself
    // still feeds the detection effect — the accounts are what they are.)
    if (generation.current !== startedAt) return
    // If the re-read found the account, the detection effect below moves the
    // dialog to the success state; what is set here shows only otherwise. The
    // automatic re-check stays quiet when its read fails — nothing new to say.
    if (ok) setCheck('none_found')
    else setCheck(quietOnFailure ? 'idle' : 'read_failed')
  }
  const checkAgainRef = useRef(checkAgain)
  checkAgainRef.current = checkAgain

  // Detection runs only between attempts: while a retry is in flight its own
  // answer decides, and the effect re-runs when the stage returns to the form.
  useEffect(() => {
    if (!unknown || stage !== 'form') return
    const found = findCreatedAccount(accounts, unknown.baseline, unknown.chainId, unknown.name)
    if (!found) return
    pending.current = null
    setCreated({ id: found.id, chain_id: found.chain_id, name: found.name })
    setUnknown(null)
    setRefusal(null)
    setStage('done')
  }, [accounts, unknown, stage])

  // One automatic re-check per unknown outcome (a new outcome object is a new
  // timer; an early-returning retry leaves the object, and the timer, alone).
  useEffect(() => {
    if (!unknown) return
    const timer = setTimeout(() => void checkAgainRef.current({ quietOnFailure: true }), AUTO_RECHECK_MS)
    return () => clearTimeout(timer)
  }, [unknown])

  async function submit() {
    setTouched(true)
    // Re-entry is blocked by the submit button's `disabled={busy}`, not here: a
    // `busy` read in this closure is the render's value, so it could not stop
    // a second click the button had not yet been re-rendered to refuse.
    // `source` and `selectedChainId` are type narrowings for states the form
    // never renders in (the form needs a source; `useDeployableChains` never
    // returns an empty list). The name check is the one input guard.
    if (!source || selectedChainId === null || trimmedName === '') return
    generation.current += 1
    let recheck = false
    try {
      recheck = (await attempt(source, selectedChainId)) === true
    } finally {
      generation.current += 1
    }
    // After the attempt has ended (so the generation counter keeps this check's
    // result): the re-read the cap-while-unknown rule below asks for.
    if (recheck) void checkAgain()
  }

  /** Resolves true when the caller should re-read the list right away. */
  async function attempt(source: PasskeySource, selectedChainId: number): Promise<boolean | void> {
    setRefusal(null)
    setCheck('idle')

    // Same name, network and source as the last attempt → the same key, so a
    // retry after a lost response answers the account it already created.
    const submission = submissionFor(
      pending.current,
      submissionFingerprint({ name: trimmedName, chainId: selectedChainId, sourceAccountId: source.account.id }),
    )
    // The baseline is the list as it is when this attempt starts. Recording it
    // again on a retry is safe: between attempts any account that enters the
    // list is caught by the detection effect, so one that is in the list when
    // the retry starts and was not caught was already there.
    baseline.current = new Set(accounts.map((a) => a.id))
    pending.current = submission

    setStage('passkey')
    let credentialId: string
    try {
      const assertion = await getPasskeyAssertion({
        challenge: randomChallenge(),
        allowCredentialIds: allowCredentialIdsFor(source),
      })
      credentialId = assertion.credentialId
    } catch (err) {
      setStage('form')
      if (err instanceof PasskeyUnsupportedError) {
        setRefusal({ kind: 'passkey_unsupported' })
        return
      }
      // A dismissed sheet is the user changing their mind, not a failure: back
      // to the form with nothing to report.
      if (isPasskeyCancellation(err)) return
      setRefusal({ kind: 'passkey_failed' })
      return
    }

    const keyId = keyIdFromCredentialId(credentialId)
    // The browser was asked for this account's passkeys only; an authenticator
    // that answered with another one would be refused by the server as
    // KEY_NOT_ON_SOURCE, so say so without sending it.
    if (!sourceHoldsKey(source, keyId)) {
      setStage('form')
      setRefusal({ kind: 'key_not_on_source' })
      return
    }
    // This device holds the credential: the marker lets later signing on the
    // new account pick it without asking (#1079).
    rememberPasskeyCredentialOnDevice(credentialId)

    setStage('creating')
    try {
      const account = await createAccount({
        source_account_id: source.account.id,
        key_id: keyId,
        chain_id: selectedChainId,
        name: trimmedName,
        idempotency_key: submission.idempotencyKey,
      })
      pending.current = null
      setUnknown(null)
      setCreated({ id: account.id, chain_id: account.chain_id, name: trimmedName })
      setStage('done')
    } catch (err) {
      setStage('form')
      const outcome = classifyCreateAccountError(err)
      if (outcome.kind === 'unknown_outcome') {
        // No answer, or a 5xx: the create may have committed behind a lost
        // response. Keep the key, remember what the list looked like, and
        // check in the dialog rather than inviting a blind retry.
        setUnknown({
          fingerprint: submission.fingerprint,
          chainId: selectedChainId,
          name: trimmedName,
          baseline: baseline.current,
        })
        return
      }
      // A 429 is the rate limiter refusing THIS attempt before the route ran:
      // it says nothing about an earlier one, so an unknown outcome stands.
      //
      // The cap, while an unknown outcome stands, is not definite either. S1's
      // route (`routes/hybrid-accounts.ts`, #4023) checks the per-chain cap
      // BEFORE its idempotency replay — raised on #4044 — so the account our
      // own first attempt created can be the one that reached the cap, and
      // the replay that would have returned it never runs. Keep the unknown
      // outcome, show the cap beside it, and re-read the list at once so
      // detection can find that account. Drop this branch once S1 replays
      // before it counts. Without a standing unknown outcome the cap is
      // definite, as every other 4xx is.
      const capMayBeOurs = outcome.kind === 'cap_reached' && unknown !== null
      if (outcome.kind !== 'rate_limited' && !capMayBeOurs) setUnknown(null)
      setRefusal(outcome)
      return capMayBeOurs
    }
  }

  const sourceName = source?.account.name ?? 'This account'

  // ── Body ────────────────────────────────────────────────────────────────

  let body: ReactNode
  let footer: ReactNode

  if (stage === 'done' && created) {
    body = (
      <div className="space-y-2" data-testid="new-account-created">
        <p className="text-sm font-medium text-[var(--v2-ink)]">
          {created.name} was created on {getChainConfig(created.chain_id).name}
        </p>
        <p className="text-sm text-[var(--v2-ink-2)]">
          The passkey you just used is its only way to approve, and it has no backup yet. Add one from the
          account&rsquo;s page.
        </p>
      </div>
    )
    footer = (
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
        <Button href={`/accounts/${created.id}`}>Open account</Button>
      </div>
    )
  } else if (signers === null && !loadError) {
    body = (
      <div role="status" aria-busy="true" aria-live="polite" className="space-y-3">
        <span className="sr-only">Loading your passkeys…</span>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
    footer = (
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    )
  } else if (loadError) {
    body = (
      <InlineAlert>
        Couldn&rsquo;t load your passkeys, so Haven can&rsquo;t tell which account can secure a new one.
      </InlineAlert>
    )
    footer = (
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void reload()}>Try again</Button>
      </div>
    )
  } else if (sources.length === 0) {
    // Accounts exist, but none has a passkey (wallet-only accounts). The
    // create request copies a passkey from an existing account, so there is
    // nothing to create from — explain the way forward instead of a form.
    const target = accounts.find((a) => a.is_default) ?? accounts[0]
    body = (
      <div className="space-y-2" data-testid="new-account-needs-passkey">
        <p className="text-sm font-medium text-[var(--v2-ink)]">A new account needs a passkey</p>
        <p className="text-sm text-[var(--v2-ink-2)]">
          A new account is secured by a passkey from one of your accounts, and none of yours has one yet. Add a
          passkey from Backup &amp; recovery on an account&rsquo;s page, then come back here.
        </p>
      </div>
    )
    footer = (
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {target ? <Button href={`/accounts/${target.id}`}>Open {target.name}</Button> : null}
      </div>
    )
  } else {
    body = (
      <div className="space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="new-account-name" className="text-sm font-medium text-[var(--v2-ink)]">
            Account name
          </label>
          <Input
            id="new-account-name"
            ref={nameRef}
            value={name}
            onChange={(e) => edit(setName)(e.target.value)}
            placeholder="For example, Reserve"
            autoComplete="off"
            invalid={nameMissing}
            disabled={busy}
          />
          {nameMissing ? <InlineAlert>Give the account a name.</InlineAlert> : null}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="new-account-network" className="text-sm font-medium text-[var(--v2-ink)]">
            Network
          </label>
          <Select
            id="new-account-network"
            value={selectedChainId ?? ''}
            onChange={(e) => edit(setChainId)(Number(e.target.value))}
            disabled={busy}
          >
            {chains.map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.name}
              </option>
            ))}
          </Select>
        </div>

        {sourceChoiceMatters(sources) ? (
          <div className="space-y-1.5">
            <label htmlFor="new-account-source" className="text-sm font-medium text-[var(--v2-ink)]">
              Use a passkey from
            </label>
            <Select
              id="new-account-source"
              value={source?.account.id ?? ''}
              onChange={(e) => edit(setSourceId)(e.target.value)}
              disabled={busy}
            >
              {sources.map((s) => (
                <option key={s.account.id} value={s.account.id}>
                  {s.account.name} · {getChainConfig(s.account.chain_id).name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-[var(--v2-ink-3)]">Your device offers only this account&rsquo;s passkeys.</p>
          </div>
        ) : null}

        <ul className="space-y-2 text-sm text-[var(--v2-ink-2)]" data-testid="new-account-facts">
          <li>
            <span className="font-medium text-[var(--v2-ink)]">Secured by the passkey you use next.</span> Your
            device asks for it once (Face ID, Touch ID, Windows Hello, or your device PIN), and it becomes the only
            way to approve actions in the new account.
          </li>
          <li>
            <span className="font-medium text-[var(--v2-ink)]">Backups don&rsquo;t carry over.</span> A backup
            passkey or wallet on another account doesn&rsquo;t protect this one, so add one on the new
            account&rsquo;s page. Signers, in Settings, shows which accounts each passkey and wallet approves.
          </li>
          <li>
            <span className="font-medium text-[var(--v2-ink)]">Nothing is set up on {networkName} yet.</span> That
            happens the first time you use the account, for example to give an agent a budget. You can add funds
            before then.
          </li>
        </ul>

        {unknown ? (
          <div className="space-y-1.5 text-xs text-[var(--v2-ink-2)]" data-testid="new-account-unknown">
            <InlineAlert>
              Haven couldn&rsquo;t confirm the account. It may have been created anyway. Check again before trying
              again: trying again here with the same name, network and passkey won&rsquo;t create a second one.
            </InlineAlert>
            <p role="status" aria-live="polite" data-testid="new-account-check">
              {check === 'checking'
                ? 'Checking your accounts…'
                : check === 'none_found'
                  ? `No new account named ${unknown.name} on ${getChainConfig(unknown.chainId).name} yet.`
                  : check === 'read_failed'
                    ? 'Couldn’t read your accounts just now. Check again in a moment.'
                    : ''}
            </p>
            {unknownInputsChanged ? (
              <p data-testid="new-account-new-request">
                You changed the name, network or passkey, so trying again is a new request. If the first one went
                through, it would create a second account. Check again first.
              </p>
            ) : null}
          </div>
        ) : null}
        {/* The latest attempt's own message, beside a standing unknown outcome. */}
        {refusal ? <RefusalMessage refusal={refusal} sourceName={sourceName} networkName={networkName} /> : null}
      </div>
    )
    footer = (
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {unknown ? (
          <Button variant="ghost" onClick={() => void checkAgain()} disabled={busy || checking}>
            Check again
          </Button>
        ) : null}
        {/* Stays enabled during a check: an attempt makes the check's result
            stale, and the generation counter drops it. "Check again" is the
            one disabled while an attempt is in flight. */}
        <Button onClick={() => void submit()} className="whitespace-nowrap" disabled={busy}>
          {stage === 'passkey'
            ? 'Waiting for your passkey…'
            : stage === 'creating'
              ? 'Setting up your account…'
              : unknown && !unknownInputsChanged
                ? 'Try again'
                : 'Create account with a passkey'}
        </Button>
      </div>
    )
  }

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title="New account"
      subtitle="A separate Haven account with its own funds, agents and budgets. It starts empty."
      footer={footer}
      showCloseButton
      // ONE close guard: while the passkey prompt or the create call is in
      // flight, `onClose` is a no-op, so Escape, the backdrop and the X all
      // do nothing (the X and Cancel also render disabled). Closing mid-flight
      // would drop the idempotency key with the request still running.
      closeButtonDisabled={busy}
      initialFocusRef={nameRef}
      panelTestId="new-account-dialog"
    >
      {body}
    </Modal>
  )
}

/**
 * The typed refusals (#4024 acceptance: at the cap the dialog shows the cap,
 * not a generic error). Mapped by `error_code` in `lib/new-account.ts`; the
 * status fallback there decides which of the last three a code-less answer is.
 */
function RefusalMessage({
  refusal,
  sourceName,
  networkName,
}: {
  refusal: DialogRefusal
  sourceName: string
  networkName: string
}) {
  switch (refusal.kind) {
    case 'cap_reached':
      return (
        <InlineAlert>
          {refusal.cap !== null
            ? `You already have ${refusal.cap} accounts on ${networkName}, the most Haven allows on one network.`
            : `You already have the most accounts Haven allows on ${networkName}.`}{' '}
          Choose another network, or remove an account you no longer use from its page.
        </InlineAlert>
      )
    case 'source_has_no_passkey':
      return (
        <InlineAlert>
          {sourceName} no longer has a passkey, so it can&rsquo;t secure a new account. Reload the page to see your
          accounts as they are now.
        </InlineAlert>
      )
    case 'key_not_on_source':
      return (
        <InlineAlert>
          That passkey isn&rsquo;t one of {sourceName}&rsquo;s. Try again and pick a passkey saved for {sourceName}.
        </InlineAlert>
      )
    case 'source_not_found':
      return (
        <InlineAlert>
          Haven couldn&rsquo;t find {sourceName} among your accounts. Reload the page and try again.
        </InlineAlert>
      )
    case 'rate_limited':
      return <InlineAlert>Too many attempts in a short time. Wait a minute, then try again.</InlineAlert>
    case 'could_not_create':
      // A definite refusal: no retry promise, because retrying the same
      // request gets the same answer.
      return (
        <InlineAlert>
          Haven couldn&rsquo;t create the account.{refusal.detail ? ` Details: ${refusal.detail}` : ''}
        </InlineAlert>
      )
    case 'passkey_unsupported':
      return (
        <InlineAlert>
          This browser can&rsquo;t use a passkey. Open Haven in Safari, Chrome, or Edge on the device that holds
          your passkey.
        </InlineAlert>
      )
    case 'passkey_failed':
      return <InlineAlert>Your passkey couldn&rsquo;t be read. Try again.</InlineAlert>
  }
}
