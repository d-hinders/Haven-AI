import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { HostedConnectCard } from '@/components/haven/HostedConnectCard'
import { buildAgentCredential } from '@/lib/agent-credential'
import type { HandoffInput } from '@/lib/agent-handoff'

const API_KEY = 'sk_agent_TESTKEY_HOSTED_ONLY'
const DELEGATE_KEY = '0xPRIVATEKEY_MUST_NEVER_BE_IN_CONNECT_SNIPPET'

const BASE_INPUT: HandoffInput = {
  agent: {
    id: 'agt_test',
    name: 'Research Agent',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    chainId: 100,
  },
  policy: {
    allowances: [{ tokenSymbol: 'USDC', amount: '25', resetPeriodMin: 1440 }],
  },
  credentials: {
    apiKey: API_KEY,
    delegatePrivateKey: DELEGATE_KEY,
  },
  apiBaseUrl: 'https://havenbackend.example',
  appBaseUrl: 'https://app.haven.example',
}

function credential() {
  return buildAgentCredential(BASE_INPUT).json
}

describe('HostedConnectCard', () => {
  const clipboardWriteText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    clipboardWriteText.mockClear()
    Object.assign(navigator, {
      clipboard: { writeText: clipboardWriteText },
    })
  })

  it('lands with no client picked and the two-credential split hidden', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    expect(screen.getByText(/Connect Research Agent to where it runs/i)).toBeInTheDocument()

    for (const name of ['Claude Code', 'Claude Desktop', 'Cursor', 'Other / SDK']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false')
    }
    // The two-credential split is hidden until a client is picked.
    expect(screen.queryByText('Signing key')).not.toBeInTheDocument()
    expect(screen.queryByText(/stays on your machine/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save signing key/i })).not.toBeInTheDocument()
  })

  it('reveals the two-credential split with the custody label when a client is picked', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))

    // Both sections are visible.
    expect(screen.getByRole('heading', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Signing key' })).toBeInTheDocument()
    // The custody microcopy is visually present (not buried in a tooltip).
    expect(screen.getByText(/stays on your machine/i)).toBeInTheDocument()
    expect(screen.getByText(/Haven never receives it/i)).toBeInTheDocument()
    // Save action is exposed.
    expect(screen.getByRole('button', { name: /Save signing key/i })).toBeInTheDocument()
  })

  it('never includes the delegate private key in the connect snippet (custody invariant)', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    for (const tab of ['Claude Code', 'Claude Desktop', 'Cursor', 'Other / SDK']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))

      // Anything inside the rendered card must not echo the delegate key.
      const allText = document.body.textContent ?? ''
      expect(allText).not.toContain(DELEGATE_KEY)
      // The connect snippet *does* carry the api key (identity is allowed).
      expect(allText).toContain(API_KEY)
    }
  })

  it('saving the signing key fires onSaveSigningKey + onCredentialSaved', () => {
    const onSave = vi.fn()
    const onCredentialSaved = vi.fn()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={onSave}
        onCredentialSaved={onCredentialSaved}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
    fireEvent.click(screen.getByRole('button', { name: /Save signing key/i }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onCredentialSaved).toHaveBeenCalled()
  })

  it('copying the connect snippet flips the credential-saved gate', async () => {
    const onCredentialSaved = vi.fn()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        onCredentialSaved={onCredentialSaved}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
    fireEvent.click(screen.getAllByRole('button', { name: /^Copy$/i })[0])

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledTimes(1)
    })
    // The snippet that was copied does not carry the delegate key, only api key.
    const copied = clipboardWriteText.mock.calls[0][0] as string
    expect(copied).toContain(API_KEY)
    expect(copied).not.toContain(DELEGATE_KEY)
    expect(onCredentialSaved).toHaveBeenCalled()
  })
})
