import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGet, mockPost, mockSignDelegation, mockSignUserOp, mockSigner, mockOnDevice } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockSignDelegation: vi.fn(),
  mockSignUserOp: vi.fn(),
  mockSigner: vi.fn(),
  mockOnDevice: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { get: mockGet, post: mockPost } }))
vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => mockSigner(),
  hasPasskeyCredentialOnDevice: (id: string) => mockOnDevice(id),
  credentialIdFromKeyId: (k: string) => k,
}))
vi.mock('@/lib/delegationPasskeySigner', () => ({
  signDelegationWithPasskey: mockSignDelegation,
  signUserOpWithPasskey: mockSignUserOp,
}))

const { useDelegationBudget, pickSigningPath } = await import('@/hooks/useDelegationBudget')

const AGENT = 'agent-1'
const PASSKEY_SIGNERS = {
  account_address: '0x' + 'aa'.repeat(20),
  chain_id: 84532,
  owner_address: null,
  passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
}
const EOA_SIGNERS = { ...PASSKEY_SIGNERS, owner_address: '0x' + 'ee'.repeat(20), passkeys: [] }

function mockApi(signers: unknown) {
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/delegations')) return Promise.resolve({ delegations: [] })
    if (url.endsWith('/account-signers')) return Promise.resolve(signers)
    return Promise.reject(new Error('unexpected ' + url))
  })
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockSignDelegation.mockReset()
  mockSignUserOp.mockReset()
  mockSigner.mockReset()
  mockSigner.mockReturnValue(null) // no wallet connected by default
  mockOnDevice.mockReset()
  mockOnDevice.mockReturnValue(false) // no device markers by default
})

describe('useDelegationBudget passkey dispatch (#887)', () => {
  it('does not read delegation endpoints when the caller disables the rail', async () => {
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532, { enabled: false }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGet).not.toHaveBeenCalled()
    expect(result.current.ready).toBe(false)
  })

  it('a passkey-only account is ready WITHOUT a connected wallet', async () => {
    mockApi(PASSKEY_SIGNERS)
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
  })

  it('an EOA-owned account still requires the connected owner wallet', async () => {
    mockApi(EOA_SIGNERS)
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.budgets).not.toBeNull())
    expect(result.current.ready).toBe(false) // no wallet connected
  })

  it('grant on a passkey account signs the DELEGATION via WebAuthn — one ceremony', async () => {
    mockApi(PASSKEY_SIGNERS)
    const message = { delegate: '0xd', delegator: '0xa', authority: '0x0', caveats: [], salt: '1' }
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({ delegation_hash: '0xhash', version: 1, signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message } })
      }
      return Promise.resolve({ activated: true })
    })
    mockSignDelegation.mockResolvedValue('0x' + 'ab'.repeat(200))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.grant({
        tokenAddress: ('0x' + 'cc'.repeat(20)) as never,
        budgetAtomic: '1000',
        periodSeconds: 86400,
      })
      expect(res.ok).toBe(true)
    })
    // Signed via the kit's WebAuthn path with the delegation message:
    expect(mockSignDelegation).toHaveBeenCalledWith(PASSKEY_SIGNERS, message)
    // Activation received the WebAuthn signature:
    const activate = mockPost.mock.calls.find((c) => String(c[0]).includes('/activate'))!
    expect(activate[1].signature).toBe('0x' + 'ab'.repeat(200))
  })

  it('revoke follows the backend scheme: webauthn_userop signs the UserOperation', async () => {
    mockApi(PASSKEY_SIGNERS)
    const userOp = { sender: '0xa', nonce: '5n' }
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/revoke')) {
        return Promise.resolve({ signature_scheme: 'webauthn_userop', user_op_hash: '0xh', user_operation: userOp })
      }
      return Promise.resolve({ revoked: true })
    })
    mockSignUserOp.mockResolvedValue('0x' + 'cd'.repeat(200))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.revoke('0x' + 'ab'.repeat(32))
      expect(res.ok).toBe(true)
    })
    expect(mockSignUserOp).toHaveBeenCalledWith(PASSKEY_SIGNERS, userOp)
    const submit = mockPost.mock.calls.find((c) => String(c[0]).includes('/revoke/submit'))!
    expect(submit[1]).toMatchObject({ signature: '0x' + 'cd'.repeat(200), user_operation: userOp })
  })

  it('revoke on an EIP-712 scheme never touches the passkey signer', async () => {
    mockApi(EOA_SIGNERS)
    mockSigner.mockReturnValue({
      type: 'eoa',
      address: '0x' + 'ee'.repeat(20),
      walletClient: { signTypedData: vi.fn().mockResolvedValue('0x' + '11'.repeat(65)) },
    })
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/revoke')) {
        return Promise.resolve({
          signature_scheme: 'eip712_userop',
          signing_payload: { domain: {}, types: {}, primaryType: 'PackedUserOperation', message: {} },
          user_operation: {},
        })
      }
      return Promise.resolve({ revoked: true })
    })
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.revoke('0x' + 'ab'.repeat(32))
      expect(res.ok).toBe(true)
    })
    expect(mockSignUserOp).not.toHaveBeenCalled()
    expect(mockSignDelegation).not.toHaveBeenCalled()
  })
})

