import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from '../CopyButton'

/**
 * `CopyButton`'s two shapes (#3998). The icon-only button is what every
 * existing caller renders — Address, McpServerName, the ops console — so its
 * output is pinned here as unchanged; the labelled shape and the failure
 * callback are additive.
 */

function mockClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(writeText) },
  })
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>
}

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CopyButton', () => {
  it('icon-only (the default) shows no visible text and keeps its accessible-name shape', async () => {
    const write = mockClipboard(() => Promise.resolve())
    render(<CopyButton value="0xabc" label="address" />)
    const button = screen.getByRole('button', { name: 'Copy address' })
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).not.toBeNull()
    await click(button)
    expect(write).toHaveBeenCalledWith('0xabc')
    expect(screen.getByRole('button', { name: 'Address copied' }).textContent).toBe('')
  })

  it('labelled: shows its text, copies the exact value, then reads "Copied" — the visible words inside the name', async () => {
    const write = mockClipboard(() => Promise.resolve())
    render(<CopyButton value="Pay https://x.example/a and return the result" label="prompt for Fact" text="Copy prompt" />)
    const button = screen.getByRole('button', { name: 'Copy prompt for Fact' })
    expect(button.textContent).toBe('Copy prompt')
    await click(button)
    expect(write).toHaveBeenCalledWith('Pay https://x.example/a and return the result')
    const copied = screen.getByRole('button', { name: 'Prompt for Fact copied' })
    expect(copied.textContent).toBe('Copied')
  })

  it('labelled with copiedText: the confirmation is the caller\'s next step, then reverts', async () => {
    const write = mockClipboard(() => Promise.resolve())
    render(
      <CopyButton
        value="Pay https://x.example/a and return the result"
        label="prompt for Fact"
        text="Copy prompt"
        copiedText="Copied — paste it to Atlas"
      />,
    )
    const button = screen.getByRole('button', { name: 'Copy prompt for Fact' })
    expect(button.textContent).toBe('Copy prompt')
    // #4561: the wrap-capable form is used in BOTH states, so the button does
    // not change height when the confirmation appears.
    expect(button.className.split(/\s+/)).toContain('whitespace-normal')
    await click(button)
    expect(write).toHaveBeenCalledWith('Pay https://x.example/a and return the result')
    const copied = screen.getByRole('button', { name: 'Prompt for Fact copied' })
    expect(copied.textContent).toBe('Copied — paste it to Atlas')
    // The copied state is the one that has to wrap: a long agent name must
    // break inside the button rather than run past its edge, and the height
    // must be a floor rather than a fixed `h-9` so the second line fits.
    const copiedClasses = copied.className.split(/\s+/)
    expect(copiedClasses).toContain('whitespace-normal')
    expect(copiedClasses).not.toContain('whitespace-nowrap')
    expect(copiedClasses).toContain('min-h-9')
    expect(copiedClasses.some((c) => /^h-\d+$/.test(c))).toBe(false)
  })

  it('labelled without copiedText keeps the nowrap default — nothing to wrap', async () => {
    mockClipboard(() => Promise.resolve())
    render(<CopyButton value="v" label="prompt for Fact" text="Copy prompt" />)
    const button = screen.getByRole('button', { name: 'Copy prompt for Fact' })
    expect(button.className.split(/\s+/)).toContain('whitespace-nowrap')
    await click(button)
    expect(screen.getByRole('button', { name: 'Prompt for Fact copied' }).className.split(/\s+/)).toContain(
      'whitespace-nowrap',
    )
  })

  it('labelled without copiedText keeps the plain "Copied" confirmation', async () => {
    const write = mockClipboard(() => Promise.resolve())
    render(<CopyButton value="v" label="prompt for Fact" text="Copy prompt" />)
    await click(screen.getByRole('button', { name: 'Copy prompt for Fact' }))
    expect(screen.getByRole('button', { name: 'Prompt for Fact copied' }).textContent).toBe('Copied')
  })

  it('calls onCopyFailed only when the clipboard write rejects', async () => {
    const onCopyFailed = vi.fn()
    mockClipboard(() => Promise.resolve())
    const { unmount } = render(<CopyButton value="v" label="value" text="Copy" onCopyFailed={onCopyFailed} />)
    await click(screen.getByRole('button', { name: 'Copy value' }))
    expect(onCopyFailed).not.toHaveBeenCalled()
    unmount()

    mockClipboard(() => Promise.reject(new Error('denied')))
    render(<CopyButton value="v" label="value" text="Copy" onCopyFailed={onCopyFailed} />)
    await click(screen.getByRole('button', { name: 'Copy value' }))
    expect(onCopyFailed).toHaveBeenCalledTimes(1)
    // A failed write never claims success.
    expect(screen.queryByRole('button', { name: 'Value copied' })).toBeNull()
  })

  it('stays silent on a rejected write when no callback is passed (the on-screen-value callers)', async () => {
    mockClipboard(() => Promise.reject(new Error('denied')))
    render(<CopyButton value="0xabc" label="address" />)
    await click(screen.getByRole('button', { name: 'Copy address' }))
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeDefined()
  })
})
