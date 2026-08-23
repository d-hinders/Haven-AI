/**
 * Replace signing key — the guarantees, not the markup (#1701).
 *
 * Every assertion here is about something a user could be MISLED by, because
 * this modal drives a backend whose siblings are unshipped and whose reachable
 * states the product does not yet describe. The interesting failures are all
 * copy that is confidently wrong, so the tests query by role and name and
 * assert on sentences rather than class names.
 *
 * Paired-absence discipline: every "X is not shown" assertion has a sibling
 * case in the same file proving X IS shown under the opposite condition.
 * A missing element only proves suppression when something can produce it.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseActiveSigner, mockApiGet, mockApiPost } = vi.hoisted(() => ({
  mockUseActiveSigner: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (...args: unknown[]) => mockUseActiveSigner(...args),
  hasPasskeyCredentialOnDevice: () => false,
  credentialIdFromKeyId: (k: string) => k,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { get: (...a: unknown[]) => mockApiGet(...a), post: (...a: unknown[]) => mockApiPost(...a) },
  }
})

import { ReplaceSigningKeyModal } from '../ReplaceSigningKeyModal'
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
    hasPassport: false,
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

describe('the long-pause hazard (#1849)', () => {
  it('warns that pausing across a period boundary can zero the budget', async () => {
    renderModal()
    await advanceToConsequences()
    expect(screen.getByText(/finish this in one go/i)).toBeInTheDocument()
    expect(screen.getByText(/nothing to spend until the following period/i)).toBeInTheDocument()
  })

  /**
   * The backend returns `carry_note` and `skipped[].reason` prose, and the
   * skipped reason currently asserts authority "resumes at the original
   * boundary" — which #1849 establishes is a period too early. Rendering it
   * would ship a false promise, so this asserts the sentence never appears.
   */
  it('does not repeat the backend\'s false "original boundary" claim', async () => {
    const { container } = renderModal()
    await advanceToConsequences()
    expect(container.textContent ?? '').not.toMatch(/original boundary/i)
  })
})

describe('passport standing (#1847)', () => {
  it('says the public record will name the OLD key when the agent has a passport', async () => {
    renderModal({ hasPassport: true })
    await advanceToConsequences()
    expect(screen.getByText(/still names the signing address you are retiring/i)).toBeInTheDocument()
    // "out of date", never "catching up" — nothing re-anchors it today.
    expect(screen.getByText(/out of date rather than catching up/i)).toBeInTheDocument()
  })

  // Paired absence: the sibling above proves the warning is producible.
  it('omits the passport warning when the agent has no passport', async () => {
    renderModal({ hasPassport: false })
    await advanceToConsequences()
    expect(screen.queryByText(/still names the signing address you are retiring/i)).toBeNull()
  })

  it('never claims passport standing carries over on-chain', async () => {
    const { container } = renderModal({ hasPassport: true })
    await advanceToConsequences()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/briefly lags/i)
    expect(text).not.toMatch(/standing carries/i)
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

describe('signing-path refusal (#1870)', () => {
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
