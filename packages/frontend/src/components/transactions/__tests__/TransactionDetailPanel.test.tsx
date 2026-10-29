/**
 * The transaction detail panel (#4267, epic #4263): a header summary (the
 * counterparty, the kind in words, the amount, the status, one who/where/when
 * line and a callout when needed), a few plain-word Details rows per kind,
 * and every raw value behind a Technical details disclosure, closed by
 * default — shortened, with copy and an explorer link. The footer links the
 * account's transaction, only for a real hash.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import TransactionDetailPanel, { formatWhen } from '@/components/transactions/TransactionDetailPanel'
import { truncate } from '@/lib/format'
import type { AggregatedTransaction } from '@/types/transactions'

vi.mock('@/hooks/useEscapeToClose', () => ({ useEscapeToClose: vi.fn() }))
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))

const ACCOUNT = '0x4444444444444444444444444444444444444444'
const RESERVE = '0x6666666666666666666666666666666666666666'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const SENDER = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x3333333333333333333333333333333333333333'
const MERCHANT = '0x5555555555555555555555555555555555555555'
const HASH = `0x${'ab'.repeat(32)}`
const FUNDING = `0x${'cd'.repeat(32)}`
const SETTLEMENT = `0x${'ef'.repeat(32)}`
const PAYMENT_ID = 'pay_abcdef1234567890'

function tx(overrides: Partial<AggregatedTransaction> = {}): AggregatedTransaction {
  return {
    hash: HASH,
    type: 'erc20',
    from: ACCOUNT,
    to: RECIPIENT,
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1_700_000_000,
    blockNumber: 1,
    isError: false,
    tokenAddress: TOKEN,
    tokenSymbol: 'USDC',
    chainId: 8453,
    accountId: 'acc-main',
    accountAddress: ACCOUNT,
    accountName: 'Main',
    ...overrides,
  }
}

const x402Base = {
  source: 'x402',
  agentId: 'agent-1',
  agentName: 'Atlas',
  initiatedBy: 'agent',
  x402ResourceUrl: 'https://api.vendor.com/search?q=1',
  x402MerchantAddress: MERCHANT,
  paymentId: PAYMENT_ID,
  settlementScheme: 'eip3009',
  fundingTxHash: FUNDING,
  hash: FUNDING,
  deliveryReference: 'delivery-ref-7',
} satisfies Partial<AggregatedTransaction>

const KINDS = {
  // #4320: the settled row carries its proof — the sweep standard's derived
  // nonce — so "Matched by" rides beside the settlement hash.
  x402Recorded: tx({
    ...x402Base,
    settlementTxHash: SETTLEMENT,
    settlementTracking: 'verified',
    settlementProof: 'nonce',
    paymentProofStatus: 'protocol_receipt_attached',
  }),
  x402Checking: tx({ ...x402Base, settlementTxHash: null, settlementTracking: 'checking' }),
  x402Untracked: tx({ ...x402Base, settlementTxHash: null, settlementTracking: 'untracked' }),
  x402ReceiptProof: tx({
    ...x402Base,
    settlementTxHash: SETTLEMENT,
    settlementTracking: 'verified',
    settlementProof: 'receipt',
  }),
  // Pre-#4319 records carry no proof label: the hash is there, "Matched by" is not.
  x402LegacyProof: tx({
    ...x402Base,
    settlementTxHash: SETTLEMENT,
    settlementTracking: 'verified',
    settlementProof: 'legacy',
  }),
  // No `settlementTracking` on the wire (an older backend) — the fallback.
  x402Unrecorded: tx({ ...x402Base, settlementTxHash: null, paymentProofStatus: 'payment_confirmed' }),
  needsAttention: tx({
    ...x402Base,
    settlementTxHash: null,
    paymentFlowStatus: 'needs_attention',
    paymentAttentionReason: 'merchant_retry_rejected_after_payment',
  }),
  onChainFailed: tx({ initiatedBy: 'human', isError: true }),
  contactSend: tx({ initiatedBy: 'human' }),
  deposit: tx({ direction: 'in', from: SENDER, to: ACCOUNT }),
  ownTransfer: tx({
    to: RESERVE,
    initiatedBy: 'human',
    // A valuation, so the headline is a figure that COULD carry a sign.
    convertedAmount: '1.00',
    convertedCurrency: 'USD',
    ownTransfer: { toAccountId: 'acc-reserve', toAccountName: 'Reserve', toAccountAddress: RESERVE },
  }),
  sweep: tx({ direction: 'in', activityType: 'delegate_sweep', agentName: 'Atlas', from: SENDER, to: ACCOUNT }),
  accounting: tx({
    ...x402Base,
    settlementTxHash: SETTLEMENT,
    accounting: { status: 'failed', provider: 'fortnox', externalRef: null, error: 'Supplier missing' },
  }),
} satisfies Record<string, AggregatedTransaction>

function renderPanel(t: AggregatedTransaction) {
  return render(
    <LocaleProvider>
      <TransactionDetailPanel
        transaction={t}
        open
        onClose={vi.fn()}
        resolveAddress={(a) => (a.toLowerCase() === RECIPIENT ? 'Alice' : null)}
        accountNamesByAddress={new Map([
          [`${ACCOUNT}:8453`, 'Main'],
          [`${RESERVE}:8453`, 'Reserve'],
        ])}
      />
    </LocaleProvider>,
  )
}

const header = () => screen.getByTestId('transaction-detail-header')
const details = () => screen.getByTestId('transaction-detail-details')
const technical = () => screen.getByTestId('transaction-technical-details')
/** Everything but the Technical details disclosure. */
function outsideTechnical(): string {
  const dialog = screen.getByRole('dialog')
  const clone = dialog.cloneNode(true) as HTMLElement
  clone.querySelector('[data-testid="transaction-technical-details"]')?.remove()
  return clone.textContent ?? ''
}
/** The Details rows as label → value text. */
function rows(container: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of Array.from(container.querySelectorAll(':scope > div, :scope > dl > div'))) {
    const label = row.querySelector('dt')?.textContent ?? ''
    out[label] = row.querySelector('dd')?.textContent ?? ''
  }
  return out
}

