import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RuntimeConnectCard } from '@/components/haven/RuntimeConnectCard'
import { buildAgentCredential } from '@/lib/agent-credential'
import type { HandoffInput } from '@/lib/agent-handoff'

const BASE_INPUT: HandoffInput = {
  agent: {
    id: 'agt_abc123',
    name: 'Research Agent',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    chainId: 100,
  },
  policy: {
    allowances: [{ tokenSymbol: 'USDC', amount: '25', resetPeriodMin: 10080 }],
  },
  credentials: {
    apiKey: 'sk_agent_TESTKEY_NEVERREAL',
    delegatePrivateKey: '0xPRIVATEKEY_NEVERREAL',
  },
  apiBaseUrl: 'https://havenbackend.example',
  appBaseUrl: 'https://app.haven.example',
}

function credential() {
  return buildAgentCredential(BASE_INPUT).json
}

describe('RuntimeConnectCard', () => {
  const clipboardWriteText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    clipboardWriteText.mockClear()
    Object.assign(navigator, {
      clipboard: { writeText: clipboardWriteText },
    })
  })

  it('shows tabs for every supported runtime and defaults to Claude Desktop', () => {
    render(<RuntimeConnectCard credential={credential()} />)
    expect(screen.getByRole('tab', { name: 'Claude Desktop' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Cursor' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Generic MCP' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'SDK / CLI' })).toBeInTheDocument()
  })

  it('renders the active snippet inline with the credential secret in inline mode', () => {
    render(<RuntimeConnectCard credential={credential()} />)
    expect(screen.getByText(/sk_agent_TESTKEY_NEVERREAL/)).toBeInTheDocument()
  })

  it('switches snippets when a different tab is clicked', () => {
    render(<RuntimeConnectCard credential={credential()} />)
    // Sanity: the Claude Desktop tile is active first and its destination is shown.
    expect(screen.getByText('claude_desktop_config.json')).toBeInTheDocument()
    expect(screen.queryByText('~/.cursor/mcp.json')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
    // Cursor's destination chip is unique to that tile.
    expect(screen.getByText('~/.cursor/mcp.json')).toBeInTheDocument()
    expect(screen.queryByText('claude_desktop_config.json')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Cursor' })).toHaveAttribute('aria-selected', 'true')
  })

  it('switching to file mode removes the secret from the visible snippet', () => {
    render(<RuntimeConnectCard credential={credential()} />)
    expect(screen.getByText(/sk_agent_TESTKEY_NEVERREAL/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'With credential file' }))
    expect(screen.queryByText(/sk_agent_TESTKEY_NEVERREAL/)).not.toBeInTheDocument()
    expect(screen.getByText(/--credentials/)).toBeInTheDocument()
  })

  it('copying a snippet calls the clipboard and reports it via the callback', async () => {
    const onSnippetCopied = vi.fn()
    render(<RuntimeConnectCard credential={credential()} onSnippetCopied={onSnippetCopied} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1))
    expect(clipboardWriteText.mock.calls[0][0]).toContain('sk_agent_TESTKEY_NEVERREAL')
    expect(onSnippetCopied).toHaveBeenCalledTimes(1)
    expect(onSnippetCopied.mock.calls[0][0].id).toBe('claude-desktop')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it("shows a Try it prompt suggesting What's my Haven budget", () => {
    render(<RuntimeConnectCard credential={credential()} />)
    expect(screen.getByText(/What's my Haven budget/i)).toBeInTheDocument()
  })
})
