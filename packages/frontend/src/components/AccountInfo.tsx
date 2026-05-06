'use client'

import InfoModal, { DiagramBox, Arrow, Label, type InfoPage } from './InfoModal'

const PAGES: InfoPage[] = [
  {
    title: 'Account Overview',
    subtitle: 'Managing your Haven account',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed">
          The account page gives you full visibility into your <span className="text-[var(--v2-ink)]">Haven account</span> &mdash;
          ownership structure, on-chain details, portfolio breakdown, and complete transaction history.
        </p>

        <div className="space-y-3">
          <div className="p-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
            <p className="text-xs text-[var(--v2-ink)] font-medium mb-1">Account details</p>
            <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
              Your account address, current nonce (transaction counter), signature threshold,
              and the list of owner addresses. The address links directly to Gnosisscan for on-chain verification.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
            <p className="text-xs text-[var(--v2-ink)] font-medium mb-1">Portfolio breakdown</p>
            <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
              Each token&apos;s balance with its fiat equivalent (USD or EUR).
              Prices are sourced from CoinGecko at load time.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
            <p className="text-xs text-[var(--v2-ink)] font-medium mb-1">Transaction history</p>
            <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
              Paginated history of all account transactions &mdash; incoming, outgoing, and agent-initiated.
              Includes amounts, counterparties, timestamps, and links to block explorer.
            </p>
          </div>
        </div>
      </div>
    ),
  },

  {
    title: 'Owners and Threshold',
    subtitle: 'Multi-signature security model',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed">
          A Haven account can have <span className="text-[var(--v2-ink)]">multiple owners</span> with a configurable
          signature threshold. This is one of the most important security features.
        </p>

        <div className="flex flex-col items-center gap-1 py-2">
          <div className="flex items-center gap-1">
            <DiagramBox label="Owner 1" sub="Your wallet" accent />
            <DiagramBox label="Owner 2" sub="Co-owner" />
            <DiagramBox label="Owner 3" sub="Backup" />
          </div>
          <Arrow />
          <DiagramBox label="Haven account (2 of 3 threshold)" sub="Requires 2 signatures to execute" accent />
        </div>

        <div className="space-y-3">
          <div className="p-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
            <div className="flex items-center gap-2 mb-1.5">
              <Label>Threshold</Label>
              <span className="text-xs text-[var(--v2-ink)] font-medium">N of M signatures</span>
            </div>
            <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
              The threshold determines how many owner signatures are needed to execute a transaction.
              A &ldquo;2 of 3&rdquo; account means any 2 of 3 owners must sign. This protects against a single
              compromised key.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
            <div className="flex items-center gap-2 mb-1.5">
              <Label>Nonce</Label>
              <span className="text-xs text-[var(--v2-ink)] font-medium">Transaction counter</span>
            </div>
            <p className="text-[11px] text-[var(--v2-ink-3)] leading-relaxed">
              The nonce increments with each executed transaction, preventing replay attacks.
              It also helps you track how many transactions have been processed.
            </p>
          </div>
        </div>

        <div className="text-[11px] text-amber-400/70 bg-amber-400/5 border border-amber-400/10 rounded-lg px-3 py-2 leading-relaxed">
          <span className="font-medium text-amber-400">Tip:</span> For high-value accounts, use at least a
          2-of-3 threshold. Store backup owner keys in separate locations. You can manage owners
          and threshold through Safe&#123;Wallet&#125; at{' '}
          <span className="text-amber-300">app.safe.global</span>.
        </div>
      </div>
    ),
  },

  {
    title: 'Transaction Types',
    subtitle: 'Understanding your transaction history',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed">
          Your Haven account processes different types of transactions. The history view shows all of them
          with clear labels.
        </p>

        <div className="space-y-3">
          {[
            {
              type: 'Outgoing transfer',
              desc: 'A token transfer sent from your account to another address. Initiated by you or by an agent.',
              color: 'text-red-400 bg-red-500/10',
            },
            {
              type: 'Incoming transfer',
              desc: 'Tokens received by your account from an external address.',
              color: 'text-emerald-400 bg-emerald-500/10',
            },
            {
              type: 'Module transaction',
              desc: 'Agent spending transfers that were allowed by your account rules.',
              color: 'text-[var(--v2-brand)] bg-[var(--v2-brand-soft)]',
            },
            {
              type: 'Multi-sig confirmation',
              desc: 'A transaction proposed by one owner, pending signatures from other owners before execution.',
              color: 'text-amber-400 bg-amber-500/10',
            },
          ].map((t) => (
            <div
              key={t.type}
              className="flex items-start gap-3 p-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]"
            >
              <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${t.color}`}>
                {t.type.split(' ')[0]}
              </span>
              <div>
                <p className="text-xs text-[var(--v2-ink)] font-medium">{t.type}</p>
                <p className="text-[11px] text-[var(--v2-ink-3)] mt-0.5 leading-relaxed">{t.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="text-[11px] text-[var(--v2-ink-3)] bg-[var(--v2-surface)] border border-[var(--v2-border)] rounded-lg px-3 py-2 leading-relaxed">
          <span className="text-[var(--v2-ink-2)]">Agent attribution:</span> When a transaction is initiated
          by a known agent delegate, the agent name appears next to the transaction so you can
          track which agent spent what.
        </div>
      </div>
    ),
  },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function AccountInfo({ open, onClose }: Props) {
  return <InfoModal open={open} onClose={onClose} pages={PAGES} />
}
