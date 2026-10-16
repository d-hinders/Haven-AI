/**
 * The pure half of the "New account" dialog (#4024, epic #4022 slice S2).
 *
 * The dialog creates an ADDITIONAL Hybrid DeleGator account through #4023's
 * create-additional request: `POST /accounts/hybrid` with
 * `{ source_account_id, key_id, chain_id, name, idempotency_key }`. The server
 * copies the ONE passkey named by `key_id` from the source account's stored
 * signer set — the client never sends key material — and the new account is
 * never the default. This module holds the decisions that do not need React:
 * which accounts can be a source, which one is picked by default, how a
 * credential id becomes a `key_id`, how the account a lost create made is
 * recognised, and how
 * a refusal is classified. The words the user reads live in the dialog
 * (`components/NewAccountDialog.tsx`), inside the copy lint's scan.
 */

import { toHex } from 'viem'
import type { ApiOperations } from '@haven_ai/core'
import type { SmartAccount } from '@/context/AuthContext'
import { base64UrlDecode } from './passkey'
import { credentialIdFromKeyId } from './signer'

type UserSignersResponse = ApiOperations['listUserSigners']['responses']['200']['content']['application/json']
type UserSigner = UserSignersResponse['signers'][number]

// The wire shapes come from the spec (`ApiOperations['createHybridAccount']`,
// #4023), so a contract change shows up here as a type error instead of drift.
type CreateHybridAccount = ApiOperations['createHybridAccount']
type CreateHybridAccountRequest = CreateHybridAccount['requestBody']['content']['application/json']

/** The create-additional shape: the five fields the dialog always sends. */
export type CreateAccountBody = Required<
  Pick<CreateHybridAccountRequest, 'source_account_id' | 'key_id' | 'chain_id' | 'name' | 'idempotency_key'>
>

export type CreatedAccount = CreateHybridAccount['responses']['201']['content']['application/json']

/**
 * An account that can secure a new one: it has at least one passkey. `keyIds`
 * are the hex `key_id`s (hybrid_account_passkeys storage form, #885) exactly as
 * `GET /user/signers` lists them.
 */
export interface PasskeySource {
  account: SmartAccount
  keyIds: string[]
}

/**
 * Accounts with a passkey, in the account list's own order. Built from ONE
 * read — `GET /user/signers` (#3825) lists each passkey once with every account
 * it approves — instead of one signer-set fetch per account. An account the
 * signer read does not mention (EOA-only, or skipped by the backend because its
 * owner config could not be resolved) is not a source: the backend would
 * refuse it as SOURCE_HAS_NO_PASSKEY anyway.
 */
export function passkeySources(accounts: SmartAccount[], signers: UserSigner[]): PasskeySource[] {
  const byAccount = new Map<string, string[]>()
  for (const signer of signers) {
    if (signer.kind !== 'passkey') continue
    for (const approved of signer.accounts) {
      const list = byAccount.get(approved.account_id) ?? []
      if (!list.includes(signer.key_id)) list.push(signer.key_id)
      byAccount.set(approved.account_id, list)
    }
  }
  return accounts
    .filter((account) => (byAccount.get(account.id)?.length ?? 0) > 0)
    .map((account) => ({ account, keyIds: byAccount.get(account.id)! }))
}

/**
 * The source the dialog starts on: the account the caller is scoped to when it
 * has a passkey (an account page, #4021's tile), else the default account when
 * it has one, else the first account that does. `null` only when no account
 * has a passkey — the state the dialog explains instead of offering a form.
 */
export function defaultSource(sources: PasskeySource[], preferredAccountId?: string | null): PasskeySource | null {
  if (preferredAccountId) {
    const preferred = sources.find((s) => s.account.id === preferredAccountId)
    if (preferred) return preferred
  }
  return sources.find((s) => s.account.is_default) ?? sources[0] ?? null
}

/**
 * Whether the source is worth asking about. The choice only changes which
 * passkeys the device may offer, so it is a real question only when the
 * sources hold DIFFERENT passkey sets. Two accounts behind the same passkey —
 * the common case once a user has created one — would present a field whose
 * answer changes nothing.
 */
export function sourceChoiceMatters(sources: PasskeySource[]): boolean {
  const sets = new Set(sources.map((s) => [...s.keyIds].map((k) => k.toLowerCase()).sort().join(',')))
  return sets.size > 1
}

/** The WebAuthn `allowCredentials` ids (base64url) for a source's passkeys. */
export function allowCredentialIdsFor(source: PasskeySource): string[] {
  return source.keyIds.map(credentialIdFromKeyId)
}