describe('multi-signer accounts (the Daniel regression)', () => {
  // Sequence that stranded a real user: sign with passkey → enroll an EOA
  // owner as backup → the account now has BOTH → the old passkeyOnly
  // predicate flipped false and every signing surface demanded the wallet,
  // abandoning the passkey that was still enrolled and still valid on-chain.
  const MIXED_SIGNERS = {
    account_address: '0x' + 'aa'.repeat(20),
    chain_id: 84532,
    owner_address: '0x' + 'ee'.repeat(20),
    passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
  }

  it('stays ready and signs with the passkey after an EOA owner is enrolled', async () => {
    mockApi(MIXED_SIGNERS)
    mockOnDevice.mockReturnValue(true) // the passkey is on this device
    const message = { delegate: '0xd', delegator: '0xa', authority: '0x0', caveats: [], salt: '1' }
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({ delegation_hash: '0xhash', version: 1, signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message } })
      }
      return Promise.resolve({ activated: true })
    })
    mockSignDelegation.mockResolvedValue('0x' + 'ab'.repeat(200))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.grant({
        tokenAddress: ('0x' + 'cc'.repeat(20)) as never,
        budgetAtomic: '1000',
        periodSeconds: 86400,
      })
      expect(res.ok).toBe(true)
    })
    expect(mockSignDelegation).toHaveBeenCalled()
  })

  it('revoke on a mixed account requests the webauthn scheme when the passkey is here', async () => {
    mockApi(MIXED_SIGNERS)
    mockOnDevice.mockReturnValue(true)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/revoke')) {
        return Promise.resolve({ signature_scheme: 'webauthn_userop', user_op_hash: '0xhash', user_operation: { nonce: '1n' } })
      }
      return Promise.resolve({ revoked: true })
    })
    mockSignUserOp.mockResolvedValue('0x' + 'ab'.repeat(200))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.revoke('0x' + 'ab'.repeat(32))
      expect(res.ok).toBe(true)
    })
    const prepareCall = mockPost.mock.calls.find(([url]) => String(url).endsWith('/revoke'))!
    expect(prepareCall[1]).toMatchObject({ signature_scheme: 'webauthn_userop' })
    expect(mockSignUserOp).toHaveBeenCalled()
  })

  it('falls back to the connected wallet when no passkey is on this device', async () => {
    mockApi(MIXED_SIGNERS)
    mockOnDevice.mockReturnValue(false)
    const signTypedData = vi.fn().mockResolvedValue('0x' + 'cd'.repeat(65))
    mockSigner.mockReturnValue({ type: 'eoa', address: MIXED_SIGNERS.owner_address, walletClient: { signTypedData } })
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/revoke')) {
        return Promise.resolve({ signature_scheme: 'eip712_userop', signing_payload: { domain: {}, types: {}, primaryType: 'PackedUserOperation', message: {} }, user_operation: { nonce: '1n' } })
      }
      return Promise.resolve({ revoked: true })
    })

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.revoke('0x' + 'ab'.repeat(32))
      expect(res.ok).toBe(true)
    })
    const prepareCall = mockPost.mock.calls.find(([url]) => String(url).endsWith('/revoke'))!
    expect(prepareCall[1]).toMatchObject({ signature_scheme: 'eip712_userop' })
    expect(signTypedData).toHaveBeenCalled()
  })
})

