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
import { render, screen, waitFor } from '@testing-library/react'
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

vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => null,
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
      <ReceivePanel accountAddress={ADDRESS} accountId="acc-1" chainId={8453} />,
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
      <ReceivePanel accountAddress={ADDRESS} accountId="acc-1" chainId={8453} />,
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
      <ReceivePanel accountAddress={ADDRESS} accountId="acc-1" chainId={8453} />,
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
      <ReceivePanel accountAddress={ADDRESS} accountId="acc-1" chainId={8453} />,
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
      <ReceivePanel accountAddress={ADDRESS} accountId="acc-1" chainId={8453} />,
    )
    expect(container.textContent).toContain('0x5555')
    const prepare = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Prepare transfer',
    )
    expect(prepare?.disabled).toBe(false)
  })
})
