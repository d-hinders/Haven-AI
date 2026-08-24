/**
 * Replace signing key — the guarantees, not the markup (#1701).
 *
 * Every assertion here is about something a user could be MISLED by, because
 * this modal drives an irreversible authority change whose reachable states
 * must stay aligned with later backend fixes. The interesting failures are all
 * copy that is confidently wrong, so the tests query by role and name and
 * assert on sentences rather than class names.
 *
 * Paired-absence discipline: every "X is not shown" assertion has a sibling
 * case in the same file proving X IS shown under the opposite condition.
 * A missing element only proves suppression when something can produce it.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseActiveSigner,
  mockApiGet,
  mockApiPost,
  mockOnDevice,
  mockSignUserOpWithPasskey,
  mockSignDelegationWithPasskey,
} = vi.hoisted(() => ({
  mockUseActiveSigner: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockOnDevice: vi.fn(),
  mockSignUserOpWithPasskey: vi.fn(),
  mockSignDelegationWithPasskey: vi.fn(),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (...args: unknown[]) => mockUseActiveSigner(...args),
  hasPasskeyCredentialOnDevice: (...args: unknown[]) => mockOnDevice(...args),
  credentialIdFromKeyId: (k: string) => k,
}))

// The two WebAuthn ceremonies, stubbed at the module the hook lazily imports.
// Stubbing here rather than inside the kit keeps the assertions about WHICH
// artefact each step hands the account — the thing #1890 is about — instead of
// about signature bytes no test can verify anyway.
vi.mock('@/lib/delegationPasskeySigner', () => ({
  signUserOpWithPasskey: (...args: unknown[]) => mockSignUserOpWithPasskey(...args),
  signDelegationWithPasskey: (...args: unknown[]) => mockSignDelegationWithPasskey(...args),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { get: (...a: unknown[]) => mockApiGet(...a), post: (...a: unknown[]) => mockApiPost(...a) },
  }
})

import { ReplaceSigningKeyModal } from '../ReplaceSigningKeyModal'

/**
 * The irreversibility gate as a BOX, found without naming a class (#1887).
 *
 * The first draft of this used `closest('div.rounded-[10px]')`, which is
 * `ApprovalRequiredBanner`'s literal Tailwind frame class — a shared primitive
 * this file does not own, so a restyle there would have broken these two tests
 * for a reason unrelated to the gate (code review on #1887).
 *
 * Instead: walk up from the banner's title until an ancestor also contains the
 * acknowledgement checkbox. That is the gate's definition rather than its
 * styling — "the box holding both the warning and the thing that unlocks it" —
 * and it is what the assertions actually mean. Returns null when there is no
 * such ancestor, so the paired-absence test can assert its absence honestly.
 */
function gateBox(): HTMLElement | null {
  const title = screen.queryByText(/the next step cannot be undone/i)
  const checkbox = screen.queryByRole('checkbox')
  if (!title || !checkbox) return null
  let node: HTMLElement | null = title.parentElement
  while (node && !node.contains(checkbox)) node = node.parentElement
  return node
}
import { ApiRequestError } from '@/lib/api'

const CURRENT = '0x2222222222222222222222222222222222222222'
const NEXT = '0x3333333333333333333333333333333333333333'

/** An account whose owner wallet is connected — the signable shape. */
function eoaSigner() {
  return { type: 'eoa', address: '0x5555555555555555555555555555555555555555', walletClient: { signTypedData: vi.fn().mockResolvedValue('0xsig') } }
}

function renderModal(overrides: Partial<React.ComponentProps<typeof ReplaceSigningKeyModal>> = {}) {
  const props: React.ComponentProps<typeof ReplaceSigningKeyModal> = {
    open: true,
    onClose: vi.fn(),
    agentId: 'agent-1',
    agentName: 'Research agent',
    chainId: 8453,
    isDelegationAgent: true,
    currentDelegateAddress: CURRENT,
    recentPayments: [],
    hasAnchoredPassport: false,
    onCompleted: vi.fn(),
    ...overrides,
  }
  return { ...render(<ReplaceSigningKeyModal {...props} />), props }
}

/**
 * The account's signer set is fetched on open, so EVERY step is gated until
 * it lands. Without this wait the flow is blocked for the #1870 reason and a
 * test asserting "Continue is disabled" would pass no matter what it meant to
 * prove — which is exactly how the signing-path pair below was first wrong.
 */