describe('pickSigningPath owner match (#2068)', () => {
  // The EOA rung takes the connected ADDRESS: "a wallet is connected" never
  // satisfied "the owner is connected". These pin the rung's address check
  // directly, independent of useActiveSigner's mirror of the same rule.
  const OWNER = '0x' + 'ee'.repeat(20)
  const OTHER = '0x' + '99'.repeat(20)
  const MIXED = {
    account_address: '0x' + 'aa'.repeat(20),
    chain_id: 84532,
    owner_address: OWNER,
    passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
  }

  it('mixed set + unrelated connected wallet → passkey, never eoa', () => {
    expect(pickSigningPath(MIXED as never, OTHER)).toBe('passkey')
  })

  it('mixed set + the owner wallet connected → eoa (case-insensitive)', () => {
    expect(pickSigningPath(MIXED as never, OWNER.toUpperCase().replace('0X', '0x'))).toBe('eoa')
  })

  it('owner-only set + unrelated connected wallet → null (offered-but-failing is worse than absent)', () => {
    expect(pickSigningPath({ ...MIXED, passkeys: [] } as never, OTHER)).toBeNull()
  })

  it('owner-only set + the owner wallet connected → eoa', () => {
    expect(pickSigningPath({ ...MIXED, passkeys: [] } as never, OWNER)).toBe('eoa')
  })

  it('a device-marked passkey still beats the connected owner wallet', () => {
    mockOnDevice.mockReturnValue(true)
    expect(pickSigningPath(MIXED as never, OWNER)).toBe('passkey')
  })

  it('hook-level: a mixed account with an UNRELATED wallet connected signs with the passkey, not the wallet', async () => {
    // Simulates the hydration-failed corner where useActiveSigner could only
    // offer the bare connected EOA: pickSigningPath must still refuse the
    // non-owner wallet and route the grant through the WebAuthn ceremony.
    const MIXED_SIGNERS = { ...MIXED }
    mockApi(MIXED_SIGNERS)
    mockOnDevice.mockReturnValue(false)
    const signTypedData = vi.fn()
    mockSigner.mockReturnValue({ type: 'eoa', address: OTHER, walletClient: { signTypedData } })
    const message = { delegate: '0xd', delegator: '0xa', authority: '0x0', caveats: [], salt: '1' }
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({ delegation_hash: '0xhash', version: 1, signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message } })
      }
      return Promise.resolve({ activated: true })
    })
    mockSignDelegation.mockResolvedValue('0x' + 'ab'.repeat(200))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.grant({
        tokenAddress: ('0x' + 'cc'.repeat(20)) as never,
        budgetAtomic: '1000',
        periodSeconds: 86400,
      })
      expect(res.ok).toBe(true)
    })
    expect(mockSignDelegation).toHaveBeenCalled()
    expect(signTypedData).not.toHaveBeenCalled()
  })
})

