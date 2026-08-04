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

import { signDelegationWithPasskey, type AccountSigners } from '@/lib/delegationPasskeySigner'

const FIRST_KEY_ID = toHex(new TextEncoder().encode('first-credential'))
const BACKUP_KEY_ID = toHex(new TextEncoder().encode('backup-credential'))

const SIGNERS: AccountSigners = {
  account_address: '0x9999888877776666555544443333222211110000',
  chain_id: 84532,
  owner_address: null,
  passkeys: [
    { key_id: FIRST_KEY_ID, x: `0x${'aa'.repeat(32)}`, y: `0x${'bb'.repeat(32)}` },
    { key_id: BACKUP_KEY_ID, x: `0x${'cc'.repeat(32)}`, y: `0x${'dd'.repeat(32)}` },
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
