import { ProductFrame } from '../ProductFrame'
import { SITE_TYPE } from '../SiteSection'
import { ACCOUNTING_FEED } from './fixtures'
import styles from './motion.module.css'

/**
 * The accounting section's product frame (mockup `index.html:200-208`): the
 * accounting feed. Decorative — the section wraps it in `aria-hidden`.
 *
 * The component owns the feed's markup and nothing else (#3575): slice 3's
 * `AnimatedAccountingFrame` drives the mockup's 11 s loop by passing `state`
 * for the one animated row (`pay_01…E0G2`); with no state the feed renders
 * the settled fixture state below, byte-for-byte what slice 2 shipped.
 */
/** The id of the row the loop animates (mockup `anim-e0g2`, index.html:205). */
export const ANIMATED_FEED_ID = 'pay_01…E0G2'

export type AccountingFrameState = {
  /** The animated row's status, through the loop's three states. */
  rowStatus: 'Failed' | 'Retrying' | 'Synced'
  /** The animated row's live detail text. */
  rowDetail: string
  /** The connector line's live text ("Last push just now"). */
  lastPush: string
  /** True while the row's success flash plays (site.css:335). */
  flashing?: boolean
}

export function AccountingFrame({ state }: { state?: AccountingFrameState } = {}) {
  return (
    <ProductFrame env="Operations" screen="Accounting">
      <div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pb-3 text-[13.5px] font-semibold text-[var(--v2-ink)]">
          <span className="inline-flex h-[22px] items-center rounded-full bg-[var(--v2-success-soft)] px-2 text-[11.5px] font-medium text-[var(--v2-success)]">
            Connected
          </span>
          <span>Feeding Fortnox · Ada Lovelace AB</span>
          <small className="w-full font-normal text-[var(--v2-ink-3)]" data-testid="accounting-last-push">
            {state?.lastPush ?? 'Last push 2 minutes ago'}
          </small>
        </div>
        {ACCOUNTING_FEED.map((row) => {
          const animated = state !== undefined && row.id === ANIMATED_FEED_ID
          const detail = animated ? state.rowDetail : row.detail
          const status = animated ? state.rowStatus : row.status
          const ok = animated ? state.rowStatus === 'Synced' : row.ok
          return (
            <div
              key={row.id}
              className={`grid grid-cols-[1fr_auto] items-center gap-3 border-t border-[var(--v2-border)] py-3 text-[13px] ${
                animated && state.flashing ? styles.flash : ''
              }`}
            >
              <div className="min-w-0">
                <div className={`font-semibold text-[var(--v2-ink)] ${SITE_TYPE.mono}`}>{row.id}</div>
                {/* Animated states truncate (their texts swap lengths; the
                    row's height must not move — #3575). Settled rows keep
                    slice 2's wrapping markup exactly. */}
                <div
                  className={`mt-0.5 text-[12px] text-[var(--v2-ink-3)] ${animated ? 'truncate' : ''}`}
                >
                  {detail}
                </div>
              </div>
              <span
                data-testid={row.id === ANIMATED_FEED_ID ? 'accounting-status' : undefined}
                className={`inline-flex h-[22px] items-center whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium ${
                  ok
                    ? 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
                    : animated && state.rowStatus === 'Retrying'
                      ? styles.pillPending
                      : 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]'
                }`}
              >
                {status}
              </span>
            </div>
          )
        })}
      </div>
    </ProductFrame>
  )
}