describe('revokeAll (#1402 remove step 1)', () => {
  const HASHES = ['0x' + 'ab'.repeat(32), '0x' + 'cd'.repeat(32)]

  it('one ceremony; submit carries the prepared delegation_hashes verbatim', async () => {
    mockApi(PASSKEY_SIGNERS)
    const userOp = { sender: '0xa', nonce: '7n' }
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/revoke-all')) {
        return Promise.resolve({
          signature_scheme: 'webauthn_userop',
          user_op_hash: '0xh',
          user_operation: userOp,
          delegation_hashes: HASHES,
        })
      }
      return Promise.resolve({ revoked: true })
    })
    mockSignUserOp.mockResolvedValue('0x' + 'ef'.repeat(200))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.revokeAll()
      expect(res.ok).toBe(true)
    })
    expect(mockSignUserOp).toHaveBeenCalledTimes(1)
    const submit = mockPost.mock.calls.find((c) => String(c[0]).endsWith('/revoke-all/submit'))!
    expect(submit[1]).toMatchObject({
      signature: '0x' + 'ef'.repeat(200),
      user_operation: userOp,
      delegation_hashes: HASHES,
    })
  })

  it("409 'Nothing to revoke' is SUCCESS — step 1 already satisfied, no ceremony", async () => {
    // The remove flow's retry semantics hinge on this: after a partial remove
    // (budgets dead, filing unfinished) the retry must sail through step 1.
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/revoke-all')) {
        return Promise.reject(new Error('Nothing to revoke'))
      }
      return Promise.resolve({})
    })

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.revokeAll()
      expect(res).toEqual({ ok: true })
    })
    expect(mockSignUserOp).not.toHaveBeenCalled()
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/submit'))).toBe(false)
  })

  it('a cancelled signature reports cancelled and never submits', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/revoke-all')) {
        return Promise.resolve({
          signature_scheme: 'webauthn_userop',
          user_op_hash: '0xh',
          user_operation: {},
          delegation_hashes: HASHES,
        })
      }
      return Promise.resolve({})
    })
    mockSignUserOp.mockRejectedValue(new Error('User rejected the request'))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.revokeAll()
      expect(res).toEqual({ ok: false, reason: 'cancelled' })
    })
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/submit'))).toBe(false)
  })

  it('any other prepare failure is a real failure, not silently ok', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/revoke-all')) {
        return Promise.reject(new Error('Internal server error'))
      }
      return Promise.resolve({})
    })

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.revokeAll()
      expect(res).toEqual({ ok: false, reason: 'failed' })
    })
  })
})