/**
 * One Details row's value and note SEPARATELY, so each state's wording is
 * asserted as a full string (#4133) — the `rows()` concatenation above would
 * let a note leak into a value assertion and vice versa.
 */
function detailRow(label: string): { value: string; note: string } {
  const row = Array.from(details().querySelectorAll(':scope > div')).find(
    (r) => r.querySelector('dt')?.textContent === label,
  )
  if (!row) throw new Error(`no Details row "${label}"`)
  const dd = row.querySelector('dd')
  if (!dd) throw new Error(`no dd in "${label}"`)
  return {
    value: dd.querySelector(':scope > div')?.textContent ?? '',
    note: dd.querySelector(':scope > p')?.textContent ?? '',
  }
}

describe('TransactionDetailPanel — structure per kind', () => {
  it('renders nothing when no transaction is selected', () => {
    const { container } = render(<TransactionDetailPanel transaction={null} open={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(Object.entries(KINDS))('%s: header, Details and a closed Technical details', (_, t) => {
    renderPanel(t)
    expect(header()).toBeInTheDocument()
    expect(details().children.length).toBeGreaterThan(0)
    expect(technical().tagName).toBe('DETAILS')
    expect(technical()).not.toHaveAttribute('open')
  })

  it('x402 settled (verified): the host, the receipt in words, "Settled (verified)", no note (#4320)', () => {
    renderPanel(KINDS.x402Recorded)
    expect(screen.getByRole('dialog', { name: 'api.vendor.com' })).toBeInTheDocument()
    expect(within(header()).getByText('Paid by Atlas from Main', { exact: false })).toBeInTheDocument()
    expect(rows(details())).toEqual({
      For: 'api.vendor.com',
      Receipt: 'Attached',
      Settlement: 'Settled (verified)',
    })
    expect(detailRow('Settlement')).toEqual({ value: 'Settled (verified)', note: '' })
    expect(screen.getByText('Paid request')).toBeInTheDocument()
  })

  it('x402 checking: "Checking" and the on-chain look-up line, full strings (#4320)', () => {
    renderPanel(KINDS.x402Checking)
    expect(detailRow('Settlement')).toEqual({
      value: 'Checking',
      note: 'Haven is looking for the merchant’s settlement on-chain. This usually takes a minute.',
    })
  })

  it('x402 not tracked: "Not tracked" and only what the record proves (#4320)', () => {
    renderPanel(KINDS.x402Untracked)
    expect(detailRow('Settlement')).toEqual({
      value: 'Not tracked',
      note: 'This payment left your account. Haven has no record of the merchant’s settlement for it.',
    })
    // No cause Haven does not know (S5): the row never explains WHY.
    expect(detailRow('Settlement').note).not.toMatch(/because|refused|expired/i)
  })

  it('fallback — no settlementTracking field (an older backend): today\'s two states (#4320)', () => {
    const { unmount } = renderPanel(KINDS.x402Unrecorded)
    expect(detailRow('Settlement')).toEqual({
      value: 'Not recorded yet',
      note: 'The payment left your account; no settlement from the merchant has been recorded.',
    })
    unmount()
    // The verified fallback keeps its wording too.
    renderPanel(tx({ ...x402Base, settlementTxHash: SETTLEMENT }))
    expect(detailRow('Settlement')).toEqual({ value: 'Recorded (verified)', note: '' })
  })

  it('"Matched by" names the proof beside the settlement hash (#4320)', () => {
    renderPanel(KINDS.x402Recorded)
    expect(within(technical()).getByText('Matched by')).toBeInTheDocument()
    expect(within(technical()).getByText('Payment nonce')).toBeInTheDocument()
  })

  it('"Matched by" reads the Tier 2 receipt as "Merchant receipt"', () => {
    renderPanel(KINDS.x402ReceiptProof)
    expect(within(technical()).getByText('Matched by')).toBeInTheDocument()
    expect(within(technical()).getByText('Merchant receipt')).toBeInTheDocument()
  })

  it('a legacy proof names nothing: no "Matched by" row', () => {
    renderPanel(KINDS.x402LegacyProof)
    expect(within(technical()).getByText('Settlement transaction')).toBeInTheDocument()
    expect(within(technical()).queryByText('Matched by')).not.toBeInTheDocument()
  })

  it('no settlement state says failed, missing or error (#3763 guard, #4320)', () => {
    for (const kind of ['x402Recorded', 'x402Checking', 'x402Untracked', 'x402ReceiptProof', 'x402LegacyProof', 'x402Unrecorded'] as const) {
      const { unmount } = renderPanel(KINDS[kind])
      const settlement = detailRow('Settlement')
      expect(`${settlement.value} ${settlement.note}`.toLowerCase()).not.toMatch(/failed|missing|error/)
      const matched = within(technical()).queryByText('Matched by')
      if (matched) expect(matched.textContent?.toLowerCase()).not.toMatch(/failed|missing|error/)
      unmount()
    }
  })

  it('erc7710 is one transaction: no Settlement row', () => {
    renderPanel(tx({ ...x402Base, settlementScheme: 'erc7710', fundingTxHash: null, hash: HASH }))
    expect(rows(details())).not.toHaveProperty('Settlement')
    expect(within(technical()).getByText('ERC-7710')).toBeInTheDocument()
  })

  it('needs attention: the stranded-funds sentence and a link to the agent page', () => {
    renderPanel(KINDS.needsAttention)
    expect(within(header()).getByText('Needs attention')).toBeInTheDocument()
    expect(
      within(header()).getByText(
        'A payment was funded on-chain but didn’t reach the merchant, leaving money in your agent’s wallet.',
      ),
    ).toBeInTheDocument()
    expect(within(header()).getByRole('link', { name: 'Open agent' })).toHaveAttribute('href', '/agents/agent-1')
  })

  it('an on-chain failure: Failed, "Payment attempt", and nothing left the account', () => {
    renderPanel(KINDS.onChainFailed)
    expect(within(header()).getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Payment attempt')).toBeInTheDocument()
    expect(
      within(header()).getByText('The transaction failed on-chain. Nothing left your account.'),
    ).toBeInTheDocument()
    expect(within(header()).getByText('Attempted by you from Main', { exact: false })).toBeInTheDocument()
  })

  it('a failed agent-tab intent with no transaction never claims an on-chain failure', () => {
    renderPanel(tx({ ...x402Base, hash: 'activity-payment-1', fundingTxHash: null, settlementScheme: null, isError: true }))
    expect(screen.getByText('Payment attempt')).toBeInTheDocument()
    expect(screen.getByRole('dialog').textContent).not.toContain('failed on-chain')
  })

  it('a failed x402 payment is a "Payment attempt", not a "Paid request"', () => {
    renderPanel(tx({ ...KINDS.x402Recorded, isError: true }))
    expect(screen.getByText('Payment attempt')).toBeInTheDocument()
    expect(screen.queryByText('Paid request')).toBeNull()
  })

  it('an observed merchant response is not an attached receipt', () => {
    renderPanel(tx({ ...KINDS.x402Recorded, paymentProofStatus: 'merchant_response_observed' }))
    expect(rows(details()).Receipt).toBe('Not attached (the merchant responded)')
  })

  it('an x402 row with no recorded scheme shows no Settlement row', () => {
    renderPanel(tx({ ...x402Base, settlementScheme: null, fundingTxHash: null, hash: HASH }))
    expect(rows(details())).not.toHaveProperty('Settlement')
  })

  it('a contact send: the contact, by you', () => {
    renderPanel(KINDS.contactSend)
    expect(screen.getByRole('dialog', { name: 'Alice' })).toBeInTheDocument()
    expect(screen.getByText('Payment')).toBeInTheDocument()
    expect(within(header()).getByText('Sent by you from Main', { exact: false })).toBeInTheDocument()
    expect(rows(details())).toEqual({ To: 'Alice' })
  })

  it('the mark: a named counterparty gets its monogram, an unnamed one the direction mark', () => {
    const { unmount } = renderPanel(KINDS.contactSend)
    expect(screen.getByRole('dialog').textContent).toContain('AL')
    unmount()
    renderPanel(tx({ to: SENDER, initiatedBy: 'human' }))
    expect(screen.getByRole('dialog', { name: 'New recipient' })).toBeInTheDocument()
    expect(screen.getByRole('dialog').textContent).not.toContain('NR')
  })

  it('a send with no owner record never says "you" (#2097)', () => {
    renderPanel(tx())
    expect(within(header()).getByText('Sent from Main', { exact: false })).toBeInTheDocument()
    expect(header().textContent).not.toMatch(/\byou\b/i)
  })

  it('a deposit: "Deposit", into the account, from an outside wallet', () => {
    renderPanel(KINDS.deposit)
    expect(screen.getByRole('dialog', { name: 'Deposit' })).toBeInTheDocument()
    // The kind would only repeat the title: it is dropped, not shown twice.
    expect(screen.getAllByText('Deposit')).toHaveLength(1)
    expect(within(header()).getByText('Into Main', { exact: false })).toBeInTheDocument()
    expect(rows(details())).toEqual({ From: 'An outside wallet' })
  })

  it('an own transfer: the row title, From → To in the header, and an unsigned amount', () => {
    renderPanel(KINDS.ownTransfer)
    expect(screen.getByRole('dialog', { name: 'Moved between your accounts' })).toBeInTheDocument()
    expect(screen.getByText('Transfer')).toBeInTheDocument()
    expect(within(header()).getByText('From Main to Reserve', { exact: false })).toBeInTheDocument()
    expect(rows(details())).toEqual({ By: 'You' })
    const headline = header().querySelector('.v2-tabular')
    expect(headline?.textContent).toMatch(/1\.00/)
    expect(headline?.textContent).not.toMatch(/^[-+−]/)
    expect(header().textContent).not.toContain('Payment sent by you')
  })

  it('an own transfer with no owner record is by "Your accounts"', () => {
    renderPanel(tx({ ...KINDS.ownTransfer, initiatedBy: 'unknown' }))
    expect(rows(details())).toEqual({ By: 'Your accounts' })
  })

  it('a sweep (the agent allowance funding, returned): Recovered, from the agent into the account', () => {
    renderPanel(KINDS.sweep)
    expect(within(header()).getByText('Recovered')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Returned from Atlas' })).toBeInTheDocument()
    expect(within(header()).getByText('Into Main', { exact: false })).toBeInTheDocument()
    // #4312 E: the copy must hold one line at 1280 AND 390 — the old sentence
    // stranded "wallet" on line 2 (measured in the polish e2e spec).
    expect(rows(details())).toEqual({ 'What happened': 'Unspent allowance returned' })
  })

  it('accounting present: the badge, linked to /accounting, and the failure reason in words', () => {
    renderPanel(KINDS.accounting)
    const accountingRow = rows(details())
    expect(accountingRow.Accounting).toBe('Not fed')
    expect(accountingRow.Reason).toBe('Supplier missing')
    expect(within(details()).getByRole('link', { name: /Not fed/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/accounting'),
    )
  })
})

describe('TransactionDetailPanel — the words that are gone', () => {
  it.each(Object.entries(KINDS))('%s: no raw or retired label', (_, t) => {
    renderPanel(t)
    const all = screen.getByRole('dialog').textContent ?? ''
    expect(outsideTechnical()).not.toMatch(/x402 payment/i)
    expect(all).not.toContain('Merchant settlement')
    expect(all).not.toContain('protocol_receipt_attached')
    expect(all).not.toContain('Funding from your account')
    for (const element of Array.from(screen.getByRole('dialog').querySelectorAll('dd, div, p, span'))) {
      if (element.closest('[data-testid="transaction-technical-details"]')) continue
      expect(element.textContent).not.toBe('Not recorded')
    }
  })
})

describe('TransactionDetailPanel — once, in the header', () => {
  it.each(Object.entries(KINDS))('%s: amount, date, agent and account appear once', (_, t) => {
    renderPanel(t)
    const text = screen.getByRole('dialog').textContent ?? ''
    const count = (needle: string) => text.split(needle).length - 1
    // The header is the panel's title row plus the summary block; neither
    // Details nor Technical details repeats what it says.
    const below = `${details().textContent}${technical().textContent}`
    const date = formatWhen(t.timestamp)
    for (const needle of [date, `${t.valueFormatted} ${t.asset}`, 'Main', ...(t.agentName ? [t.agentName] : [])]) {
      expect(count(needle), needle).toBe(1)
      expect(below, needle).not.toContain(needle)
    }
    expect(header().textContent).toContain(date)
  })
})

describe('TransactionDetailPanel — every field is still reachable', () => {
  /** Technical details' labels per kind: the raw fields the old panel showed. */
  const TECHNICAL: Record<keyof typeof KINDS, string[]> = {
    x402Recorded: ['Network', 'Payment ID', 'Settlement method', 'Delivered', 'Merchant address', 'Your account', 'Token contract', 'Transaction', 'Settlement transaction', 'Matched by'],
    x402Checking: ['Network', 'Payment ID', 'Settlement method', 'Delivered', 'Merchant address', 'Your account', 'Token contract', 'Transaction'],
    x402Untracked: ['Network', 'Payment ID', 'Settlement method', 'Delivered', 'Merchant address', 'Your account', 'Token contract', 'Transaction'],
    x402ReceiptProof: ['Network', 'Payment ID', 'Settlement method', 'Delivered', 'Merchant address', 'Your account', 'Token contract', 'Transaction', 'Settlement transaction', 'Matched by'],
    x402LegacyProof: ['Network', 'Payment ID', 'Settlement method', 'Delivered', 'Merchant address', 'Your account', 'Token contract', 'Transaction', 'Settlement transaction'],
    x402Unrecorded: ['Network', 'Payment ID', 'Settlement method', 'Delivered', 'Merchant address', 'Your account', 'Token contract', 'Transaction'],
    needsAttention: ['Network', 'Payment ID', 'Settlement method', 'Delivered', 'Merchant address', 'Your account', 'Token contract', 'Transaction'],
    onChainFailed: ['Network', 'To address', 'Your account', 'Token contract', 'Transaction'],
    contactSend: ['Network', 'To address', 'Your account', 'Token contract', 'Transaction'],
    deposit: ['Network', 'From address', 'Your account', 'Token contract', 'Transaction'],
    ownTransfer: ['Network', 'From address', 'To address', 'Token contract', 'Transaction'],
    sweep: ['Network', 'From address', 'Your account', 'Token contract', 'Transaction'],
    accounting: ['Network', 'Payment ID', 'Settlement method', 'Delivered', 'Merchant address', 'Your account', 'Token contract', 'Transaction', 'Settlement transaction'],
  }

  it.each(Object.entries(KINDS))('%s: the Technical details inventory', (name, t) => {
    renderPanel(t)
    const labels = Array.from(technical().querySelectorAll('dt')).map((dt) => dt.textContent)
    expect(labels).toEqual(TECHNICAL[name as keyof typeof KINDS])
  })

  it('both eip3009 hashes: the funding leg as "Transaction", the merchant settlement beside it', () => {
    renderPanel(KINDS.x402Recorded)
    const hrefs = within(technical()).getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs).toContain(`https://basescan.org/tx/${FUNDING}`)
    expect(hrefs).toContain(`https://basescan.org/tx/${SETTLEMENT}`)
    expect(within(technical()).getByText('EIP-3009')).toBeInTheDocument()
    expect(within(technical()).getByText('delivery-ref-7')).toBeInTheDocument()
  })

  it('shortens every address and hash, with copy and an explorer link — never in full', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPanel(KINDS.x402Recorded)
    const dialog = screen.getByRole('dialog')
    for (const full of [MERCHANT, ACCOUNT, TOKEN, FUNDING, SETTLEMENT]) {
      expect(dialog.textContent).not.toContain(full)
      expect(within(technical()).getByText(truncate(full))).toHaveAttribute('title', full)
    }
    expect(within(technical()).getAllByRole('link', { name: 'Open address in explorer' })).toHaveLength(3)
    expect(within(technical()).getAllByRole('link', { name: 'Open transaction in explorer' })).toHaveLength(2)
    fireEvent.click(within(technical()).getAllByRole('button', { name: 'Copy address' })[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MERCHANT))
    fireEvent.click(within(technical()).getByRole('button', { name: 'Copy payment ID' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PAYMENT_ID))
  })

  // The keyboard itself is the browser's: a native <summary> is focusable and
  // toggles on Enter/Space, which jsdom does not implement — the Playwright
  // spec (`transactions-detail.spec.ts`) presses it. Here: the native shape.
  it('is a native disclosure: the summary is the details element\'s first child', () => {
    renderPanel(KINDS.x402Recorded)
    const summary = technical().firstElementChild
    expect(summary?.tagName).toBe('SUMMARY')
    expect(summary).toHaveTextContent('Technical details')
  })
})

describe('TransactionDetailPanel — the footer', () => {
  const footerLink = () => screen.queryByRole('link', { name: 'View on explorer' })

  it('links the transaction that left the account — the funding leg on eip3009', () => {
    renderPanel(KINDS.x402Recorded)
    expect(footerLink()).toHaveAttribute('href', `https://basescan.org/tx/${FUNDING}`)
    expect(footerLink()?.closest('[data-side-panel-footer]')).not.toBeNull()
  })

  it('links a plain transfer by its hash', () => {
    renderPanel(KINDS.contactSend)
    expect(footerLink()).toHaveAttribute('href', `https://basescan.org/tx/${HASH}`)
  })

  it('is absent for a synthetic activity- hash', () => {
    renderPanel(tx({ hash: 'activity-payment-42', explorerUrl: undefined }))
    expect(footerLink()).toBeNull()
    expect(document.querySelector('[data-side-panel-footer]')).toBeNull()
    expect(within(technical()).queryByText('Transaction')).toBeNull()
  })

  it('honours explorerUrl: null hides it; a value stands in only where the chain has no explorer', () => {
    const { unmount } = renderPanel(tx({ explorerUrl: null }))
    expect(footerLink()).toBeNull()
    unmount()
    renderPanel(tx({ chainId: 999999, explorerUrl: 'https://explorer.example/tx/abc' }))
    expect(footerLink()).toHaveAttribute('href', 'https://explorer.example/tx/abc')
  })

  it('an agent-tab row: the settlement-first explorerUrl never wins over the funding leg (#3763 superseded)', () => {
    renderPanel(
      tx({
        ...KINDS.x402Recorded,
        explorerUrl: `https://basescan.org/tx/${SETTLEMENT}`,
      }),
    )
    expect(footerLink()).toHaveAttribute('href', `https://basescan.org/tx/${FUNDING}`)
  })

  it('a synthetic hash is never paired with a footer, whatever explorerUrl says', () => {
    renderPanel(tx({ hash: 'activity-payment-7', explorerUrl: 'https://basescan.org/tx/0xabc' }))
    expect(footerLink()).toBeNull()
  })
})

describe('TransactionDetailPanel — the headline amount', () => {
  it('signs the currency figure by direction and keeps the token amount beside it', () => {
    const { rerender } = renderPanel(tx({ convertedAmount: '134.50', convertedCurrency: 'SEK' }))
    const text = () => (header().textContent ?? '').replace(/ /g, ' ')
    expect(text()).toContain('-134,50 kr')
    expect(text()).toContain('1.00 USDC')
    rerender(
      <LocaleProvider>
        <TransactionDetailPanel
          transaction={tx({ direction: 'in', from: SENDER, convertedAmount: '134.50', convertedCurrency: 'SEK' })}
          open
          onClose={vi.fn()}
        />
      </LocaleProvider>,
    )
    expect(text()).toContain('+134,50 kr')
  })

  it('renders an unknown valuation as an em dash — the token amount still shows', () => {
    renderPanel(tx())
    expect(within(header()).getByText('—')).toBeInTheDocument()
    expect(header().textContent).toContain('1.00 USDC')
  })
})
