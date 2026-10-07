import { Fragment } from 'react'
import { SITE_TYPE } from '../SiteSection'
import { DEV_TERMINAL, type DevTone } from './fixtures'
import styles from './motion.module.css'

/**
 * The developers band's terminal, settled state (mockup V19, artifact
 * version `1791288451-c24e`, `index.html:212-227`).
 *
 * Like the step 3 terminal this block is real page content, not a
 * decorative frame: it is the transcript of a live 402 session, so it stays
 * in the accessibility tree. The lines never leave the DOM — the reveal is
 * opacity-only (#3684) — so what assistive technology reads is the complete
 * transcript at every moment, and nothing announces.
 *
 * The lines stay inline-level and pre-wrapped exactly as the band has
 * always rendered them; the two blank lines are margins (`mt-[1.7em]`, as
 * `ConnectorTerminal.tsx` keeps its tail comment's gap), so the settled
 * pixels are the band's. `AnimatedDevTerminal` drives the line-by-line
 * reveal by passing `state`; with no state every line renders settled —
 * exactly what slice 2 shipped. The reveal uses a sibling pair whose
 * transition sits on both states (`motion.module.css` `dline`/`dlineOn`),
 * so a line fades in as it appears and fades out at the cycle reset instead
 * of popping.
 */

export type DevRevealState = {
  /** True while the loop runs (drives the gated transition classes). */
  looping: boolean
  /** How many of the thirteen steps have fired so far (0-13). */
  printed: number
}

const TONE: Record<DevTone, string> = {
  comment: 'text-[rgba(230,233,255,0.5)]',
  tool: 'text-[#a5b4fc]',
  warning: 'text-[#fcd34d]',
  success: 'text-[#86efac]',
}

export function DevTerminal({ state }: { state?: DevRevealState } = {}) {
  // The fired-step count: step s's lines are on once `printed > s`, and the
  // one cursor sits on the last line of step `printed - 1` for
  // 1 ≤ printed ≤ 12 — the thirteenth step (at 9400 ms) removes it.
  const printed = state?.looping ? state.printed : undefined
  const lastStep = DEV_TERMINAL.steps.length - 1
  return (
    <div
      data-dev-terminal=""
      className={`min-w-0 rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] text-[13px] leading-[1.7] text-[#e6e9ff] ${SITE_TYPE.mono}`}
      style={{ padding: '18px 20px' }}
    >
      <pre className="whitespace-pre-wrap break-words">
        {DEV_TERMINAL.steps.map((step, s) => {
          const on = printed === undefined || printed > s
          const cursorHere = printed !== undefined && printed >= 1 && printed <= 12 && s === printed - 1
          return (
            <Fragment key={s}>
              {step.lines.map((line, i) => {
                const isStepLast = i === step.lines.length - 1
                const isTranscriptLast = s === lastStep && isStepLast
                return (
                  <Fragment key={line}>
                    <span
                      data-dev-line=""
                      className={[step.tone ? TONE[step.tone] : '', on ? styles.dlineOn : styles.dline]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {line}
                      {isStepLast && cursorHere && <span data-dev-cursor="" className={styles.dcursor} />}
                    </span>
                    {isTranscriptLast ? null : '\n'}
                  </Fragment>
                )
              })}
              {step.blankAfter && <span className="block mt-[1.7em]" />}
            </Fragment>
          )
        })}
      </pre>
    </div>
  )
}