describe('editBudget — REPLACE composition (#3166)', () => {
  const OLD_HASH = '0x' + 'ab'.repeat(32)
  const NEW_HASH = '0x' + 'be'.repeat(32)
  const INPUT = {
    tokenAddress: ('0x' + 'cc'.repeat(20)) as never,
    budgetAtomic: '2000',
    periodSeconds: 86_400,
  }
  const DELEGATION_MESSAGE = { delegate: '0xd', delegator: '0xa', authority: '0x0', caveats: [], salt: '1' }

  /** build → activate → revoke-prepare → revoke-submit, all green. */
  function mockHappyPath() {
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({
          delegation_hash: NEW_HASH,
          version: 2,
          signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message: DELEGATION_MESSAGE },
        })
      }
      if (url.endsWith('/activate')) return Promise.resolve({ activated: true })
      if (url.endsWith('/revoke')) {
        return Promise.resolve({
          signature_scheme: 'webauthn_userop',
          user_op_hash: '0xr',
          user_operation: { nonce: '9n' },
        })
      }
      if (url.endsWith('/revoke/submit')) return Promise.resolve({ revoked: true })
      return Promise.reject(new Error('unexpected ' + url))
    })
    mockSignDelegation.mockResolvedValue('0x' + 'aa'.repeat(100))
    mockSignUserOp.mockResolvedValue('0x' + 'bb'.repeat(100))
  }

  it('success: build → owner signs new grant → activate → owner signs revoke → submit; no rekey/rotate call is EVER made', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockHappyPath()
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.editBudget(OLD_HASH, INPUT)
      expect(res).toEqual({ ok: true, newDelegationHash: NEW_HASH, oldDelegationRevoked: true })
    })
    // Wire order: the old delegation hash goes ONLY to the revoke routes.
    const urls = mockPost.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual([
      expect.stringContaining('/delegations/build'),
      expect.stringContaining(`/delegations/${NEW_HASH}/activate`),
      expect.stringContaining(`/delegations/${OLD_HASH}/revoke`),
      expect.stringContaining(`/delegations/${OLD_HASH}/revoke/submit`),
    ])
    // The delegate key and local signer are untouched: no rotate/rekey/recover
    // endpoint is called anywhere in the composition.
    expect(urls.some((u) => /rekey|rotate|recover|signer/i.test(u))).toBe(false)
    // Both signatures are OWNER signatures made client-side.
    expect(mockSignDelegation).toHaveBeenCalledWith(PASSKEY_SIGNERS, DELEGATION_MESSAGE)
    expect(mockSignUserOp).toHaveBeenCalledWith(PASSKEY_SIGNERS, { nonce: '9n' })
  })

  it('prefill-ish expiry: opts.expires_at rides the build body when given', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockHappyPath()
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      await result.current.editBudget(OLD_HASH, INPUT, { expiresAt: 4_102_444_800 })
    })
    const build = mockPost.mock.calls.find((c) => String(c[0]).endsWith('/build'))!
    expect(build[1]).toMatchObject({ expires_at: 4_102_444_800 })
  })

  it('abandoned at the NEW-grant signature: cancelled, nothing activated, nothing revoked', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({
          delegation_hash: NEW_HASH,
          version: 2,
          signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message: DELEGATION_MESSAGE },
        })
      }
      return Promise.reject(new Error('unexpected ' + url))
    })
    mockSignDelegation.mockRejectedValue(new Error('User rejected the request'))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.editBudget(OLD_HASH, INPUT)
      expect(res).toEqual({ ok: false, reason: 'cancelled' })
    })
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/activate'))).toBe(false)
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/revoke'))).toBe(false)
  })

  it('build refused (e.g. re-key in flight): the backend 409 travels as refused with its own sentence', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.reject(
          new Error(
            'A key rotation is in flight for this agent — finish or abandon the re-key before granting a new budget',
          ),
        )
      }
      return Promise.reject(new Error('unexpected ' + url))
    })

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.editBudget(OLD_HASH, INPUT)
      expect(res).toEqual({
        ok: false,
        reason: 'refused',
        detail:
          'A key rotation is in flight for this agent — finish or abandon the re-key before granting a new budget',
      })
    })
    expect(mockSignDelegation).not.toHaveBeenCalled()
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/activate'))).toBe(false)
  })

  it('activation raced a revoke-all (409 no longer pending): failed, old state untouched, no revoke attempted', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({
          delegation_hash: NEW_HASH,
          version: 2,
          signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message: DELEGATION_MESSAGE },
        })
      }
      if (url.endsWith('/activate')) return Promise.reject(new Error('Delegation is no longer pending'))
      return Promise.reject(new Error('unexpected ' + url))
    })
    mockSignDelegation.mockResolvedValue('0x' + 'aa'.repeat(100))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.editBudget(OLD_HASH, INPUT)
      expect(res).toEqual({ ok: false, reason: 'failed' })
    })
    expect(mockPost.mock.calls.some((c) => String(c[0]).endsWith(`/delegations/${OLD_HASH}/revoke`))).toBe(false)
  })

  it("the old budget was ALREADY revoked before the stop: still success (oldDelegationRevoked: false), no stop ceremony", async () => {
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({
          delegation_hash: NEW_HASH,
          version: 2,
          signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message: DELEGATION_MESSAGE },
        })
      }
      if (url.endsWith('/activate')) return Promise.resolve({ activated: true })
      if (url.endsWith('/revoke')) {
        return Promise.reject(new Error('Already revoked — the delegation was disabled on-chain and the record has been reconciled.'))
      }
      return Promise.reject(new Error('unexpected ' + url))
    })
    mockSignDelegation.mockResolvedValue('0x' + 'aa'.repeat(100))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.editBudget(OLD_HASH, INPUT)
      expect(res).toEqual({ ok: true, newDelegationHash: NEW_HASH, oldDelegationRevoked: false })
    })
    expect(mockSignUserOp).not.toHaveBeenCalled()
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/revoke/submit'))).toBe(false)
  })

  it('stop signature cancelled AFTER the new grant is live: revoke_unfinished names the live budget', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({
          delegation_hash: NEW_HASH,
          version: 2,
          signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message: DELEGATION_MESSAGE },
        })
      }
      if (url.endsWith('/activate')) return Promise.resolve({ activated: true })
      if (url.endsWith('/revoke')) {
        return Promise.resolve({
          signature_scheme: 'webauthn_userop',
          user_op_hash: '0xr',
          user_operation: { nonce: '9n' },
        })
      }
      return Promise.reject(new Error('unexpected ' + url))
    })
    mockSignDelegation.mockResolvedValue('0x' + 'aa'.repeat(100))
    mockSignUserOp.mockRejectedValue(new Error('User rejected the request'))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.editBudget(OLD_HASH, INPUT)
      expect(res).toEqual({ ok: false, reason: 'revoke_unfinished', newDelegationHash: NEW_HASH })
    })
    // The stop was prepared but never submitted — the owner finishes it later.
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/revoke/submit'))).toBe(false)
  })

  it('revoke submit fails AFTER the new grant is live: same revoke_unfinished partial state', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/build')) {
        return Promise.resolve({
          delegation_hash: NEW_HASH,
          version: 2,
          signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message: DELEGATION_MESSAGE },
        })
      }
      if (url.endsWith('/activate')) return Promise.resolve({ activated: true })
      if (url.endsWith('/revoke')) {
        return Promise.resolve({
          signature_scheme: 'webauthn_userop',
          user_op_hash: '0xr',
          user_operation: { nonce: '9n' },
        })
      }
      if (url.endsWith('/revoke/submit')) return Promise.reject(new Error('Batch revocation failed'))
      return Promise.reject(new Error('unexpected ' + url))
    })
    mockSignDelegation.mockResolvedValue('0x' + 'aa'.repeat(100))
    mockSignUserOp.mockResolvedValue('0x' + 'bb'.repeat(100))

    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      const res = await result.current.editBudget(OLD_HASH, INPUT)
      expect(res).toEqual({ ok: false, reason: 'revoke_unfinished', newDelegationHash: NEW_HASH })
    })
  })

  it('is edit-in-place only: it never calls revokeAll or touches other budgets', async () => {
    mockApi(PASSKEY_SIGNERS)
    mockHappyPath()
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => {
      await result.current.editBudget(OLD_HASH, INPUT)
    })
    const urls = mockPost.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/revoke-all'))).toBe(false)
  })
})

