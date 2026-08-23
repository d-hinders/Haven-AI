/**
 * #1878: which MCP pair an agent is wired as, on the agents list.
 *
 * The assertion that carries this file is the NULL case. Rendering an
 * unreported agent as the bare `haven` pair is the plausible-looking bug —
 * it is what the issue originally proposed — and it is wrong precisely for
 * the agents this feature exists to serve: `--name` shipped in #1696, so
 * named agents already exist with nothing recorded server-side, and calling
 * them `haven` mislabels them with confident-looking text.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { McpServerName, signerNameFor } from '../McpServerName'

describe('McpServerName', () => {
  it('shows the reported name', () => {
    render(<McpServerName value="haven-research" />)
    expect(screen.getByText('haven-research')).toBeInTheDocument()
  })

  it('NEVER guesses the bare pair when nothing was reported', () => {
    render(<McpServerName value={null} />)
    expect(screen.getByText(/not recorded/i)).toBeInTheDocument()
    expect(screen.queryByText('haven')).not.toBeInTheDocument()
    expect(screen.queryByText(/^haven-/)).not.toBeInTheDocument()
  })

  it('does not imply the agent is broken', () => {
    // Most agents are in this state and every one of them works. Copy that
    // reads as a fault would send users to fix something that is not wrong.
    render(<McpServerName value={null} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/error|fail|invalid|misconfigur|broken|problem|warning/i)
  })

  it('distinguishes a reported bare pair from an unreported one', () => {
    // The reason the column stores the resolved NAME rather than the slug.
    // These two must not render alike.
    const { unmount } = render(<McpServerName value="haven" />)
    expect(screen.getByText('haven')).toBeInTheDocument()
    expect(screen.queryByText(/not recorded/i)).not.toBeInTheDocument()
    unmount()

    render(<McpServerName value={null} />)
    expect(screen.getByText(/not recorded/i)).toBeInTheDocument()
  })

  it('copies the exact name — what goes into an MCP config, not a truncation', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<McpServerName value="haven-research" />)
    fireEvent.click(screen.getByRole('button', { name: /copy mcp server name/i }))
    expect(writeText).toHaveBeenCalledWith('haven-research')
    // The check-pop is async state; awaiting it keeps the act() boundary
    // honest and incidentally pins that the button reports success.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument(),
    )
  })

  it('survives a clipboard that throws rather than breaking the card', () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) },
    })
    render(<McpServerName value="haven-work" />)
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /copy mcp server name/i })),
    ).not.toThrow()
    expect(screen.getByText('haven-work')).toBeInTheDocument()
  })

  it('derives the signer half for both pair shapes', () => {
    // The pair rule has one home (connect's server-names.ts). This mirrors
    // only the read direction, so it is pinned here rather than assumed.
    expect(signerNameFor('haven')).toBe('haven-signer')
    expect(signerNameFor('haven-research')).toBe('haven-signer-research')
    expect(signerNameFor('haven-team-2')).toBe('haven-signer-team-2')
  })
})
