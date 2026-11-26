/**
 * The Stripe deposit-address registry (#4952, epic #4886). Dev and Stripe
 * sandbox only: a proof of address ownership is required before production.
 * `depositAddressRegistryOpen` is the gate that makes that scope hold in code
 * (#5028): the registry is open only on a testnet Sales account.
 *
 * The Sales account's OWNER registers the address a processor receives on the
 * merchant's behalf. Haven cannot verify it is theirs, so every registration is
 * labelled so: `verified: false` with a `verification` note the screens render
 * ("registered by you, not verified by Haven"). A registration decides which
 * transfers `modules/transactions/merchant-sales.ts` attributes to the account
 * as Stripe-held sales; it moves no money and never touches a balance.
 *
 * ## What a registration refuses
 *
 * - `INVALID_DEPOSIT_ADDRESS`: not a 0x-prefixed 20-byte hex address;
 * - `DEPOSIT_ADDRESS_IS_OWN`: one of the owner's own smart accounts or any
 *   current or past agent delegate address (`listOwnAccountAddresses`), which
 *   would otherwise let an own move masquerade as a sale;
 * - `DEPOSIT_ADDRESS_ALREADY_REGISTERED`: an active registration on any account
 *   on this chain (the partial unique index). Accepted residual: this tells one
 *   owner that some other account holds the address. A proof of ownership
 *   closes it before production.
 *
 * The chain is the Sales account's own; the request names none.
 */
import { listOwnAccountAddresses } from '../../infra/repositories/inbound-transfers.js'
import {
  findDepositAddress,
  insertDepositAddress,
  listDepositAddresses,
  retireDepositAddress,
  type MerchantDepositAddressRow,
} from '../../infra/repositories/merchant-deposit-addresses.js'
import type { SalesScope } from '../../infra/repositories/merchant-sales-reads.js'
import { isMainnetChain } from '../catalog/index.js'

export const DEPOSIT_ADDRESS_VERIFICATION_NOTE = 'Registered by you, not verified by Haven.'

/**
 * The refusal a non-testnet Sales account gets from every registry route
 * (#5028). The registry is dev and Stripe sandbox only until a proof of address
 * ownership exists, and the gate is per Sales account: open only when the
 * account's chain is a testnet.
 */
export const DEPOSIT_ADDRESSES_TESTNET_ONLY = 'DEPOSIT_ADDRESSES_TESTNET_ONLY'

/**
 * Whether the registry is open on `chainId` (#5028). The registry's chain is
 * always the Sales account's own, so this is a pure function of it. The
 * predicate is the existing fail-closed one: an unregistered chain counts as
 * mainnet. The ownership-proof slice removes this gate.
 */
export function depositAddressRegistryOpen(chainId: number): boolean {
  return !isMainnetChain(chainId)
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export type DepositAddressFailureCode =
  | 'INVALID_DEPOSIT_ADDRESS'
  | 'DEPOSIT_ADDRESS_IS_OWN'
  | 'DEPOSIT_ADDRESS_ALREADY_REGISTERED'
  | 'DEPOSIT_ADDRESS_NOT_FOUND'
  | 'DEPOSIT_ADDRESS_RETIRED'

export type DepositAddressResult =
  | { ok: true; registration: MerchantDepositAddressRow }
  | { ok: false; status: 400 | 404 | 409; code: DepositAddressFailureCode; message: string }

/** The wire shape of a registration: every answer carries the unverified label. */
export function serializeDepositAddress(row: MerchantDepositAddressRow): Record<string, unknown> {
  return {
    id: row.id,
    address: row.address,
    chain: `eip155:${row.chain_id}`,
    registered_at: new Date(row.registered_at).toISOString(),
    retired_at: row.retired_at === null ? null : new Date(row.retired_at).toISOString(),
    active: row.retired_at === null,
    verified: false,
    verification: DEPOSIT_ADDRESS_VERIFICATION_NOTE,
  }
}

export async function listRegistrations(scope: SalesScope): Promise<MerchantDepositAddressRow[]> {
  return listDepositAddresses(scope)
}

export async function registerDepositAddress(
  scope: SalesScope,
  address: string,
): Promise<DepositAddressResult> {
  if (typeof address !== 'string' || !EVM_ADDRESS.test(address)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_DEPOSIT_ADDRESS',
      message: 'The deposit address must be a 0x-prefixed 20-byte hex address.',
    }
  }
  const lower = address.toLowerCase()
  const own = await listOwnAccountAddresses(scope.userId)
  if (own.includes(lower)) {
    return {
      ok: false,
      status: 409,
      code: 'DEPOSIT_ADDRESS_IS_OWN',
      message: 'That address is one of your own accounts or agents. A deposit address is where a processor holds your sales.',
    }
  }
  const row = await insertDepositAddress({
    accountId: scope.accountId,
    userId: scope.userId,
    chainId: scope.chainId,
    address: lower,
  })
  if (row === null) {
    return {
      ok: false,
      status: 409,
      code: 'DEPOSIT_ADDRESS_ALREADY_REGISTERED',
      message: 'That address already has an active registration on this network.',
    }
  }
  return { ok: true, registration: row }
}

export async function retireRegistration(scope: SalesScope, id: string): Promise<DepositAddressResult> {
  const retired = await retireDepositAddress(scope, id)
  if (retired !== null) return { ok: true, registration: retired }
  const existing = await findDepositAddress(scope, id)
  if (existing === null) {
    return { ok: false, status: 404, code: 'DEPOSIT_ADDRESS_NOT_FOUND', message: 'No such deposit address on this account.' }
  }
  return {
    ok: false,
    status: 409,
    code: 'DEPOSIT_ADDRESS_RETIRED',
    message: 'That deposit address is already retired.',
  }
}
