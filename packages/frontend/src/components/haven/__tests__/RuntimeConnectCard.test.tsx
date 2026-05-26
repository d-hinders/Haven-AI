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

  it('renders all tabs unselected and hides the credentials until a tile is clicked', () => {
    render(<RuntimeConnectCard credential={credential()} />)

    for (const name of ['Claude Desktop', 'Cursor', 'Windsurf', 'VS Code', 'Other agents', 'SDK / CLI', 'Python']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false')
    }
    // Credentials and the Try it block stay out of the DOM until the user picks something.
    expect(screen.queryByText(/sk_agent_TESTKEY_NEVERREAL/)).not.toBeInTheDocument()
    expect(screen.queryByText(/What's my Haven budget/i)).not.toBeInTheDocument()
    // The empty-state hint nudges the user toward the tabs.
    expect(screen.getByText(/Select a runtime above/i)).toBeInTheDocument()
  })

  it('reveals the snippet and Try it prompt after a tile is selected', () => {
    render(<RuntimeConnectCard credential={credential()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))

    expect(screen.getByRole('tab', { name: 'Claude Desktop' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/sk_agent_TESTKEY_NEVERREAL/)).toBeInTheDocument()
    expect(screen.getByText(/What's my Haven budget/i)).toBeInTheDocument()
    expect(screen.queryByText(/Select a runtime above/i)).not.toBeInTheDocument()
  })

  it('switches snippets when a different tab is clicked', () => {
    render(<RuntimeConnectCard credential={credential()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))
    expect(screen.getByText('claude_desktop_config.json')).toBeInTheDocument()
    expect(screen.queryByText('~/.cursor/mcp.json')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
    expect(screen.getByText('~/.cursor/mcp.json')).toBeInTheDocument()
    expect(screen.queryByText('claude_desktop_config.json')).not.toBeInTheDocument()
  })

  it('switching to "Use a file" mode removes the secret from the visible snippet', () => {
    // (Inline mode was tested above with the credentials visible.)
    render(<RuntimeConnectCard credential={credential()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))
    expect(screen.getByText(/sk_agent_TESTKEY_NEVERREAL/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Use a file' }))
    expect(screen.queryByText(/sk_agent_TESTKEY_NEVERREAL/)).not.toBeInTheDocument()
    expect(screen.getByText(/--credentials/)).toBeInTheDocument()
  })

  it('copying a snippet calls the clipboard and reports it via the callback', async () => {
    const onSnippetCopied = vi.fn()
    render(<RuntimeConnectCard credential={credential()} onSnippetCopied={onSnippetCopied} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1))
    expect(clipboardWriteText.mock.calls[0][0]).toContain('sk_agent_TESTKEY_NEVERREAL')
    expect(onSnippetCopied).toHaveBeenCalledTimes(1)
    expect(onSnippetCopied.mock.calls[0][0].id).toBe('claude-desktop')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('does not unlock the saved gate when clipboard.writeText rejects', async () => {
    // Regression: PR #173 swallowed clipboard failures and still fired
    // onSnippetCopied, which let the modal's "credential saved" gate unlock
    // even though no secret reached the clipboard. After the merge of EPIC 2,
    // the bug moved into CodeBlock — the copy logic now lives there. The
    // fix in CodeBlock calls `onCopy` only on success and exposes a new
    // `onCopyFailed` hook; RuntimeConnectCard uses that to surface an
    // inline error and keep the gate locked.
    const onSnippetCopied = vi.fn()
    clipboardWriteText.mockRejectedValueOnce(new Error('Document is not focused.'))
    render(<RuntimeConnectCard credential={credential()} onSnippetCopied={onSnippetCopied} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Desktop' }))

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1))

    expect(onSnippetCopied).not.toHaveBeenCalled()
    // The CodeBlock's "copied" check-mark replaces "Copy to clipboard"
    // only on success. On failure the label stays as "Copy to clipboard".
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument()
    expect(
      await screen.findByText(/Couldn’t copy automatically/i),
    ).toBeInTheDocument()
  })
})
