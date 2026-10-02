import { ProductFrame } from '../ProductFrame'
import { SITE_TYPE } from '../SiteSection'
import { ACCOUNTING_FEED } from './fixtures'

/**
 * The accounting section's product frame (mockup `index.html:200-208`): the
 * accounting feed, settled state — one failed push among synced ones, exactly
 * as the mockup settles (its animation retries the failed row and returns it
 * here). Decorative — the section wraps it in `aria-hidden`.
 */
export function AccountingFrame() {
  return (
    <ProductFrame env="Operations" screen="Accounting">
      <div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pb-3 text-[13.5px] font-semibold text-[var(--v2-ink)]">
          <span className="inline-flex h-[22px] items-center rounded-full bg-[var(--v2-success-soft)] px-2 text-[11.5px] font-medium text-[var(--v2-success)]">
            Connected
          </span>
          <span>Feeding Fortnox · Ada Lovelace AB</span>
          <small className="w-full font-normal text-[var(--v2-ink-3)]">Last push 2 minutes ago</small>
        </div>
        {ACCOUNTING_FEED.map((row) => (
          <div
            key={row.id}
            className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-[var(--v2-border)] py-3 text-[13px]"
          >
            <div className="min-w-0">
              <div className={`font-semibold text-[var(--v2-ink)] ${SITE_TYPE.mono}`}>{row.id}</div>
              <div className="mt-0.5 text-[12px] text-[var(--v2-ink-3)]">{row.detail}</div>
            </div>
            <span
              className={`inline-flex h-[22px] items-center whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium ${
                row.ok
                  ? 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
                  : 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]'
              }`}
            >
              {row.status}
            </span>
          </div>
        ))}
      </div>
    </ProductFrame>
  )
}
