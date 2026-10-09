/**
 * Headless equivalents for the ReceivePanel (#3333) — the triggers that would
 * otherwise need rendered evidence:
 *
 * - gating: the panel does NOT render its body while the ledger hook is
 *   loading, and renders the retry state on a failed first load;
 * - earned semantics: an unmatched row is served `earned: false` and the UI
 *   MUST show "Unmatched" for it, "Matched" for a matched one — the exact
 *   cross-surface drift #3333 forbids (the backend flags unearned; the UI
 *   may not relabel it earned);
 * - the hand-off prepare is refused when nothing is saved or nothing is
 *   earned (the button is disabled — the authority gate read as UI state).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReceiveLedgerResponse } from '@/types/transactions'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn(),
    put: vi.fn(),
  },
}))

vi.mock('@/hooks/useReceiveLedger', () => ({
  useReceiveLedger: vi.fn(),
}))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}))

const { activeSigner } = vi.hoisted(() => ({ activeSigner: { current: null as unknown } }))
vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => activeSigner.current,
  // Read by `pickSigningPath` (#3812): no passkey marker on this device.
  hasPasskeyCredentialOnDevice: () => false,
  credentialIdFromKeyId: (keyId: string) => keyId,
}))

// #3812: stubbed so the hand-off tests can assert WHEN it is offered;
// `WalletConnectAction.test.tsx` covers what it does.
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

import ReceivePanel from '@/components/haven/ReceivePanel'
import { useReceiveLedger } from '@/hooks/useReceiveLedger'
import { api } from '@/lib/api'

const ADDRESS = '0xa0e99A227fc546017Fd68D49711C1857208F0eB9'

const LEDGER: ReceiveLedgerResponse = {
  account_address: ADDRESS,
  chain_id: 8453,
  usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  balance_atomic: '2500000',
  balance_formatted: '2.500000',
  off_ramp_destination: {
    destination_address: '0x5555555555555555555555555555555555555555',
    destination_kind: 'safello',
    label: null,
    updated_at: '2026-09-27T10:00:00Z',
  },
  transfers: [
    {
      tx_hash: `0x${'c'.repeat(64)}`,
      payer_address: '0x' + 'b'.repeat(40),
      amount_raw: '2500000',
      amount_formatted: '2.500000',
      block_time: '2026-09-27T10:00:00Z',
      match_kind: 'receipt',
      matched_payment_intent_id: null,
      matched_receipt_id: '44444444-4444-4444-8444-444444444444',
      balance_consumed: true,
      earned: true,
    },
    {
      tx_hash: `0x${'d'.repeat(64)}`,
      payer_address: '0x' + 'e'.repeat(40),
      amount_raw: '99000000',
      amount_formatted: '99.000000',
      block_time: '2026-09-26T10:00:00Z',
      match_kind: null,
      matched_payment_intent_id: null,
      matched_receipt_id: null,
      balance_consumed: false,
      earned: false,
    },
  ],
}

describe('ReceivePanel (#3333)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // afterEach's restoreAllMocks wipes factory implementations; the signers
    // fetch in the panel needs a resolving get on every test.
    vi.mocked(api.get).mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not render the panel body while the ledger is loading (no loading flash of empty state)', async () => {
    vi.mocked(useReceiveLedger).mockReturnValue({
      ledger: null,
      loading: true,
      error: null,
      refetch: vi.fn(),
    })

    const { container } = render(
      <ReceivePanel accountAddress={ADDRESS} chainId={8453} />,
    )
    // The skeleton state is up; the earned/matched rows are NOT rendered
    // from nothing — no body, no balance figure.
    expect(container.textContent).not.toContain('Matched balance')
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })

  it('renders the retry state when the first load fails, without any balance figure', async () => {
    vi.mocked(useReceiveLedger).mockReturnValue({
      ledger: null,
      loading: false,
      error: 'boom',
      refetch: vi.fn(),
    })

    const { container } = render(
      <ReceivePanel accountAddress={ADDRESS} chainId={8453} />,
    )
    expect(screen.getByText('Receive panel could not load')).not.toBeNull()
    expect(container.textContent).not.toContain('USDC')
  })

  it('labels a matched row "Matched" and an UNMATCHED row "Unmatched" — never earned', async () => {
    vi.mocked(useReceiveLedger).mockReturnValue({
      ledger: LEDGER,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    const { container } = render(
      <ReceivePanel accountAddress={ADDRESS} chainId={8453} />,
    )
    const badges = Array.from(container.querySelectorAll('span')).map((el) => el.textContent)
    expect(badges.filter((t) => t === 'Matched')).toHaveLength(1)
    expect(badges.filter((t) => t === 'Unmatched')).toHaveLength(1)
    // The unearned state never reads as earned.
    expect(badges).not.toContain('Earned')
    // The balance is the MATCHED sum, not the sum of all rows.
    expect(container.textContent).toContain('2.500000 USDC')
    expect(container.textContent).not.toContain('101.500000 USDC')
  })

  it('disables the hand-off prepare when no destination is saved — the owner gate as UI state', async () => {
    vi.mocked(useReceiveLedger).mockReturnValue({
      ledger: { ...LEDGER, off_ramp_destination: null },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    const { container } = render(
      <ReceivePanel accountAddress={ADDRESS} chainId={8453} />,
    )
    const prepare = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Prepare transfer',
    )
    expect(prepare).not.toBeUndefined()
    expect(prepare?.disabled).toBe(true)
    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
  })

  it('shows the saved destination and enables the prepare when the balance is earned', async () => {
    vi.mocked(useReceiveLedger).mockReturnValue({
      ledger: LEDGER,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    const { container } = render(
      <ReceivePanel accountAddress={ADDRESS} chainId={8453} />,
    )
    expect(container.textContent).toContain('0x5555')
    const prepare = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Prepare transfer',
    )
    expect(prepare?.disabled).toBe(false)
  })

  // #3812: the hand-off is owner-signed. With the signer set known and nobody
  // here able to sign, it offers the owner wallet connect in place — never
  // while the set is unknown, and never to an account a passkey can sign for.
  describe('the hand-off signature (#3812)', () => {
    const PREPARED = {
      submit: { token_address: LEDGER.usdc_address, to: '0x5555555555555555555555555555555555555555', amount_atomic: '2500000' },
      prepared: {},
    }

    async function openHandoff(signersResponse: () => Promise<unknown>) {
      vi.mocked(useReceiveLedger).mockReturnValue({ ledger: LEDGER, loading: false, error: null, refetch: vi.fn() })
      vi.mocked(api.get).mockImplementation((url: string) =>
        url.includes('/signers') ? (signersResponse() as never) : (Promise.resolve([]) as never),
      )
      vi.mocked(api.post).mockResolvedValue(PREPARED as never)
      render(<ReceivePanel accountAddress={ADDRESS} chainId={8453} />)
      fireEvent.click(screen.getByRole('button', { name: 'Prepare transfer' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Sign transfer' })).toBeTruthy())
    }

    it('an owner-only account with no wallet here is offered the connect, and Sign waits', async () => {
      await openHandoff(() =>
        Promise.resolve({ account_address: ADDRESS, chain_id: 8453, owner_address: '0x' + 'ee'.repeat(20), passkeys: [] }),
      )
      await waitFor(() => expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy())
      expect(screen.getByText(/Connect your account owner wallet to sign this transfer/)).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Sign transfer' }) as HTMLButtonElement).disabled).toBe(true)
    })

    it('a passkey account is offered no connect', async () => {
      await openHandoff(() =>
        Promise.resolve({
          account_address: ADDRESS,
          chain_id: 8453,
          owner_address: null,
          passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
        }),
      )
      expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
      expect((screen.getByRole('button', { name: 'Sign transfer' }) as HTMLButtonElement).disabled).toBe(false)
      // #3825: the passkey is not marked on this device, so the ceremony may
      // hand off — the #1097 line says so before Sign transfer.
      await waitFor(() => expect(screen.getByText(/passkey may be on another device/)).toBeTruthy())
    })

    it('a mixed account with the owner wallet connected shows no cross-device hint — the wallet signs (#3825)', async () => {
      const owner = '0x' + 'ee'.repeat(20)
      activeSigner.current = { type: 'eoa', address: owner, walletClient: {} }
      try {
        await openHandoff(() =>
          Promise.resolve({
            account_address: ADDRESS,
            chain_id: 8453,
            owner_address: owner,
            passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
          }),
        )
        expect((screen.getByRole('button', { name: 'Sign transfer' }) as HTMLButtonElement).disabled).toBe(false)
        await new Promise((r) => setTimeout(r, 0))
        expect(screen.queryByText(/passkey may be on another device/)).toBeNull()
      } finally {
        activeSigner.current = null
      }
    })

    it('an owner-only account shows no cross-device hint (#3825)', async () => {
      await openHandoff(() =>
        Promise.resolve({ account_address: ADDRESS, chain_id: 8453, owner_address: '0x' + 'ee'.repeat(20), passkeys: [] }),
      )
      await waitFor(() => expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy())
      expect(screen.queryByText(/passkey may be on another device/)).toBeNull()
    })

    it('a signer response without a passkeys array does not crash the hand-off (#3093)', async () => {
      await openHandoff(() =>
        Promise.resolve({ account_address: ADDRESS, chain_id: 8453, owner_address: '0x' + 'ee'.repeat(20) }),
      )
      await waitFor(() => expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy())
    })

    it('a failed signer read offers no connect — connecting would not fix it', async () => {
      await openHandoff(() => Promise.reject(new Error('boom')))
      expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
    })
  })
})
