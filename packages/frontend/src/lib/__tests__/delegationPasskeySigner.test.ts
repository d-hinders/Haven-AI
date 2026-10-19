// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toHex } from 'viem'
import {
  credentialIdFromKeyId,
  rememberPasskeyCredentialOnDevice,
} from '@/lib/signer'
import { base64UrlEncode } from '@/lib/passkey'

// Capture what the kit is handed so we can assert WHICH passkey was chosen —
// the on-chain signing itself is the kit's business (proven live in #884).
const toWebAuthnAccount = vi.fn((args: { credential: { id: string } }) => ({
  webAuthn: true,
  credentialId: args.credential.id,
}))
const toMetaMaskSmartAccount = vi.fn(async (args: { signer: { keyId: string } }) => ({
  signDelegation: vi.fn(async () => '0xsigned'),
  signUserOperation: vi.fn(async () => '0xsigned'),
  __signerKeyId: args.signer.keyId,
}))

vi.mock('@metamask/smart-accounts-kit', () => ({
  Implementation: { Hybrid: 'hybrid' },
  toMetaMaskSmartAccount: (args: never) => toMetaMaskSmartAccount(args),
}))
vi.mock('viem/account-abstraction', () => ({
  toWebAuthnAccount: (args: never) => toWebAuthnAccount(args),
}))

import { signDelegationWithPasskey, signUserOpWithPasskey, type AccountSigners } from '@/lib/delegationPasskeySigner'

const FIRST_KEY_ID = toHex(new TextEncoder().encode('first-credential'))
const BACKUP_KEY_ID = toHex(new TextEncoder().encode('backup-credential'))

const SIGNERS: AccountSigners = {
  account_address: '0x9999888877776666555544443333222211110000',
  chain_id: 84532,
  owner_address: null,
  passkeys: [
    { key_id: FIRST_KEY_ID, x: `0x${'aa'.repeat(32)}`, y: `0x${'bb'.repeat(32)}`, created_at: '2026-03-03T12:00:00.000Z' },
    { key_id: BACKUP_KEY_ID, x: `0x${'cc'.repeat(32)}`, y: `0x${'dd'.repeat(32)}`, created_at: '2026-05-10T09:00:00.000Z' },
  ],
}

const MESSAGE = {
  delegate: '0x1111111111111111111111111111111111111111',
  delegator: SIGNERS.account_address,
  authority: `0x${'00'.repeat(32)}`,
  caveats: [],
  salt: '1',
}

describe('device-aware passkey selection (#1079)', () => {
  beforeEach(() => {
    localStorage.clear()
    toWebAuthnAccount.mockClear()
    toMetaMaskSmartAccount.mockClear()
  })

  it('signs with the passkey that is enrolled on THIS device, not blindly passkeys[0]', async () => {
    // The device holds the BACKUP key — the recovery scenario that made
    // passkeys[0] a bug.
    rememberPasskeyCredentialOnDevice(credentialIdFromKeyId(BACKUP_KEY_ID))

    await signDelegationWithPasskey(SIGNERS, MESSAGE)

    expect(toWebAuthnAccount).toHaveBeenCalledTimes(1)
    expect(toWebAuthnAccount.mock.calls[0][0].credential.id).toBe(base64UrlEncode(new TextEncoder().encode('backup-credential')))
    expect(toMetaMaskSmartAccount.mock.calls[0][0].signer.keyId).toBe(BACKUP_KEY_ID)
  })

  it('prefers the first-enrolled key when it is the one on this device', async () => {
    rememberPasskeyCredentialOnDevice(credentialIdFromKeyId(FIRST_KEY_ID))

    await signDelegationWithPasskey(SIGNERS, MESSAGE)

    expect(toMetaMaskSmartAccount.mock.calls[0][0].signer.keyId).toBe(FIRST_KEY_ID)
  })

  it('falls back to passkeys[0] when no device marker matches', async () => {
    await signDelegationWithPasskey(SIGNERS, MESSAGE)

    expect(toMetaMaskSmartAccount.mock.calls[0][0].signer.keyId).toBe(FIRST_KEY_ID)
  })
})

/**
 * #4024 builder note. The header of `delegationPasskeySigner.ts` says the kit
 * deployParams must match what provisioning derived the address from — and
 * since #4023 that derivation includes a per-account deploy SALT the client
 * never sees. Signing still works for a salted account because the kit is
 * never asked to derive anything: it is handed the account address the
 * backend recorded (`signers.account_address`) and no deploy parameters at
 * all. This pins exactly that, on both signing entry points, with an address
 * that stands for a salted account: whatever the salt, the address the kit
 * signs as is the stored one, so a second account behind the same passkey
 * signs as itself and never as the salt-0 account.
 */
describe('a salted account signs as its stored address (#4024 builder note)', () => {
  // Not a salt-0 derivation of either passkey above: the address a
  // per-account salt produced, as the signer-set read returns it.
  const SALTED: AccountSigners = {
    ...SIGNERS,
    account_address: '0x5a17ed0000000000000000000000000000004024',
    passkeys: [SIGNERS.passkeys[0]!],
  }

  beforeEach(() => {
    localStorage.clear()
    toWebAuthnAccount.mockClear()
    toMetaMaskSmartAccount.mockClear()
  })

  function kitArgs(): Record<string, unknown> {
    expect(toMetaMaskSmartAccount).toHaveBeenCalledTimes(1)
    return toMetaMaskSmartAccount.mock.calls[0][0] as unknown as Record<string, unknown>
  }

  it('hands the kit the stored address and no deploy parameters when signing a delegation', async () => {
    await signDelegationWithPasskey(SALTED, { ...MESSAGE, delegator: SALTED.account_address })

    const args = kitArgs()
    expect(args.address).toBe(SALTED.account_address)
    // The kit derives an address only from deployParams / deploySalt. Neither
    // is passed, so nothing on the client can re-derive the salt-0 account.
    expect(args).not.toHaveProperty('deployParams')
    expect(args).not.toHaveProperty('deploySalt')
  })

  it('hands the kit the stored address and no deploy parameters when signing an account op', async () => {
    await signUserOpWithPasskey(SALTED, { sender: SALTED.account_address, nonce: '0n' })

    const args = kitArgs()
    expect(args.address).toBe(SALTED.account_address)
    expect(args).not.toHaveProperty('deployParams')
    expect(args).not.toHaveProperty('deploySalt')
  })
})
