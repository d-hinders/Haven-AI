import { ProductFrame } from '../ProductFrame'
import { SITE_TYPE } from '../SiteSection'
import { AGENT_BUDGETS, RECENT_ACTIVITY } from './fixtures'
import styles from './motion.module.css'

/**
 * The hero's product frame (mockup `index.html:37-77`): agent budgets and
 * recent activity. Decorative — the hero section wraps it in `aria-hidden`
 * and its prose carries the meaning (#3574).
 *
 * The component owns the frame's settled markup and nothing else (#3575):
 * slice 3's `AnimatedHeroFrame` drives the mockup's payment loop by passing
 * `state`; with no state (or under reduced motion) it renders the settled
 * fixture state below, byte-for-byte what slice 2 shipped — the baselines
 * and the page tests pin it.
 */

/** One activity row as the loop sees it. */
export type HeroActivityRow = {
  key: string
  icon: 'up' | 'pending' | 'refused'
  title: string
  detail: string
  badge: 'fortnox' | 'pending' | null
  /** The badge itself is entering (the mockup's `pill.enter`, :111). */
  badgeEntering?: boolean
  amount: string
  when: string
  entering?: boolean
  leaving?: boolean
}

/** What the loop can move: Atlas's live figures and the activity rows. */
export type HeroFrameState = {
  /** Atlas's used amount, preformatted ("214.00"). */
  atlasUsed: string
  /** Atlas's whole-number percent ("86"). */
  atlasPercent: string
  /** Atlas's budget-bar width, as a CSS percentage number. */
  atlasBarPercent: number
  rows: HeroActivityRow[]
  /** True while the loop fades the list out for its reset (:113). */
  fading?: boolean
}

/** The settled activity rows, from the fixtures (mockup `index.html:60-74`). */
const SETTLED_ROWS: HeroActivityRow[] = RECENT_ACTIVITY.map((row, index) => ({
  key: `settled-${index}`,
  icon: 'up',
  title: row.agent,
  detail: row.detail,
  badge: 'fortnox',
  amount: row.amount,
  when: row.when,
}))

export function HeroAgentsFrame({ state }: { state?: HeroFrameState } = {}) {
  const atlas = AGENT_BUDGETS[0]
  const iris = AGENT_BUDGETS[1]
  const rows = state?.rows ?? SETTLED_ROWS
  const fading = state?.fading ?? false

  return (
    <ProductFrame env="Operations" screen="Agents">
      <div>
        {/*
          Each budget row stacks the name over a full-width budget block, as
          the mockup does (`site.css:99`, `.budget{grid-column:1/-1}`), so the
          two bars share their left edge and width by construction (#3630).
          The earlier side-by-side grid sized each row's bar column to that
          row's own content, so the bars started and ended at different x.
        */}
        {/* Atlas's budget row — the one the loop moves (mockup `index.html:40-48`). */}
        <div className="border-t border-[var(--v2-border)] py-3 first:border-t-0 first:pt-0">
          <div className="whitespace-nowrap text-[14px] font-semibold text-[var(--v2-ink)]">
            <span aria-hidden className="mr-[7px] inline-block h-2 w-2 rounded-full bg-[var(--v2-success)] align-[1px]" />
            {atlas.name}
            <span className="ml-1.5 font-normal text-[var(--v2-ink-3)]">{atlas.role}</span>
          </div>
          <div className="mt-2">
            <div className="mb-1.5 flex items-center justify-between gap-4 text-[12.5px]">
              <b className={`font-semibold text-[var(--v2-ink)] ${SITE_TYPE.mono}`} data-testid="hero-used">
                {state?.atlasUsed ?? atlas.used} of {atlas.total} USDC
              </b>
              <span className={`text-[var(--v2-ink-3)] ${SITE_TYPE.mono}`} data-testid="hero-percent">
                {state?.atlasPercent ?? atlas.percent}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--v2-surface)]">
              <div
                className="h-full rounded-full bg-[var(--v2-brand)]"
                style={{ width: `${state?.atlasBarPercent ?? atlas.percent}%` }}
                data-testid="hero-bar"
              />
            </div>
            <div className="mt-1.5 text-[12px] text-[var(--v2-ink-3)]">{atlas.meta}</div>
          </div>
        </div>

        {/* Iris's budget row — static, as in the mockup (index.html:49-57). */}
        <div className="border-t border-[var(--v2-border)] py-3">
          <div className="whitespace-nowrap text-[14px] font-semibold text-[var(--v2-ink)]">
            <span aria-hidden className="mr-[7px] inline-block h-2 w-2 rounded-full bg-[var(--v2-success)] align-[1px]" />
            {iris.name}
            <span className="ml-1.5 font-normal text-[var(--v2-ink-3)]">{iris.role}</span>
          </div>
          <div className="mt-2">
            <div className="mb-1.5 flex items-center justify-between gap-4 text-[12.5px]">
              <b className={`font-semibold text-[var(--v2-ink)] ${SITE_TYPE.mono}`}>
                {iris.used} of {iris.total} USDC
              </b>
              <span className={`text-[var(--v2-ink-3)] ${SITE_TYPE.mono}`}>{iris.percent}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--v2-surface)]">
              <div className="h-full rounded-full bg-[var(--v2-brand)]" style={{ width: `${iris.percent}%` }} />
            </div>
            <div className="mt-1.5 text-[12px] text-[var(--v2-ink-3)]">{iris.meta}</div>
          </div>
        </div>

        <div className="mb-2.5 mt-4 text-[13px] font-semibold text-[var(--v2-ink)]">Recent activity</div>
        <div
          data-testid="hero-activity"
          className="relative"
          style={fading ? { opacity: 0, transition: 'opacity 0.5s' } : undefined}
        >
          {rows.map((row) => (
            <div
              key={row.key}
              className={`grid grid-cols-[28px_1fr_auto] items-center gap-3 border-t border-[var(--v2-border)] py-3 text-[13px] ${
                row.entering ? styles.enter : ''
              } ${row.leaving ? `absolute inset-x-0 ${styles.leave}` : ''}`}
            >
              <div
                aria-hidden
                className={`grid h-7 w-7 place-items-center rounded-lg text-[13px] font-semibold ${
                  row.icon === 'refused'
                    ? styles.icoNo
                    : row.icon === 'pending'
                      ? styles.icoPend
                      : styles.icoOut
                }`}
              >
                {row.icon === 'refused' ? '✕' : row.icon === 'pending' ? '···' : '↑'}
              </div>
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold leading-tight text-[var(--v2-ink)]">{row.title}</div>
                <div className="mt-0.5 text-[12px] text-[var(--v2-ink-3)]">
                  {row.detail}
                  {row.badge !== null && ' · '}
                  {row.badge === 'fortnox' && (
                    <span
                      className={`inline-flex h-[18px] items-center rounded-full bg-[var(--v2-success-soft)] px-2 text-[11px] font-medium text-[var(--v2-success)] ${
                        row.badgeEntering ? styles.pillEnter : ''
                      }`}
                    >
                      In Fortnox
                    </span>
                  )}
                  {row.badge === 'pending' && (
                    <span
                      className={`inline-flex h-[18px] items-center rounded-full px-2 text-[11px] font-medium ${styles.pillPending}`}
                    >
                      Pending
                    </span>
                  )}
                </div>
              </div>
              <div className={`text-right font-semibold text-[var(--v2-ink)] ${SITE_TYPE.mono}`}>
                {row.amount}
                <small className="block font-normal text-[11.5px] not-italic text-[var(--v2-ink-3)]">
                  {row.when}
                </small>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ProductFrame>
  )
}
