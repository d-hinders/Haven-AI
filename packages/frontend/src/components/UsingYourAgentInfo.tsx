'use client'

import InfoModal, { type InfoPage } from './InfoModal'

const PAGES: InfoPage[] = [
  {
    title: 'Use your agent',
    subtitle: 'Make your first agent payment',
    content: (
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
          Your agent has a <span className="text-[var(--v2-ink)]">Haven credential</span> — a private key plus a
          small JSON file that lets it sign payments within the rules you set. Once the credential is in your
          agent&apos;s code, it can pay for APIs and services on your behalf.
        </p>

        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
            <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand-soft)]">
              <span className="text-[10px] font-bold text-[var(--v2-brand)]">1</span>
            </div>
            <div>
              <p className="text-xs font-medium text-[var(--v2-ink)]">Add the credential to your agent</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
                Open the agent&apos;s detail page in Haven, copy the credential JSON, and load it in your agent
                code as <code className="rounded bg-[var(--v2-surface-2)] px-1 text-[10px]">HAVEN_CREDENTIAL</code>{' '}
                (or whatever your runtime expects).
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
            <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand-soft)]">
              <span className="text-[10px] font-bold text-[var(--v2-brand)]">2</span>
            </div>
            <div>
              <p className="text-xs font-medium text-[var(--v2-ink)]">Call an x402-enabled service</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
                When the agent calls a service that responds with{' '}
                <code className="rounded bg-[var(--v2-surface-2)] px-1 text-[10px]">402 Payment Required</code>,
                Haven signs and settles the payment automatically — within the budget you set.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
            <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand-soft)]">
              <span className="text-[10px] font-bold text-[var(--v2-brand)]">3</span>
            </div>
            <div>
              <p className="text-xs font-medium text-[var(--v2-ink)]">Watch the payment land here</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
                The transaction appears in <span className="text-[var(--v2-ink)]">Recent transactions</span> on
                the dashboard. Payments above the agent&apos;s remaining budget wait for your approval before any
                money moves.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2 text-[11px] leading-relaxed text-[var(--v2-ink-3)]">
          <span className="text-[var(--v2-ink-2)]">Where&apos;s the credential?</span> Open{' '}
          <span className="text-[var(--v2-ink)]">Agents</span> → choose your agent → the credential JSON is on
          the detail page. Save it once — Haven cannot show it again after the window closes.
        </div>
      </div>
    ),
  },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function UsingYourAgentInfo({ open, onClose }: Props) {
  return <InfoModal open={open} onClose={onClose} pages={PAGES} />
}