async function waitForSignerReady() {
  await waitFor(() =>
    expect(screen.queryByText(/cannot replace this key from this device/i)).toBeNull(),
  )
}

/** Walk reason → address → consequences with a valid new address. */
async function advanceToConsequences() {
  await waitForSignerReady()
  fireEvent.click(screen.getByRole('radio', { name: /it is lost/i }))
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))
  fireEvent.change(screen.getByLabelText(/new signing address/i), { target: { value: NEXT } })
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(screen.getByText(/what carries over/i)).toBeInTheDocument())
}

beforeEach(() => {
  mockUseActiveSigner.mockReturnValue(eoaSigner())
  mockOnDevice.mockReturnValue(false)
  mockSignUserOpWithPasskey.mockResolvedValue('0xpasskeyop')
  mockSignDelegationWithPasskey.mockResolvedValue('0xpasskeydelegation')
  mockApiGet.mockResolvedValue({
    account_address: '0x9999999999999999999999999999999999999999',
    chain_id: 8453,
    owner_address: '0x5555555555555555555555555555555555555555',
    passkeys: [],
  })
  mockApiPost.mockResolvedValue({
    rekey_id: 'rk-1',
    stage: 'preflight',
    old_delegate_address: CURRENT,
    new_delegate_address: NEXT,
    residual: { atomic: '0', token_address: null, disposition: 'none', recoverable_after_rekey: false },
    delegations_to_revoke: ['0xhash'],
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('the point of no return (#1868)', () => {
  it('gates the destructive step behind an explicit acknowledgement', async () => {
    renderModal()
    await advanceToConsequences()

    const proceed = screen.getByRole('button', { name: /switch off the old key/i })
    expect(proceed).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(proceed).toBeEnabled()
  })

  /**
   * The gate must be STRUCTURAL, not merely adjacent (#1887).
   *
   * `ui/Modal` renders its footer outside the scrolling body, so a footer
   * button is on screen from the first paint however deep the body runs. At
   * 390px this body is roughly 2.7 screen-heights, which put the irreversible
   * control about three screens ABOVE the banner explaining it and the
   * checkbox enabling it — reachable, and easiest to mis-tap, before its own
   * gate. Position is the fix: the button is the banner's last child.
   *
   * Asserted by CONTAINMENT rather than document order, and the distinction is
   * the whole test. The footer already came after the body in the DOM, so an
   * order assertion was green against the defect and would have proved
   * nothing. Verified by mutation: returning `destructiveButton()` to the
   * footer fails this on `expect(gate).toContainElement(proceed)`.
   */
  it('renders the destructive control inside the gate, not in the sticky footer', async () => {
    renderModal()
    await advanceToConsequences()

    const gate = gateBox()
    // Sanity, so a change to the banner's structure fails loudly here instead
    // of silently scoping the real assertion to the wrong node and passing.
    expect(gate).not.toBeNull()

    const proceed = screen.getByRole('button', { name: /switch off the old key/i })
    expect(gate).toContainElement(proceed)
    // Exactly one — the footer must not keep a second copy of it.
    expect(screen.getAllByRole('button', { name: /switch off the old key/i })).toHaveLength(1)
    // Inside the gate, it still comes after the acknowledgement it depends on.
    expect(
      within(gate as HTMLElement)
        .getAllByRole('checkbox')[0]
        .compareDocumentPosition(proceed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('says the agent cannot pay and that stopping means starting the budget over', async () => {
    renderModal()
    await advanceToConsequences()

    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()
    expect(screen.getByText(/cannot pay anything/i)).toBeInTheDocument()
    expect(screen.getByText(/setting its budget up from scratch/i)).toBeInTheDocument()
  })

  it('tells the user that up to this point stopping is free', async () => {
    renderModal()
    await advanceToConsequences()
    expect(screen.getByText(/nothing has changed and closing this is free/i)).toBeInTheDocument()
  })

  /**
   * The inverse of the guarantee above, and the one that would actually
   * mislead: no copy in the flow may suggest a half-finished re-key is
   * recoverable, because it is not (#1868 — the in-flight row is never
   * expired and the revoke is not undone).
   */
  it('never offers "you can finish this later" anywhere in the flow', async () => {
    const { container } = renderModal()
    await advanceToConsequences()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/finish (this )?later/i)
    expect(text).not.toMatch(/resume (it )?later/i)
    expect(text).not.toMatch(/come back (to this )?(any ?time|later)/i)
  })
})

describe('budget-boundary carry (#1849)', () => {
  it('says closed-period remainder is dropped while recurring budgets keep their schedule', async () => {
    renderModal()
    await advanceToConsequences()
    expect(screen.getByText(/finish the remaining steps now/i)).toBeInTheDocument()
    expect(screen.getByText(/remainder from the closed period is dropped/i)).toBeInTheDocument()
    expect(screen.getByText(/recurring budget.*existing schedule/i)).toBeInTheDocument()
  })

  it('does not retain the obsolete zero-budget warning', async () => {
    const { container } = renderModal()
    await advanceToConsequences()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/nothing to spend until the (following|next) period/i)
    expect(text).not.toMatch(/silently carry zero/i)
  })
})

describe('passport re-anchoring (#1699)', () => {
  it('says the public record catches up asynchronously when the agent has a passport', async () => {
    renderModal({ hasAnchoredPassport: true })
    await advanceToConsequences()
    expect(screen.getByText(/public record updates separately/i)).toBeInTheDocument()
    expect(screen.getByText(/standing in Haven remains unchanged/i)).toBeInTheDocument()
    expect(screen.getByText(/retired and replaced with one naming the new signing address/i)).toBeInTheDocument()
    expect(screen.getByText(/updating on-chain/i)).toBeInTheDocument()
  })

  // Paired absence: the sibling above proves the warning is producible.
  it('omits the passport warning when the agent has no passport', async () => {
    renderModal({ hasAnchoredPassport: false })
    await advanceToConsequences()
    expect(screen.queryByText(/public record updates separately/i)).toBeNull()
  })

  it('does not retain the obsolete permanently-stale passport warning', async () => {
    const { container } = renderModal({ hasAnchoredPassport: true })
    await advanceToConsequences()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/nothing updates it yet/i)
    expect(text).not.toMatch(/out of date rather than catching up/i)
  })
})

describe('completion budget summary (#1849)', () => {
  it('treats an expired carry as informational when an active replacement was issued', async () => {
    fullRunOn('eip712_userop', {
      carryRole: 'steady',
      skipped: [{ reason: 'The carry window closed before issue.' }],
    })
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /switch off the old key/i }))

    await waitFor(() => expect(screen.getByText(/signing key replaced/i)).toBeInTheDocument())
    expect(screen.getByText(/old budget pieces were not re-issued/i)).toBeInTheDocument()
    expect(screen.getByText(/active replacement budget rules were issued/i)).toBeInTheDocument()
    expect(screen.queryByText(/cannot spend until you set a new budget/i)).toBeNull()
    expect(screen.queryByText(/no budget was carried over/i)).toBeNull()
  })

  it('also describes a fully spent piece honestly when an active replacement was issued', async () => {
    fullRunOn('eip712_userop', {
      carryRole: 'steady',
      skipped: [{ reason: 'The prior period was fully spent.' }],
    })
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /switch off the old key/i }))

    await waitFor(() => expect(screen.getByText(/signing key replaced/i)).toBeInTheDocument())
    expect(screen.getByText(/nothing remained or their time windows had closed/i)).toBeInTheDocument()
    expect(screen.getByText(/active replacement budget rules were issued/i)).toBeInTheDocument()
    expect(screen.queryByText(/cannot spend until you set a new budget/i)).toBeNull()
  })
})

