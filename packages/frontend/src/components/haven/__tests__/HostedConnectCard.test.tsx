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
  const windowOpen = vi.fn()

  beforeEach(() => {
    clipboardWriteText.mockClear()
    windowOpen.mockClear()
    Object.assign(navigator, { clipboard: { writeText: clipboardWriteText } })
    vi.stubGlobal('open', windowOpen)
  })

  it('lands with no client picked and the two-credential split hidden', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    expect(screen.getByText(/Connect Research Agent to where it runs/i)).toBeInTheDocument()

    for (const name of ['Claude Code', 'Claude Desktop', 'Cursor', 'Other / SDK']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false')
    }
    expect(screen.queryByText('Signing key')).not.toBeInTheDocument()
    expect(screen.queryByText(/stays on your machine/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save signing key/i })).not.toBeInTheDocument()
  })

  it('reveals the two-credential split with the custody label when a client is picked', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))

    expect(screen.getByRole('heading', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Signing key' })).toBeInTheDocument()
    expect(screen.getByText(/stays on your machine/i)).toBeInTheDocument()
    expect(screen.getByText(/Haven never receives it/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save signing key/i })).toBeInTheDocument()
  })

  it('never includes the delegate private key in the rendered card body (custody invariant)', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)

    for (const tab of ['Claude Code', 'Claude Desktop', 'Cursor', 'Other / SDK']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))
      const allText = document.body.textContent ?? ''
      expect(allText, `${tab}: delegate key must not appear in card body`).not.toContain(DELEGATE_KEY)

      // For deep-link clients (Claude Desktop, Cursor), the API key is encoded
      // inside the deep-link URL, not rendered as visible text in the card body.
      // For command-based clients (Claude Code, Other) it appears in the code block.
      const isDeepLinkClient = tab === 'Claude Desktop' || tab === 'Cursor'
      if (!isDeepLinkClient) {
        expect(allText, `${tab}: api key (identity) should be present`).toContain(API_KEY)
      }
    }
  })

  // ── #188: Deep-link clients ──────────────────────────────────────────────

  it('Claude Desktop shows "Add to Claude" button instead of an immediate code block', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))

    expect(screen.getByRole('button', { name: 'Add to Claude' })).toBeInTheDocument()
    // The JSON config is hidden behind the fallback toggle — not on the page yet.
    expect(screen.queryByText('json')).not.toBeInTheDocument()
  })

  it('Cursor shows "Add to Cursor" button', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))

    expect(screen.getByRole('button', { name: 'Add to Cursor' })).toBeInTheDocument()
    expect(screen.queryByText('json')).not.toBeInTheDocument()
  })

  it('"Add to Claude" opens a claude:// deep link via window.open', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Claude' }))

    expect(windowOpen).toHaveBeenCalledTimes(1)
    const [url] = windowOpen.mock.calls[0] as [string, string]
    expect(url).toMatch(/^claude:\/\//)
    expect(url).not.toContain(DELEGATE_KEY)
    // The API key is base64-encoded in the payload — decode it to verify it's there.
    const match = url.match(/\?add=([^&]+)/)
    expect(match).not.toBeNull()
    const decoded = atob(decodeURIComponent(match![1]))
    expect(decoded).toContain(API_KEY)
  })

  it('"Add to Cursor" opens a cursor:// deep link', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Cursor' }))

    expect(windowOpen).toHaveBeenCalledTimes(1)
    const [url] = windowOpen.mock.calls[0] as [string, string]
    expect(url).toMatch(/^cursor:\/\//)
    expect(url).not.toContain(DELEGATE_KEY)
  })

  it('"Didn\'t work? Show config" toggle reveals the JSON block for Claude Desktop', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))

    // Initially hidden
    expect(screen.queryByText('json')).not.toBeInTheDocument()

    // Click the toggle
    fireEvent.click(screen.getByText(/Didn't work/i))
    expect(screen.getByText('json')).toBeInTheDocument()
    // The fallback shows the api key (identity) but not the delegate key
    const allText = document.body.textContent ?? ''
    expect(allText).toContain(API_KEY)
    expect(allText).not.toContain(DELEGATE_KEY)
  })

  it('"Other / SDK" shows advanced <details> disclosure for the local-server path', () => {
    render(<HostedConnectCard credential={credential()} onSaveSigningKey={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Other / SDK' }))

    expect(screen.getByText(/Self-hosted \/ local server/i)).toBeInTheDocument()
  })

  // ── Save / Copy gates ────────────────────────────────────────────────────

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

  it('clicking "Add to Claude" fires onCredentialSaved', () => {
    const onCredentialSaved = vi.fn()
    render(
      <HostedConnectCard
        credential={credential()}
        onSaveSigningKey={vi.fn()}
        onCredentialSaved={onCredentialSaved}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Claude' }))

    expect(onCredentialSaved).toHaveBeenCalled()
  })

  it('copying the connect snippet writes the api_key but NOT the delegate key', async () => {
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

    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1))
    const copied = clipboardWriteText.mock.calls[0][0] as string
    expect(copied).toContain(API_KEY)
    expect(copied).not.toContain(DELEGATE_KEY)
    expect(onCredentialSaved).toHaveBeenCalled()
  })
})