describe('useDelegationBudget visible-only polling (#2732)', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
    mockSigner.mockReset()
    mockSigner.mockReturnValue(null)
    mockOnDevice.mockReset()
    mockOnDevice.mockReturnValue(false)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a failed silent tick keeps the budget rows and does not flip budgetsError', async () => {
    mockApi(PASSKEY_SIGNERS)
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.budgets).toEqual([])
    expect(result.current.budgetsError).toBe(false)
    const callsAfterMount = mockGet.mock.calls.length

    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/delegations')) return Promise.reject(new Error('500 mid-demo'))
      if (url.endsWith('/account-signers')) return Promise.resolve(PASSKEY_SIGNERS)
      return Promise.reject(new Error('unexpected ' + url))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    // The tick fetched only budgets (the device signer set is NOT polled).
    expect(mockGet.mock.calls.length).toBe(callsAfterMount + 1)
    expect(mockGet.mock.calls[callsAfterMount][0]).toContain('/delegations')
    expect(result.current.budgets).toEqual([])
    expect(result.current.budgetsError).toBe(false)
  })

  it('a successful silent tick refreshes the budget rows', async () => {
    mockApi(PASSKEY_SIGNERS)
    const { result } = renderHook(() => useDelegationBudget(AGENT, 84532))
    await act(async () => {
      await Promise.resolve()
    })

    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/delegations')) {
        return Promise.resolve({
          delegations: [{ id: 'd1', status: 'active', budget_atomic: '1000000' }],
        })
      }
      if (url.endsWith('/account-signers')) return Promise.resolve(PASSKEY_SIGNERS)
      return Promise.reject(new Error('unexpected ' + url))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.budgets).toHaveLength(1)
    expect(result.current.budgetsError).toBe(false)
  })
})