describe('lost versus compromised', () => {
  const payments = [
    {
      type: 'payment' as const,
      id: 'p1',
      token: 'USDC',
      amount: '12.50',
      to: '0xabc',
      status: 'completed',
      tx_hash: null,
      created_at: '2026-08-20T10:00:00Z',
    },
  ]

  it('surfaces recent spend on the compromised path', async () => {
    renderModal({ recentPayments: payments as never })
    await waitForSignerReady()
    fireEvent.click(screen.getByRole('radio', { name: /someone else/i }))
    expect(screen.getByText(/recent spending to review/i)).toBeInTheDocument()
    expect(screen.getByText(/12\.50 USDC/)).toBeInTheDocument()
  })

  // Paired absence.
  it('does not surface spend on the lost path', async () => {
    renderModal({ recentPayments: payments as never })
    await waitForSignerReady()
    fireEvent.click(screen.getByRole('radio', { name: /it is lost/i }))
    expect(screen.queryByText(/recent spending to review/i)).toBeNull()
  })

  it('is honest that replacing a key does not reverse a settled payment', async () => {
    renderModal({ recentPayments: payments as never })
    await waitForSignerReady()
    fireEvent.click(screen.getByRole('radio', { name: /someone else/i }))
    expect(screen.getByText(/does not reverse a payment that already/i)).toBeInTheDocument()
  })
})

