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

const { useDelegationBudget } = await import('@/hooks/useDelegationBudget')

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
