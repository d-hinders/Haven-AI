'use client'

/**
 * The one passkey step, shared by the New account dialog and the Sales dialog
 * (#4904, epic #4885).
 *
 * Both dialogs create an account from a passkey the user already holds: one
 * WebAuthn ASSERTION (`navigator.credentials.get`, never `create`) restricted
 * to a source account's passkeys, whose credential id becomes the `key_id` the
 * server copies the signer from. The server receives no assertion — the
 * session is the authentication, and the assertion is the CHOICE of key, made
 * on the device that holds it (delegation rail security model § 6b).
 *
 * This was `NewAccountDialog`'s inline step until #4904 needed the same step
 * for turning Sales on. Extracting it is the issue's own instruction ("The
 * existing New account dialog's passkey step is reused"), and the New account
 * dialog's caller (the Accounts overview) is re-checked by its own tests.
 *
 * The outcome is a discriminated result rather than a thrown error, because
 * each kind is a different sentence and a different next step:
 *
 * - `asserted` — the device answered with a key on the source account. The
 *   credential is remembered on this device (#1079), so later signing on the
 *   new account picks it without asking.
 * - `cancelled` — the user dismissed the sheet. That is changing your mind,
 *   not a failure: the caller returns to its form with nothing to report.
 * - `unsupported` — this browser cannot use a passkey at all.
 * - `failed` — the prompt failed for another reason.
 * - `key_not_on_source` — the authenticator answered with a key that is not
 *   the source account's. The server would refuse it as `KEY_NOT_ON_SOURCE`,
 *   so the caller says so without sending it.
 * - `other_passkey` — a retry asked for one recorded key and got another. The
 *   server binds an idempotency key to its `key_id`, so sending it would be
 *   refused; the caller says so without sending it.
 */

import { useCallback, useState } from 'react'
import { getPasskeyAssertion, PasskeyUnsupportedError } from '@/lib/passkey'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'
import { credentialIdFromKeyId, rememberPasskeyCredentialOnDevice } from '@/lib/signer'
import {
  allowCredentialIdsFor,
  keyIdFromCredentialId,
  sourceHoldsKey,
  type PasskeySource,
} from '@/lib/new-account'

export type PasskeyStepOutcome =
  | { kind: 'asserted'; keyId: string }
  | { kind: 'cancelled' }
  | { kind: 'unsupported' }
  | { kind: 'failed' }
  | { kind: 'key_not_on_source' }
  | { kind: 'other_passkey' }

function randomChallenge(): Uint8Array {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes
}

export function usePasskeyStep() {
  const [waiting, setWaiting] = useState(false)

  /**
   * Ask the device for one assertion. `onlyKeyId` restricts the prompt to a
   * single recorded passkey (a retry of a submission whose idempotency key is
   * bound to it); without it the prompt offers every passkey the source
   * account holds.
   */
  const run = useCallback(
    async (source: PasskeySource, options?: { onlyKeyId?: string }): Promise<PasskeyStepOutcome> => {
      setWaiting(true)
      try {
        const assertion = await getPasskeyAssertion({
          challenge: randomChallenge(),
          allowCredentialIds: options?.onlyKeyId
            ? [credentialIdFromKeyId(options.onlyKeyId)]
            : allowCredentialIdsFor(source),
        })
        const keyId = keyIdFromCredentialId(assertion.credentialId)

        // The browser was asked for this account's passkeys only; an
        // authenticator that answered with another one would be refused by the
        // server as KEY_NOT_ON_SOURCE, so say so without sending it. This check
        // comes FIRST, before the recorded-key check: a key that is not on the
        // source at all is the more specific answer.
        if (!sourceHoldsKey(source, keyId)) return { kind: 'key_not_on_source' }
        // A retry asked for the recorded passkey only; one that answered with
        // another would send the recorded key with a different key_id, which
        // the server refuses (IDEMPOTENCY_KEY_REUSED).
        if (options?.onlyKeyId && keyId.toLowerCase() !== options.onlyKeyId.toLowerCase()) {
          return { kind: 'other_passkey' }
        }

        // This device holds the credential: the marker lets later signing on
        // the new account pick it without asking (#1079).
        rememberPasskeyCredentialOnDevice(assertion.credentialId)
        return { kind: 'asserted', keyId }
      } catch (err) {
        if (err instanceof PasskeyUnsupportedError) return { kind: 'unsupported' }
        if (isPasskeyCancellation(err)) return { kind: 'cancelled' }
        return { kind: 'failed' }
      } finally {
        setWaiting(false)
      }
    },
    [],
  )

  return { waiting, run }
}