describe('rail refusal', () => {
  it('explains re-onboarding instead of presenting a dead control', () => {
    renderModal({ isDelegationAgent: false })
    expect(screen.getByText(/not available for this agent/i)).toBeInTheDocument()
    expect(screen.getByText(/connect the agent again/i)).toBeInTheDocument()
    // No path into the destructive flow exists at all on this rail.
    expect(screen.queryByRole('button', { name: /switch off the old key/i })).toBeNull()
  })

  // Paired: the delegation rail DOES reach the flow, so the absence above is
  // suppression rather than the control never existing.
  it('reaches the flow on the delegation rail', async () => {
    renderModal({ isDelegationAgent: true })
    await advanceToConsequences()
    expect(screen.getByRole('button', { name: /switch off the old key/i })).toBeInTheDocument()
  })
})

/** A passkey-owned account: no EOA owner anywhere, one enrolled passkey. */
function passkeyOnlyAccount() {
  mockUseActiveSigner.mockReturnValue(null)
  mockApiGet.mockResolvedValue({
    account_address: '0x9999999999999999999999999999999999999999',
    chain_id: 8453,
    owner_address: null,
    passkeys: [{ key_id: '0xkey1' }],
  })
}

/**
 * An account with BOTH an EOA owner and an enrolled passkey, where the passkey
 * is the signer reachable on this device. This is the population #1870's
 * `signWith` fix exists for, and the one the backend's old inference
 * silently mis-prepared: it saw an EOA owner and sized the UserOperation for a
 * 65-byte signature that a several-hundred-byte WebAuthn signature would then
 * fail against — after the revoke.
 */
function multiSignerOnPasskeyDevice() {
  mockUseActiveSigner.mockReturnValue(eoaSigner())
  mockOnDevice.mockReturnValue(true)
  mockApiGet.mockResolvedValue({
    account_address: '0x9999999999999999999999999999999999999999',
    chain_id: 8453,
    owner_address: '0x5555555555555555555555555555555555555555',
    passkeys: [{ key_id: '0xkey1' }],
  })
}

/**
 * A full run whose revoke prepare answers on `scheme`, driven to completion.
 * Returns the recorded calls so a test can assert what each step was handed.
 */
function fullRunOn(
  scheme: 'eip712_userop' | 'webauthn_userop',
  issueOptions: {
    carryRole?: 'carry' | 'steady' | 'reanchor'
    skipped?: Array<{ reason: string }>
  } = {},
) {
  mockApiPost.mockImplementation(async (path: string) => {
    if (path.endsWith('/rekey')) {
      return {
        rekey_id: 'rk-1',
        stage: 'preflight',
        old_delegate_address: CURRENT,
        new_delegate_address: NEXT,
        residual: { atomic: '0', token_address: null, disposition: 'none', recoverable_after_rekey: false },
        delegations_to_revoke: ['0xhash'],
      }
    }
    if (path.endsWith('/revoke')) {
      // The server answers on ONE branch or the other, never both — the
      // WebAuthn branch deliberately omits `signing_payload` so a client
      // cannot sign the wrong artefact for the scheme it was handed.
      return scheme === 'webauthn_userop'
        ? {
            signature_scheme: 'webauthn_userop',
            user_op_hash: '0xuserophash',
            user_operation: { sender: '0xacc', nonce: '1n' },
            treasury_address: '0xacc',
            delegation_hashes: ['0xhash'],
            instructions: 'Sign user_op_hash with the account passkey (WebAuthn), then submit',
          }
        : {
            signature_scheme: 'eip712_userop',
            signing_payload: { domain: {}, types: {}, primaryType: 'PackedUserOperation', message: {} },
            user_operation: { sender: '0xacc', nonce: '1n' },
            treasury_address: '0xacc',
            delegation_hashes: ['0xhash'],
            instructions: 'Sign signing_payload (EIP-712) with the treasury owner key, then submit',
          }
    }
    if (path.endsWith('/revoke/submit')) return { stage: 'metered' }
    if (path.endsWith('/issue')) {
      return {
        stage: 'issued',
        delegate_account_address: '0xacc',
        delegations: [
          {
            delegation_hash: '0xd1',
            carry_role: issueOptions.carryRole ?? 'carry',
            token_address: '0xusdc',
            budget_atomic: '1000',
            period_seconds: 86400,
            start_date: 0,
            expires_at: 0,
            signing_payload: { domain: {}, types: {}, primaryType: 'Delegation', message: { delegate: NEXT } },
          },
        ],
        skipped: issueOptions.skipped ?? [],
      }
    }
    if (path.endsWith('/complete')) {
      return {
        api_key: 'sk_agent_new',
        api_key_prefix: 'sk_agent_ne',
        new_delegate_address: NEXT,
        invalidated_intents: 0,
        superseded_delegations: 0,
        residual_on_old_delegate: { atomic: '0' },
      }
    }
    return {}
  })
}

