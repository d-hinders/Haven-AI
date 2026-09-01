'use client'

import InfoModal, { InfoNote, InfoStep, type InfoPage } from './InfoModal'

const PAGES: InfoPage[] = [
  {
    title: 'Use your agent',
    subtitle: 'Make your first agent payment',
    content: (
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
          When you created your agent, its{' '}
          <span className="font-medium text-[var(--v2-ink)]">Haven credential</span> was generated on your own
          device — a small JSON file holding an API key, which identifies the agent to Haven but cannot spend by
          itself, and a private signing key, which signs the agent&apos;s payments and never reaches Haven&apos;s
          backend. Add it to your agent and it can pay for x402-enabled APIs and services on your behalf.
        </p>

        <div className="space-y-3">
          <InfoStep number={1} title="Add the credential to your agent">
            Use the credential you saved when you created the agent. Paste it into your agent&apos;s code, drop
            the JSON into a file it loads, or set it as an environment variable such as{' '}
            <code className="rounded bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[12px] text-[var(--v2-ink)]">
              HAVEN_CREDENTIAL
            </code>{' '}
            — whatever your runtime expects.
          </InfoStep>

          <InfoStep number={2} title="Call an x402-enabled service">
            When the agent hits a service that responds with{' '}
            <code className="rounded bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[12px] text-[var(--v2-ink)]">
              402 Payment Required
            </code>
            , the payment is signed by your agent&apos;s own key and constrained by the budget you signed —
            automatically, with no extra step from you.
          </InfoStep>

          <InfoStep number={3} title="Watch the payment land here">
            The transaction appears in{' '}
            <span className="font-medium text-[var(--v2-ink)]">Recent transactions</span> on the dashboard.
            Anything above the agent&apos;s remaining budget is declined before any money moves — raise the
            budget, or wait for its reset period, if the agent needs more.
          </InfoStep>
        </div>

        <InfoNote label="Lost the credential?">
          The credential is shown <span className="font-medium text-[var(--v2-ink)]">only once</span>, right
          after you create an agent, and Haven cannot show it again. The detail page lists the agent&apos;s
          budget and signing address, but not its private signing key — that key exists only in the copy you
          saved. If you didn&apos;t save it, create a new agent and store the credential somewhere safe this
          time.
        </InfoNote>
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
