// Lives beside its module in modules/payments. The repository read is proven
// in infra/repositories/__tests__/smart-accounts.test.ts on the real-DB
// harness; this file stubs the repository and proves the MAPPING contract:
/**
 * #3528 — the self-transfer prepare hint's mapping contract:
 *
 * - an owner-owned recipient warns; a stranger's does not;
 * - the hint is additive only: present exactly when it applies, absent
 *   otherwise (never an empty array — a stranger's prepare is unchanged);
 * - it NEVER blocks: no refusal shape, no safe_to_continue, no ledger row —
 *   this module only ever RETURNS a warning block;
 * - a degraded directory read fails OPEN (no warning, prepare unaffected).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockListOwnerAddresses } = vi.hoisted(() => ({ mockListOwnerAddresses: vi.fn() }))

vi.mock('../../../infra/repositories/smart-accounts.js', () => ({
  listOwnerAddressesForUser: (...a: unknown[]) => mockListOwnerAddresses(...a),
}))

import {
  SELF_TRANSFER_WARNING_CODE,
  SELF_TRANSFER_WARNING_MESSAGE,
  isSelfTransferRecipient,
  selfTransferWarning,
} from '../self-transfer-warning.js'

const OWNER = '22222222-2222-2222-2222-222222222222'
// The owner's primary Haven account (a smart-account address)…
const OWN_ACCOUNT = '0x135a9215604711AC70d970e12Caa812c53537EF4'
// …and its current EOA owner (an ownership transfer moved it on-chain).
const OWN_OWNER = '0x6d01aabbccddeeff00112233445566778899081e'
// A stranger.
const STRANGER = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const DIRECTORY = [OWN_ACCOUNT, OWN_OWNER]

afterEach(() => {
  mockListOwnerAddresses.mockReset()
})

describe('isSelfTransferRecipient (#3528)', () => {
  it('matches an account_address from the owner directory, case-insensitively', async () => {
    mockListOwnerAddresses.mockResolvedValue(DIRECTORY)
    expect(await isSelfTransferRecipient(OWNER, OWN_ACCOUNT)).toBe(true)
    // Mixed-case input against a lower-cased stored row, and vice versa.
    expect(await isSelfTransferRecipient(OWNER, OWN_ACCOUNT.toLowerCase())).toBe(true)
    expect(await isSelfTransferRecipient(OWNER, OWN_OWNER.toUpperCase())).toBe(true)
    expect(mockListOwnerAddresses).toHaveBeenCalledWith(OWNER)
  })

  it('a stranger’s address is not a self-transfer', async () => {
    mockListOwnerAddresses.mockResolvedValue(DIRECTORY)
    expect(await isSelfTransferRecipient(OWNER, STRANGER)).toBe(false)
  })

  it('an empty owner directory never matches', async () => {
    mockListOwnerAddresses.mockResolvedValue([])
    expect(await isSelfTransferRecipient(OWNER, OWN_ACCOUNT)).toBe(false)
  })

  it('FAILS OPEN: a thrown directory read is false, never an error', async () => {
    mockListOwnerAddresses.mockRejectedValue(new Error('db down'))
    expect(await isSelfTransferRecipient(OWNER, OWN_ACCOUNT)).toBe(false)
  })

  it('a non-address recipient short-circuits without a directory read', async () => {
    mockListOwnerAddresses.mockResolvedValue(DIRECTORY)
    expect(await isSelfTransferRecipient(OWNER, 'not-an-address')).toBe(false)
    expect(await isSelfTransferRecipient(OWNER, '0x1234')).toBe(false)
    expect(mockListOwnerAddresses).not.toHaveBeenCalled()
  })
})

describe('selfTransferWarning (#3528)', () => {
  it('an owner-owned recipient carries the SELF_TRANSFER warning, additive', async () => {
    mockListOwnerAddresses.mockResolvedValue(DIRECTORY)
    const block = await selfTransferWarning(OWNER, OWN_ACCOUNT)
    expect(block).toEqual({
      warnings: [
        {
          code: SELF_TRANSFER_WARNING_CODE,
          message: SELF_TRANSFER_WARNING_MESSAGE,
        },
      ],
    })
    expect(SELF_TRANSFER_WARNING_CODE).toBe('SELF_TRANSFER')
    expect(SELF_TRANSFER_WARNING_MESSAGE).toContain('one of your own Haven accounts')
  })

  it('a stranger’s prepare is UNCHANGED: the spread is undefined, so the field is absent', async () => {
    mockListOwnerAddresses.mockResolvedValue(DIRECTORY)
    expect(await selfTransferWarning(OWNER, STRANGER)).toBeUndefined()
  })

  it('FAILS OPEN: a degraded read warns on nothing', async () => {
    mockListOwnerAddresses.mockRejectedValue(new Error('db down'))
    expect(await selfTransferWarning(OWNER, OWN_ACCOUNT)).toBeUndefined()
  })
})