function revokePrepareBody(): Record<string, unknown> {
  const call = mockApiPost.mock.calls.find(
    (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).endsWith('/revoke'),
  )
  return (call?.[1] ?? {}) as Record<string, unknown>
}

describe('passkey owners can re-key (#1890)', () => {
  /**
   * The user-facing point of the whole issue. #1881 refused every non-EOA
   * signing path up front, correctly, because the backend could not be told
   * which signer would sign and guessing would have put the failure AFTER the
   * revoke (#1868's permanent wedge). PR #1891 removed that condition, so the
   * refusal now blocks a population the backend serves correctly.
   *
   * Asserted on the DESTRUCTIVE button rather than on the banner's absence:
   * the banner is the symptom, the dead irreversible control was the defect.
   */
  it('lets a passkey-only account reach the irreversible step', async () => {
    passkeyOnlyAccount()
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: /switch off the old key/i })).toBeEnabled()
    expect(screen.queryByText(/cannot replace this key from this device/i)).toBeNull()
  })

  it('tells the backend it will sign with a passkey, and signs the prepared op', async () => {
    passkeyOnlyAccount()
    fullRunOn('webauthn_userop')
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /switch off the old key/i }))

    await waitFor(() => expect(screen.getByText(/signing key replaced/i)).toBeInTheDocument())

    // 2. The scheme is SENT, not inferred server-side — this is what sizes the
    //    UserOperation's verificationGasLimit for the signature it will carry.
    expect(revokePrepareBody()).toEqual({ signature_scheme: 'webauthn_userop' })
    // 4. And the signing step branched on the discriminant: the WebAuthn
    //    ceremony ran, and the EOA wallet was never asked.
    expect(mockSignUserOpWithPasskey).toHaveBeenCalledTimes(1)
    expect(mockSignUserOpWithPasskey.mock.calls[0][1]).toMatchObject({ sender: '0xacc' })
  })

  /**
   * `complete` runs PAST the revoke. Unblocking the passkey path at the revoke
   * alone would have carried a passkey owner over the point of no return and
   * then thrown "connect your owner wallet" on the far side — a failure this
   * change would have INTRODUCED after the irreversible step, recoverable only
   * by a manual owner re-grant (#1868). So the end-to-end run is the test, not
   * the revoke in isolation.
   */
  it('signs the replacement delegations with the passkey too, not just the revoke', async () => {
    passkeyOnlyAccount()
    fullRunOn('webauthn_userop')
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /switch off the old key/i }))

    await waitFor(() => expect(screen.getByText(/signing key replaced/i)).toBeInTheDocument())

    expect(mockSignDelegationWithPasskey).toHaveBeenCalledTimes(1)
    // The delegation MESSAGE is what the kit signs — the typed data IS the
    // delegation, exactly as the budget-grant sibling does it.
    expect(mockSignDelegationWithPasskey.mock.calls[0][1]).toMatchObject({ delegate: NEXT })
    // And the new API key came back, which only happens on a completed re-key.
    expect(screen.getByText(/sk_agent_new/)).toBeInTheDocument()
  })

  it('uses the passkey on a multi-signer account whose reachable signer is one', async () => {
    multiSignerOnPasskeyDevice()
    fullRunOn('webauthn_userop')
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /switch off the old key/i }))

    await waitFor(() => expect(screen.getByText(/signing key replaced/i)).toBeInTheDocument())
    // An EOA owner EXISTS on this account. The device still decides.
    expect(revokePrepareBody()).toEqual({ signature_scheme: 'webauthn_userop' })
    expect(mockSignUserOpWithPasskey).toHaveBeenCalledTimes(1)
  })

  /**
   * The discriminant wins over local state, and this is the only test that can
   * tell the two apart — everywhere else they agree, so branching on
   * `signingPath` would pass every other assertion in this file.
   *
   * Only the SERVER knows which signature the UserOperation was estimated for.
   * A client that signs on its own guess signs the wrong artefact for the op
   * it was handed, which is the entire class of defect #1870 was about. The
   * refusal lands before `revoke/submit`, so nothing is revoked and the
   * re-key is still retryable at `preflight`.
   */
  it('signs what the server resolved, not what this device assumed', async () => {
    passkeyOnlyAccount()
    fullRunOn('eip712_userop') // the device would have guessed webauthn
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /switch off the old key/i }))

    await waitFor(() => expect(screen.getByText(/that did not go through/i)).toBeInTheDocument())
    // No WebAuthn ceremony over an op prepared for a 65-byte signature...
    expect(mockSignUserOpWithPasskey).not.toHaveBeenCalled()
    // ...and nothing was submitted, so the revoke never landed.
    expect(
      mockApiPost.mock.calls.some(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).endsWith('/revoke/submit'),
      ),
    ).toBe(false)
  })

  /**
   * Paired regression: the EOA path #1881 shipped is untouched. Without this,
   * "the passkey path works" could be satisfied by a hook that took the
   * passkey branch for everyone.
   */
  it('leaves the EOA owner path exactly as it was', async () => {
    fullRunOn('eip712_userop')
    const wallet = eoaSigner()
    mockUseActiveSigner.mockReturnValue(wallet)
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /switch off the old key/i }))

    await waitFor(() => expect(screen.getByText(/signing key replaced/i)).toBeInTheDocument())
    expect(revokePrepareBody()).toEqual({ signature_scheme: 'eip712_userop' })
    expect(mockSignUserOpWithPasskey).not.toHaveBeenCalled()
    expect(mockSignDelegationWithPasskey).not.toHaveBeenCalled()
    // Two EIP-712 signatures: the revoke UserOperation and one delegation.
    expect(wallet.walletClient.signTypedData).toHaveBeenCalledTimes(2)
  })
})

