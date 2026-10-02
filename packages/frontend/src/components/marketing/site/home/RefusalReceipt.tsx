import { Fragment } from 'react'
import { SITE_TYPE } from '../SiteSection'
import styles from './motion.module.css'
import { RECEIPT_ROW_STAGGER_MS } from './motion-timings'

/**
 * The enforcement band's refused-payment receipt (mockup
 * `index.html:241-251`), settled state: every field rendered, the refusal
 * box at the bottom. Decorative — the band wraps it in `aria-hidden`.
 *
 * The component owns the receipt's markup and nothing else (#3575): slice
 * 3's `AnimatedRefusalReceipt` drives the mockup's assembly animation by
 * passing `state`; with no state it renders the settled receipt below,
 * byte-for-byte what slice 2 shipped — what reduced motion shows.
 */
export type ReceiptAssemblyState = {
  /**
   * The replay counter: each entry remounts the rows (fresh keys) so their
   * CSS entrance restarts — the mockup's replay-on-every-entry
   * (`index.html:302-304`).
   */
  entry: number
}

export function RefusalReceipt({ state }: { state?: ReceiptAssemblyState } = {}) {
  const animate = state !== undefined
  const entry = state?.entry ?? 0

  const ROWS = [
    ['Agent', 'Atlas'],
    ['Requested', '40.00 USDC to research.example'],
    ['Budget', 'Monthly 250.00 USDC · 36.00 left this period'],
    ['Recipient', 'Allowed'],
    ['Books', 'Nothing to book'],
  ] as const

  return (
    <div className="overflow-hidden rounded-[14px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)]">
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.12)] px-[18px] py-3.5 text-[12.5px] text-[rgba(255,255,255,0.72)]">
        <span>Payment refused</span>
        <span className={SITE_TYPE.mono}>pay_01…7Q2N</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-[22px] gap-y-2.5 px-[18px] pb-3.5 pt-2 text-[13.5px]">
        {ROWS.map(([label, value], index) => {
          // The mockup staggers per dt/dd node pair: `Math.floor(i/2)*110` ms
          // over the dt,dd list (`index.html:301`) — here, the pair's index.
          const delay = index * RECEIPT_ROW_STAGGER_MS
          const delayStyle = animate ? { animationDelay: `${delay}ms` } : undefined
          return (
            <Fragment key={`${entry}-${index}`}>
              <dt
                className={`text-[rgba(255,255,255,0.72)] ${animate ? styles.receiptRow : ''}`}
                style={delayStyle}
              >
                {label}
              </dt>
              <dd
                className={`m-0 text-white ${label === 'Requested' ? SITE_TYPE.mono : ''} ${
                  animate ? styles.receiptRow : ''
                }`}
                style={delayStyle}
              >
                {value}
              </dd>
            </Fragment>
          )
        })}
      </dl>
      <div
        key={`${entry}-refusal`}
        className={`mx-[18px] mb-[18px] grid grid-cols-[auto_1fr] items-start gap-3 rounded-lg border border-[rgba(255,120,110,0.25)] bg-[rgba(180,35,24,0.16)] p-3.5 text-[13px] ${
          animate ? styles.refusalBox : ''
        }`}
      >
        <b aria-hidden className="font-semibold text-[#ffb4ad]">
          ✕
        </b>
        <div>
          <b className="font-semibold text-[#ffb4ad]">Refused: over budget</b>
          <br />
          <span className="text-[rgba(255,255,255,0.72)]">
            Reverted on-chain at execution. Nothing moved, nothing queued for review.
          </span>
        </div>
      </div>
    </div>
  )
}
