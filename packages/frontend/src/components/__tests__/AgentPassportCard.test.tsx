import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockUseAgentPassport, mockIssuePassport } = vi.hoisted(() => ({
  mockUseAgentPassport: vi.fn(),
  mockIssuePassport: vi.fn(),
}))

vi.mock('@/hooks/useAgentPassport', () => ({
  useAgentPassport: (...args: unknown[]) => mockUseAgentPassport(...args),
}))

const AgentPassportCard = (await import('../AgentPassportCard')).default

function state(overrides: Record<string, unknown> = {}) {
  return {
    passport: null,
    standing: null,
    loading: false,
    loadError: false,
    issuing: false,
    issueError: null,
    issuePassport: mockIssuePassport,
    refetch: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  mockUseAgentPassport.mockReset()
  mockIssuePassport.mockReset()
})

describe('AgentPassportCard (#1072)', () => {
  // #1112 review finding 1: a lookup failure must never wear the "Not issued"
  // costume — no empty-state copy, no live Issue button, a retry instead.
  it('renders a retryable error — not the opt-in state — when the lookup failed', () => {
    const refetch = vi.fn()
    mockUseAgentPassport.mockReturnValue(state({ loadError: true, refetch }))
    render(<AgentPassportCard agentId="agent-1" />)
    expect(screen.getByText(/Couldn.t load passport status/)).toBeTruthy()
    expect(screen.queryByText(/has no passport/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Issue a passport/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalled()
  })

  it('a refetch failure with known data keeps rendering the passport, not the error card', () => {
    mockUseAgentPassport.mockReturnValue(state({
      loadError: true,
      passport: {
        status: 'anchored', assurance_level: 0,
        attestation_uid: '0x' + '11'.repeat(32),
        tx_hash: '0x' + 'aa'.repeat(32), chain_id: 84532,
        attempts: 1, last_error: null,
        requested_at: '2026-06-02T10:00:00.000Z', anchored_at: '2026-06-02T10:00:12.000Z',
      },
      standing: {
        agentId: 'agent-1', standing: 'active', anchor: 'anchored',
        attestationUid: '0x' + '11'.repeat(32), chainLagging: false, revocationConfirmedAt: null,
      },
    }))
    render(<AgentPassportCard agentId="agent-1" />)
    expect(screen.queryByText(/Couldn.t load passport status/)).toBeNull()
    expect(screen.getByText('Issued')).toBeTruthy()
  })

  // #1699 — the re-key window. The agent is fully live and authorised while
  // the attestation on-chain still names the delegate key the re-key retired,
  // and the card must say both things rather than pick one.
  describe('re-anchoring after a re-key (#1699)', () => {
    const reanchoring = (anchor: 're_anchoring' | 'revocation_pending' | 'anchored') =>
      state({
        passport: {
          status: 'anchored', assurance_level: 0,
          attestation_uid: '0x' + '11'.repeat(32),
          tx_hash: '0x' + 'aa'.repeat(32), chain_id: 84532,
          attempts: 1, last_error: null,
          requested_at: '2026-08-22T10:00:00.000Z', anchored_at: '2026-08-22T10:00:12.000Z',
        },
        standing: {
          agentId: 'agent-1', standing: 'active', anchor,
          attestationUid: '0x' + '11'.repeat(32), chainLagging: false, revocationConfirmedAt: null,
        },
      })

    it('says the anchor is updating while standing stays Active', () => {
      mockUseAgentPassport.mockReturnValue(reanchoring('re_anchoring'))
      render(<AgentPassportCard agentId="agent-1" />)
      expect(screen.getByText('Updating on-chain')).toBeTruthy()
      // The two layers, uncollapsed. Standing is the answer and it is Active.
      expect(screen.getByText('Active')).toBeTruthy()
      expect(screen.getByText(/signing key was replaced/)).toBeTruthy()
      // Never "Issued": that would claim a credential naming a retired key is
      // current, which is the #1847 defect this state exists to surface.
      expect(screen.queryByText('Issued')).toBeNull()
      // And never the revoke language — the agent did not lose anything.
      expect(screen.queryByText('Revoking…')).toBeNull()
      expect(screen.queryByText(/Treat the agent as\s+revoked now/)).toBeNull()
    })

    it('does not show the re-key note for an ordinary anchored passport', () => {
      // The control. Without it the assertion above would pass against a card
      // that printed the note unconditionally.
      mockUseAgentPassport.mockReturnValue(reanchoring('anchored'))
      render(<AgentPassportCard agentId="agent-1" />)
      expect(screen.getByText('Issued')).toBeTruthy()
      expect(screen.queryByText(/signing key was replaced/)).toBeNull()
    })

    it('still reads Revoking… for a genuine revocation', () => {
      // The other control: `re_anchoring` outranks `revocation_pending` in the
      // badge, so this proves the reordering did not swallow the real case.
      mockUseAgentPassport.mockReturnValue(reanchoring('revocation_pending'))
      render(<AgentPassportCard agentId="agent-1" />)
      expect(screen.getByText('Revoking…')).toBeTruthy()
      expect(screen.queryByText('Updating on-chain')).toBeNull()
    })
  })

  it('renders the opt-in state when the agent has no passport', () => {
    mockUseAgentPassport.mockReturnValue(state())
    render(<AgentPassportCard agentId="agent-1" />)
    expect(screen.getByText('Not issued')).toBeTruthy()
    expect(screen.getByRole('button', { name: /issue a passport/i })).toBeTruthy()
    // Naming discipline: never "verified" — reserved for L2.
    expect(document.body.textContent).not.toMatch(/verified/i)
  })

  it('keeps the header status badge from shrinking/wrapping next to the title (mobile regression)', () => {
    mockUseAgentPassport.mockReturnValue(state())
    render(<AgentPassportCard agentId="agent-1" />)
    expect(screen.getByText('Not issued').className).toMatch(/shrink-0/)
  })

  it('hides the issue action for a revoked agent', () => {
    mockUseAgentPassport.mockReturnValue(state())
    render(<AgentPassportCard agentId="agent-1" agentRevoked />)
    expect(screen.queryByRole('button', { name: /issue a passport/i })).toBeNull()
  })

  it('renders standing and anchor honestly for an anchored passport', () => {
    mockUseAgentPassport.mockReturnValue(state({
      passport: {
        status: 'anchored', assurance_level: 0,
        attestation_uid: '0x' + '11'.repeat(32),
        tx_hash: '0x' + 'aa'.repeat(32), chain_id: 84532,
        attempts: 1, last_error: null,
        requested_at: '2026-06-02T10:00:00.000Z', anchored_at: '2026-06-02T10:00:12.000Z',
      },
      standing: {
        agentId: 'agent-1', standing: 'active', anchor: 'anchored',
        attestationUid: '0x' + '11'.repeat(32), chainLagging: false, revocationConfirmedAt: null,
      },
    }))
    render(<AgentPassportCard agentId="agent-1" />)
    expect(screen.getByText('Issued')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    const link = screen.getByRole('link', { name: /view transaction/i })
    // Regression: the link must come from the PASSPORT's own chain_id
    // (Base Sepolia, 84532) rather than any account-level chain the caller
    // might pass — the account can be on a different chain than the
    // attestation was issued on.
    expect(link.getAttribute('href')).toBe(`https://sepolia.basescan.org/tx/0x${'aa'.repeat(32)}`)
  })

  it('surfaces chain lag instead of implying a revoked credential is still good', () => {
    mockUseAgentPassport.mockReturnValue(state({
      passport: {
        status: 'anchored', assurance_level: 0, attestation_uid: '0x' + '11'.repeat(32),
        tx_hash: null, chain_id: 84532, attempts: 1, last_error: null,
        requested_at: '2026-06-02T10:00:00.000Z', anchored_at: '2026-06-02T10:00:12.000Z',
      },
      standing: {
        agentId: 'agent-1', standing: 'revoked', anchor: 'anchored',
        attestationUid: '0x' + '11'.repeat(32), chainLagging: true, revocationConfirmedAt: null,
      },
    }))
    render(<AgentPassportCard agentId="agent-1" />)
    expect(screen.getByText('Revoked')).toBeTruthy()
    expect(screen.getByText(/on-chain record has not caught up/i)).toBeTruthy()
  })

  it('calls issuePassport when the opt-in button is clicked', async () => {
    const { fireEvent } = await import('@testing-library/react')
    mockUseAgentPassport.mockReturnValue(state())
    render(<AgentPassportCard agentId="agent-1" />)
    fireEvent.click(screen.getByRole('button', { name: /issue a passport/i }))
    await waitFor(() => expect(mockIssuePassport).toHaveBeenCalledTimes(1))
  })

  it('surfaces an issue error', () => {
    mockUseAgentPassport.mockReturnValue(state({ issueError: 'Passports are not issued on chain 8453' }))
    render(<AgentPassportCard agentId="agent-1" />)
    expect(screen.getByText('Passports are not issued on chain 8453')).toBeTruthy()
  })
})