describe('signing-path refusal — the one reason left (#1890)', () => {
  /**
   * The refusal gates the IRREVERSIBLE action, not the reading of it — so the
   * assertion is on the destructive button, which is the actual guarantee.
   * Asserting on "Continue" would have tested navigation, which is
   * deliberately still open so a blocked owner can learn what they need.
   */
  it('refuses the destructive action when no owner wallet is reachable', async () => {
    mockUseActiveSigner.mockReturnValue(null)
    renderModal()
    await waitFor(() =>
      expect(screen.getByText(/cannot replace this key from this device/i)).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('radio', { name: /it is lost/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    fireEvent.change(screen.getByLabelText(/new signing address/i), { target: { value: NEXT } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(screen.getByText(/what carries over/i)).toBeInTheDocument())

    // Even acknowledged, the irreversible step stays dead.
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: /switch off the old key/i })).toBeDisabled()
  })

  // Paired: identical journey, wallet connected — the same control is live.
  it('allows the destructive action when the owner wallet is connected', async () => {
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: /switch off the old key/i })).toBeEnabled()
  })

  it('still lets a blocked owner read what the flow will cost', async () => {
    mockUseActiveSigner.mockReturnValue(null)
    renderModal()
    await waitFor(() =>
      expect(screen.getByText(/cannot replace this key from this device/i)).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('radio', { name: /it is lost/i }))
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled()
  })

  /**
   * The refusal must not still claim passkeys are the problem. It is the
   * copy, not the predicate, that a user reads — and this sentence would now
   * be false, telling an owner to go and find a wallet they may not have when
   * a passkey on another device would do.
   */
  it('no longer tells the owner that passkeys are unsupported', async () => {
    mockUseActiveSigner.mockReturnValue(null)
    renderModal()
    await waitFor(() =>
      expect(screen.getByText(/cannot replace this key from this device/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/passkey is not supported/i)).toBeNull()
    expect(screen.getByText(/or use a device with one of its passkeys/i)).toBeInTheDocument()
  })
})

