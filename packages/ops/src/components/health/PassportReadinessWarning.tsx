/**
 * The passport half-configured state, named (#4720, epic #4718).
 *
 * A chain in `issuance_only` anchors real, revocable passports on-chain that
 * no merchant can verify: the schema UID is set, `PASSPORT_RECEIPT_SIGNING_KEY`
 * is not, so `GET /passport/verify` answers 503. Until this card it showed only
 * as a boot log line and inside the raw `/health/ops` JSON below, which is how
 * #1151 went unnoticed for days.
 *
 * Renders NOTHING when `unverifiableChainIds` is empty: a warning that shows
 * when things are fine is one operators learn to scroll past.
 */
import { Card, StatusBadge } from '@haven_ai/ui'
import type { OpsHealth } from '../../lib/ops-types'
import { chainName } from '../../lib/format'

type PassportReadiness = OpsHealth['ops_diagnostics']['passport']

export function PassportReadinessWarning({ passport }: { passport: PassportReadiness | null | undefined }) {
  const chainIds = passport?.unverifiableChainIds ?? []
  if (chainIds.length === 0) return null
  return (
    <Card className="overflow-hidden" hover={false}>
      <Card.Header
        as="h2"
        padding="none"
        className="px-5"
        title="Passports no merchant can verify"
        description="Issuance is on and the receipt verifier is off: new passports can anchor on-chain, and GET /passport/verify answers 503."
        actions={
          <StatusBadge tone="warning">
            {chainIds.length} chain{chainIds.length === 1 ? '' : 's'}
          </StatusBadge>
        }
      />
      <Card.Section divided>
        {chainIds.map((chainId) => (
          <div key={chainId} className="px-5 py-3">
            <p className="text-sm font-medium text-[var(--v2-ink)]">
              {chainName(chainId)} <span className="v2-tabular text-xs text-[var(--v2-ink-3)]">({chainId})</span>
            </p>
            <p className="text-xs text-[var(--v2-ink-3)]">
              Set PASSPORT_RECEIPT_SIGNING_KEY (docs/operations/passport-verification-setup.md), or unset this
              chain&apos;s AGENT_PASSPORT_SCHEMA_UID_{chainId} to stop issuing.
            </p>
          </div>
        ))}
      </Card.Section>
    </Card>
  )
}
