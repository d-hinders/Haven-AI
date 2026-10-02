import { ProductFrame } from '../ProductFrame'
import { SITE_TYPE } from '../SiteSection'
import { AGENT_BUDGETS, RECENT_ACTIVITY } from './fixtures'

/**
 * The hero's product frame (mockup `index.html:37-77`): agent budgets and
 * recent activity, settled state. Decorative — the hero section wraps it in
 * `aria-hidden` and its prose carries the meaning (#3574).
 */
export function HeroAgentsFrame() {
  return (
    <ProductFrame env="Operations" screen="Agents">
      <div>
        {AGENT_BUDGETS.map((agent) => (
          <div
            key={agent.name}
            className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 border-t border-[var(--v2-border)] py-3 first:border-t-0 first:pt-0"
          >
            <div className="justify-self-start whitespace-nowrap text-[14px] font-semibold text-[var(--v2-ink)]">
              <span aria-hidden className="mr-[7px] inline-block h-2 w-2 rounded-full bg-[var(--v2-success)] align-[1px]" />
              {agent.name}
              <span className="ml-1.5 font-normal text-[var(--v2-ink-3)]">{agent.role}</span>
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-4 text-[12.5px]">
                <b className={`font-semibold text-[var(--v2-ink)] ${SITE_TYPE.mono}`}>
                  {agent.used} of {agent.total} USDC
                </b>
                <span className={`text-[var(--v2-ink-3)] ${SITE_TYPE.mono}`}>{agent.percent}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--v2-surface)]">
                <div className="h-full rounded-full bg-[var(--v2-brand)]" style={{ width: `${agent.percent}%` }} />
              </div>
              <div className="mt-1.5 text-[12px] text-[var(--v2-ink-3)]">{agent.meta}</div>
            </div>
          </div>
        ))}

        <div className="mb-2.5 mt-4 text-[13px] font-semibold text-[var(--v2-ink)]">Recent activity</div>
        {RECENT_ACTIVITY.map((row, index) => (
          <div
            key={`${row.agent}-${index}`}
            className="grid grid-cols-[28px_1fr_auto] items-center gap-3 border-t border-[var(--v2-border)] py-3 text-[13px] first:border-t-0"
          >
            <div
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--v2-brand-soft)] text-[13px] font-semibold text-[var(--v2-brand)]"
            >
              ↑
            </div>
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold leading-tight text-[var(--v2-ink)]">{row.agent}</div>
              <div className="mt-0.5 text-[12px] text-[var(--v2-ink-3)]">
                {row.detail} ·{' '}
                <span className="inline-flex h-[18px] items-center rounded-full bg-[var(--v2-success-soft)] px-2 text-[11px] font-medium text-[var(--v2-success)]">
                  {row.status}
                </span>
              </div>
            </div>
            <div className={`text-right font-semibold text-[var(--v2-ink)] ${SITE_TYPE.mono}`}>
              {row.amount}
              <small className="block font-normal text-[11.5px] not-italic text-[var(--v2-ink-3)]">{row.when}</small>
            </div>
          </div>
        ))}
      </div>
    </ProductFrame>
  )
}