describe('non-custody', () => {
  it('states the private key never reaches Haven, on the step that asks for an address', async () => {
    renderModal()
    await waitForSignerReady()
    fireEvent.click(screen.getByRole('radio', { name: /it is lost/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByText(/haven never receives the private key/i)).toBeInTheDocument()
    expect(screen.getByText(/no way to move one between machines/i)).toBeInTheDocument()
  })

  it('refuses the address currently in use', async () => {
    renderModal()
    await waitForSignerReady()
    fireEvent.click(screen.getByRole('radio', { name: /it is lost/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    fireEvent.change(screen.getByLabelText(/new signing address/i), { target: { value: CURRENT } })
    expect(screen.getByText(/that is the address you are replacing/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
  })
})

describe('stranded funds on the retired address', () => {
  it('names the amount and that it becomes permanently unmovable', async () => {
    // A REAL ApiRequestError, not a lookalike: `classify` narrows on
    // `instanceof`, so a hand-rolled object with the right fields would fall
    // through to the generic branch and the test would prove nothing.
    mockApiPost.mockRejectedValueOnce(
      new ApiRequestError('residual_funds_on_old_delegate', 409, {
        error: 'residual_funds_on_old_delegate',
        residual_atomic: '2000',
        residual_token_address: '0xusdc',
      }),
    )
    renderModal()
    await waitForSignerReady()
    fireEvent.click(screen.getByRole('radio', { name: /it is lost/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    fireEvent.change(screen.getByLabelText(/new signing address/i), { target: { value: NEXT } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() =>
      expect(screen.getByText(/money on the old signing address/i)).toBeInTheDocument(),
    )
    expect(screen.getByText(/stays there permanently/i)).toBeInTheDocument()
    // Blocked until the owner says what happened to it.
    expect(screen.getByRole('button', { name: /switch off the old key/i })).toBeDisabled()
  })
})

/**
 * The three states the code review found dead-ended, all of them AFTER the
 * irreversible step — which is the worst place to have no way forward.
 */
describe('recovering from a failure past the point of no return', () => {
  /** Drive a full run whose `revoke` succeeds and whose next call fails. */
  async function revokeThenFail(failOn: 'issue' | 'complete') {
    mockApiPost.mockImplementation(async (path: string) => {
      if (path.endsWith('/rekey')) {
        return {
          rekey_id: 'rk-1',
          stage: 'preflight',
          old_delegate_address: CURRENT,
          new_delegate_address: NEXT,
          residual: { atomic: '0', token_address: null, disposition: 'none', recoverable_after_rekey: false },
          delegations_to_revoke: ['0xhash'],
        }
      }
      if (path.endsWith('/revoke')) {
        return { revoked: true, stage: 'metered' } // no on-chain grants to revoke
      }
      if (path.endsWith('/issue')) {
        if (failOn === 'issue') {
          throw new ApiRequestError('rekey_out_of_order', 409, { error: 'rekey_out_of_order', stage: 'metered' })
        }
        return {
          stage: 'issued',
          delegate_account_address: '0xacc',
          delegations: [
            {
              delegation_hash: '0xd1',
              carry_role: 'carry',
              token_address: '0xusdc',
              budget_atomic: '1000',
              period_seconds: 86400,
              start_date: 0,
              expires_at: 0,
              signing_payload: { domain: {}, types: {}, primaryType: 'D', message: {} },
            },
          ],
          skipped: [],
        }
      }
      if (path.endsWith('/complete')) {
        throw new ApiRequestError('missing_signature', 400, { error: 'missing_signature' })
      }
      return {}
    })
    renderModal()
    await advanceToConsequences()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /switch off the old key/i }))
  }

  it('leaves a way out when issue fails after the revoke landed', async () => {
    await revokeThenFail('issue')
    await waitFor(() => expect(screen.getByText(/cannot pay right now/i)).toBeInTheDocument())
    // The defect was a modal with a single disabled "Working…" button.
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled()
    // The dialog's own X and the footer action both read "Close"; either is a
    // way out, which is the property under test.
    expect(screen.getAllByRole('button', { name: /^close$/i }).length).toBeGreaterThan(0)
  })

  it('leaves a way out when a signature is declined during complete', async () => {
    await revokeThenFail('complete')
    await waitFor(() => expect(screen.getByText(/cannot pay right now/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled()
    // And the raw machine code never reaches the user.
    expect(screen.queryByText(/^missing_signature$/)).toBeNull()
    expect(screen.getByText(/approve every prompt/i)).toBeInTheDocument()
  })

  it('says trying again is safe, and why it should be done now', async () => {
    await revokeThenFail('complete')
    await waitFor(() => expect(screen.getByText(/cannot pay right now/i)).toBeInTheDocument())
    expect(screen.getByText(/nothing was left half-applied/i)).toBeInTheDocument()
    expect(screen.getByText(/finish now so the replacement can be completed/i)).toBeInTheDocument()
    expect(screen.getByText(/can pay again/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing to spend until the next period/i)).toBeNull()
  })
})

describe('resuming an interrupted re-key', () => {
  function inFlightAt(stage: string) {
    mockApiPost.mockImplementation(async (path: string) => {
      if (path.endsWith('/rekey')) {
        throw new ApiRequestError('rekey_already_in_flight', 409, {
          error: 'rekey_already_in_flight',
          rekey_id: 'rk-existing',
          stage,
        })
      }
      if (path.endsWith('/issue')) {
        return { stage: 'issued', delegate_account_address: '0xacc', delegations: [], skipped: [] }
      }
      if (path.endsWith('/complete')) {
        return {
          api_key: 'sk_agent_new',
          api_key_prefix: 'sk_agent_ne',
          new_delegate_address: NEXT,
          invalidated_intents: 0,
          superseded_delegations: 0,
          residual_on_old_delegate: { atomic: '0' },
        }
      }
      return {}
    })
  }

  /**
   * `metered` is the ONE interrupted stage the backend lets a client carry to
   * completion: `issue` requires exactly that stage. Before the fix, resume
   * always re-ran `revoke()` first and died on the ordering guard.
   */
  it('offers to finish a re-key stopped at metered, without re-revoking', async () => {
    inFlightAt('metered')
    renderModal()
    await advanceToConsequences()
    expect(screen.getByText(/you already started replacing this key/i)).toBeInTheDocument()
    const finish = screen.getByRole('button', { name: /finish replacing the key/i })
    // No acknowledgement gate — the irreversible step is already behind us,
    // and requiring a checkbox that is not rendered would dead-end resume.
    expect(finish).toBeEnabled()
    expect(screen.queryByRole('checkbox')).toBeNull()

    // DRIVE it. Asserting the button's state proves the UI offers resume, not
    // that resume works — and "offers what the code cannot do" is the exact
    // defect this test exists for. Verified by mutation: without the click,
    // reinstating the always-revoke bug leaves this test green.
    fireEvent.click(finish)
    await waitFor(() => expect(screen.getByText(/signing key replaced/i)).toBeInTheDocument())

    const paths = mockApiPost.mock.calls.map((c) => c[0] as string)
    // The revoke already landed; re-submitting it is what the backend's
    // ordering guard refuses and what stranded the resume path before.
    expect(paths.some((p) => p.includes('/revoke'))).toBe(false)
    expect(paths.some((p) => p.endsWith('/issue'))).toBe(true)
    expect(paths.some((p) => p.endsWith('/complete'))).toBe(true)
  })

  /**
   * Paired absence for #1887's placement rule: the button moves into the gate
   * only when there IS a gate. A resumed re-key is already past the revoke, so
   * no red banner and no acknowledgement render — and burying the one control
   * that finishes the job at the end of a long scroll, with nothing gating it,
   * would be ceremony rather than safety. It stays in the footer.
   *
   * This is what stops the fix from being written as "the forward action is
   * always inline", which would read as equally correct and be wrong here.
   */
  it('keeps the resume action in the footer, because there is no gate to sit below', async () => {
    inFlightAt('metered')
    renderModal()
    await advanceToConsequences()

    expect(screen.queryByText(/the next step cannot be undone/i)).toBeNull()
    const finish = screen.getByRole('button', { name: /finish replacing the key/i })
    expect(finish.closest('div.rounded-\\[10px\\]')).toBeNull()
  })

  // Paired: a stage the backend genuinely cannot carry forward offers no
  // button at all, rather than one that would 409.
  it('refuses to pretend a re-key stopped at issued can be finished', async () => {
    inFlightAt('issued')
    renderModal()
    await advanceToConsequences()
    expect(screen.getByText(/unfinished replacement is stuck/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /finish replacing the key/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /switch off the old key/i })).toBeNull()
  })
})

describe('cancelling before the revoke', () => {
  it('releases the agent’s in-flight slot instead of leaving it occupied', async () => {
    renderModal()
    await advanceToConsequences()
    mockApiPost.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    // The row opened by preflight holds the agent's ONE in-flight slot; not
    // abandoning it made the next attempt 409 into the resume path.
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith(
        '/agents/agent-1/rekey/rk-1/abandon',
        expect.anything(),
      ),
    )
  })
})
