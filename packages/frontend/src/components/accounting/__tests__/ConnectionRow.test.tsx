/**
 * `ConnectionRow` (#2868): the five connection states render distinctly and
 * each carries the RIGHT action — the state → action table is the contract,
 * pinned both as the pure function and as the rendered button.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { ConnectionRow, primaryActionFor } from '@/components/accounting/ConnectionRow'
import { connection, provider, COMING_SOON } from './fixtures'

function renderRow(props: Partial<React.ComponentProps<typeof ConnectionRow>> = {}) {
  const handlers = { onConnect: vi.fn(), onDisconnect: vi.fn(), onToggleSettings: vi.fn() }
  render(
    <LocaleProvider>
      <ConnectionRow
        provider={provider()}
        connection={connection()}
        busy={false}
        settingsOpen={false}
        {...handlers}
        {...props}
      />
    </LocaleProvider>,
  )
  return handlers
}

const actions = () => screen.getByTestId('connection-actions-fortnox')

describe('primaryActionFor — the state → action table', () => {
  it.each([
    [null, 'connect'],
    ['disconnected', 'connect'],
    ['connected', 'settings'],
    ['needs_reauthorisation', 'reconnect'],
    ['scope_missing', 'reconnect'],
    ['revoked_at_provider', 'reconnect'],
  ] as const)('%s → %s', (status, action) => {
    expect(primaryActionFor(status)).toBe(action)
  })
})

describe('ConnectionRow states', () => {
  it('connected: success chip, company name, last push, Settings + Disconnect', () => {
    const h = renderRow()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText(/Connected to Ada Lovelace AB/)).toBeInTheDocument()
    expect(screen.getByText(/Last fed 10 Sept 2026/)).toBeInTheDocument()
    expect(actions()).toHaveAttribute('data-action', 'settings')
    within(actions()).getByRole('button', { name: 'Settings' }).click()
    expect(h.onToggleSettings).toHaveBeenCalledTimes(1)
    expect(within(actions()).getByRole('button', { name: 'Disconnect' })).toBeEnabled()
    expect(within(actions()).queryByRole('button', { name: /^(Re)?connect$/ })).toBeNull()
  })

  it('connected without a push yet says so instead of inventing a date', () => {
    renderRow({ connection: connection({ lastPushAt: null, externalCompanyName: null }) })
    expect(screen.getByText(/Connected · Nothing fed yet/)).toBeInTheDocument()
  })

  it('needs_reauthorisation: warning chip, the expiry sentence, and Reconnect — not Connect, not Settings', () => {
    const h = renderRow({ connection: connection({ status: 'needs_reauthorisation', isActiveDestination: true }) })
    expect(screen.getByText('Sign-in expired')).toBeInTheDocument()
    expect(screen.getByText(/Your Fortnox sign-in has expired/)).toBeInTheDocument()
    expect(actions()).toHaveAttribute('data-action', 'reconnect')
    const reconnect = within(actions()).getByRole('button', { name: 'Reconnect' })
    reconnect.click()
    expect(h.onConnect).toHaveBeenCalledTimes(1)
    expect(within(actions()).queryByRole('button', { name: 'Settings' })).toBeNull()
    expect(within(actions()).queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(within(actions()).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
  })

  it('scope_missing names the missing scopes and offers Reconnect', () => {
    renderRow({ connection: connection({ status: 'scope_missing', missingScopes: ['archive', 'companyinformation'] }) })
    expect(screen.getByText('Needs more access')).toBeInTheDocument()
    expect(screen.getByText(/needs more access than it granted \(archive, companyinformation\)/)).toBeInTheDocument()
    expect(actions()).toHaveAttribute('data-action', 'reconnect')
    expect(within(actions()).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
  })

  it('scope_missing with an EMPTY missingScopes array gets the unnamed sentence, never "()"', () => {
    renderRow({ connection: connection({ status: 'scope_missing', missingScopes: [] }) })
    expect(screen.getByText(/Fortnox needs more access than it granted\. Reconnect to grant it\./)).toBeInTheDocument()
    expect(screen.queryByText(/\(\)/)).toBeNull()
    expect(within(actions()).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
  })

  it('revoked_at_provider: danger chip and Reconnect', () => {
    renderRow({ connection: connection({ status: 'revoked_at_provider', isActiveDestination: false }) })
    expect(screen.getByText('Access revoked')).toBeInTheDocument()
    expect(screen.getByText(/Access was revoked in Fortnox/)).toBeInTheDocument()
    expect(actions()).toHaveAttribute('data-action', 'reconnect')
    expect(within(actions()).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
  })

  it('disconnected: neutral chip, "history stays" sentence, Connect only', () => {
    const h = renderRow({ connection: connection({ status: 'disconnected', isActiveDestination: false }) })
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    expect(screen.getByText(/What was fed earlier stays in Haven/)).toBeInTheDocument()
    expect(actions()).toHaveAttribute('data-action', 'connect')
    within(actions()).getByRole('button', { name: 'Connect' }).click()
    expect(h.onConnect).toHaveBeenCalledTimes(1)
    expect(within(actions()).queryByRole('button', { name: 'Disconnect' })).toBeNull()
  })

  it('no connection row at all renders as disconnected', () => {
    renderRow({ connection: null })
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    expect(within(actions()).getByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('a live provider this deployment has not configured lists with Connect disabled', () => {
    renderRow({ provider: provider({ configured: false }), connection: null })
    expect(screen.getByText('Not available on this deployment yet.')).toBeInTheDocument()
    expect(within(actions()).getByRole('button', { name: 'Connect' })).toBeDisabled()
  })

  it('busy disables the actions on this row', () => {
    renderRow({ busy: true })
    expect(within(actions()).getByRole('button', { name: 'Settings' })).toBeDisabled()
    expect(within(actions()).getByRole('button', { name: 'Disconnect' })).toBeDisabled()
  })
})

describe('ConnectionRow — coming soon providers', () => {
  it.each(COMING_SOON)('$displayName is listed with a one-line description and a disabled Connect', (p) => {
    renderRow({ provider: p, connection: null })
    expect(screen.getByText(p.displayName)).toBeInTheDocument()
    const row = screen.getByTestId(`connection-row-${p.id}`)
    expect(within(row).getByText('Coming soon')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(screen.getByText(/Not connectable yet\./)).toBeInTheDocument()
  })
})
