import { SITE_TYPE } from '../SiteSection'

/**
 * The enforcement band's refused-payment receipt (mockup `index.html:241-251`),
 * settled state: every field rendered, the refusal box at the bottom. It is
 * the state slice 3's assembly animation lands on, and what reduced motion
 * shows. Decorative — the band wraps it in `aria-hidden`.
 */
export function RefusalReceipt() {
  return (
    <div className="overflow-hidden rounded-[14px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)]">
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.12)] px-[18px] py-3.5 text-[12.5px] text-[rgba(255,255,255,0.72)]">
        <span>Payment refused</span>
        <span className={SITE_TYPE.mono}>pay_01…7Q2N</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-[22px] gap-y-2.5 px-[18px] pb-3.5 pt-2 text-[13.5px]">
        <dt className="text-[rgba(255,255,255,0.72)]">Agent</dt>
        <dd className="m-0 text-white">Atlas</dd>
        <dt className="text-[rgba(255,255,255,0.72)]">Requested</dt>
        <dd className={`m-0 text-white ${SITE_TYPE.mono}`}>40.00 USDC to research.example</dd>
        <dt className="text-[rgba(255,255,255,0.72)]">Budget</dt>
        <dd className="m-0 text-white">Monthly 250.00 USDC · 36.00 left this period</dd>
        <dt className="text-[rgba(255,255,255,0.72)]">Recipient</dt>
        <dd className="m-0 text-white">Allowed</dd>
        <dt className="text-[rgba(255,255,255,0.72)]">Books</dt>
        <dd className="m-0 text-white">Nothing to book</dd>
      </dl>
      <div className="mx-[18px] mb-[18px] grid grid-cols-[auto_1fr] items-start gap-3 rounded-lg border border-[rgba(255,120,110,0.25)] bg-[rgba(180,35,24,0.16)] p-3.5 text-[13px]">
        <b aria-hidden className="font-semibold text-[#ffb4ad]">✕</b>
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