/**
 * base64url credential id (what `navigator.credentials.get` returns) → hex
 * `key_id`, the form the backend stores and compares. The same conversion
 * signup performs (`HybridEnrollFlow`), lowercase as `toHex` emits it.
 */
export function keyIdFromCredentialId(credentialId: string): string {
  return toHex(base64UrlDecode(credentialId))
}

/** Whether an asserted `key_id` is one of the source's passkeys (case-insensitive, like the server). */
export function sourceHoldsKey(source: PasskeySource, keyId: string): boolean {
  return source.keyIds.some((k) => k.toLowerCase() === keyId.toLowerCase())
}

/**
 * After an UNKNOWN outcome (no answer, or a 5xx), find the account the lost
 * create may have made. It must be all three: absent from the baseline
 * recorded when the attempt started, on the chain the create was sent to, and
 * carrying the submitted name (the backend stores the name trimmed). A new
 * account with any other name is not ours — another tab, another device — so
 * it never resolves the outcome.
 */
export function findCreatedAccount(
  accounts: SmartAccount[],
  baselineIds: ReadonlySet<string>,
  chainId: number,
  name: string,
): SmartAccount | null {
  const wanted = name.trim()
  return (
    accounts.find((a) => !baselineIds.has(a.id) && a.chain_id === chainId && a.name.trim() === wanted) ?? null
  )
}

// ── Refusals ──────────────────────────────────────────────────────────────
//
// The create-additional refusals are mapped by `error_code` FIRST, never by
// matching the backend's sentence. These are the codes requested on #4044
// (#4023's PR); the spec does not carry them yet, so they live here. Without a
// code, the status decides — and the line that matters is whether the outcome
// is KNOWN:
//
// - a 4xx is a definite refusal OF THIS REQUEST: the route answered before
//   (or rolled back) anything it would have written for it. 429 is the
//   money-path rate limit; every other code-less 4xx is a typed "could not
//   create" that passes the backend's sentence through as detail. It says
//   nothing about an EARLIER attempt (the route validates before its replay),
//   which is why the dialog never lets a refusal clear an unknown outcome.
// - no status (the request never got an answer) or a 5xx is an UNKNOWN
//   outcome: the create may have committed and only the response been lost.
//   The dialog records that submission and repeats it exactly on a retry.

export const ACCOUNT_CAP_REACHED = 'ACCOUNT_CAP_REACHED'
export const SOURCE_HAS_NO_PASSKEY = 'SOURCE_HAS_NO_PASSKEY'
export const KEY_NOT_ON_SOURCE = 'KEY_NOT_ON_SOURCE'
export const SOURCE_ACCOUNT_NOT_FOUND = 'SOURCE_ACCOUNT_NOT_FOUND'

export type CreateAccountRefusal =
  /** The per-user per-chain soft cap (#4023: 10). `cap` when the body carries it. */
  | { kind: 'cap_reached'; cap: number | null }
  | { kind: 'source_has_no_passkey' }
  | { kind: 'key_not_on_source' }
  | { kind: 'source_not_found' }
  | { kind: 'rate_limited' }
  /** A code-less 4xx: a definite refusal. The backend's sentence, bounded, or null. */
  | { kind: 'could_not_create'; detail: string | null }
  /** No answer, or a 5xx: the account may have been created anyway. */
  | { kind: 'unknown_outcome' }

/** Long enough for every sentence the route sends today; short enough to stay a line. */
const MAX_DETAIL_CHARS = 200

function readBody(err: unknown): Record<string, unknown> {
  const body = (err as { body?: unknown } | null)?.body
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

export function classifyCreateAccountError(err: unknown): CreateAccountRefusal {
  const body = readBody(err)
  const status = (err as { status?: unknown } | null)?.status
  const code = typeof body.error_code === 'string' ? body.error_code : null

  switch (code) {
    case ACCOUNT_CAP_REACHED: {
      const cap = typeof body.cap === 'number' && Number.isFinite(body.cap) ? body.cap : null
      return { kind: 'cap_reached', cap }
    }
    case SOURCE_HAS_NO_PASSKEY:
      return { kind: 'source_has_no_passkey' }
    case KEY_NOT_ON_SOURCE:
      return { kind: 'key_not_on_source' }
    case SOURCE_ACCOUNT_NOT_FOUND:
      return { kind: 'source_not_found' }
  }

  if (typeof status !== 'number' || status < 400 || status >= 500) return { kind: 'unknown_outcome' }
  if (status === 429) return { kind: 'rate_limited' }
  const sentence = typeof body.error === 'string' ? body.error.trim() : ''
  return { kind: 'could_not_create', detail: sentence ? sentence.slice(0, MAX_DETAIL_CHARS) : null }
}
