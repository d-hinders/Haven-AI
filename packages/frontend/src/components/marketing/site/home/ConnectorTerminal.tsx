import { SITE_TYPE } from '../SiteSection'
import { CONNECTOR_TERMINAL } from './fixtures'
import styles from './motion.module.css'

/**
 * Step 3's terminal, settled state.
 *
 * A short storytelling script (owner decision, #3644) — see `fixtures.ts`
 * for what it keeps from the real connector command and why it is short.
 * Unlike the product frames this block is real page content, not a
 * decorative frame: it says what setting up an agent looks like, so it
 * stays in the accessibility tree.
 *
 * It never scrolls sideways (#3644): every line is its own block that wraps
 * under a 2ch hanging indent, so a line wrapped at a narrow column stays
 * under its `$`, `✓` or `#` marker. At 1280 no line wraps at all.
 *
 * The component owns the terminal's markup and nothing else (#3575): slice
 * 3's `AnimatedConnectorTerminal` drives the print-in sequence by passing
 * `state`; with no state every line renders settled — exactly what slice 2
 * shipped. The reveal is opacity-only: the lines never leave the DOM, so
 * what assistive technology reads is the complete content at every moment.
 */
export type TerminalRevealState = {
  /** True while the loop runs (drives the gated transition class). */
  looping: boolean
  /** How many output lines have printed so far in the current cycle. */
  printed: number
}

/** One terminal line: its own block, wrapped lines hang under the marker. */
const LINE = 'block pl-[2ch] -indent-[2ch]'

export function ConnectorTerminal({ state }: { state?: TerminalRevealState } = {}) {
  return (
    <div
      data-connector-terminal=""
      className={`flex-1 rounded-lg bg-[#0e1230] p-3.5 text-[12.5px] leading-[1.7] text-[#e6e9ff] ${SITE_TYPE.mono}`}
    >
      <pre className="whitespace-pre-wrap break-words">
        <span className={`${LINE} text-[rgba(230,233,255,0.5)]`}>{CONNECTOR_TERMINAL.comment}</span>
        <span className={LINE}>
          <span className="text-[#a5b4fc]">$ </span>
          <span data-terminal-command="">{CONNECTOR_TERMINAL.command}</span>
        </span>
        {CONNECTOR_TERMINAL.output.map((line, index) => (
          <span
            key={line}
            className={`${LINE} ${state?.looping && index >= state.printed ? styles.tline : styles.tlineOn}`}
          >
            {line}
          </span>
        ))}
        <span className={`${LINE} mt-[1.7em] text-[rgba(230,233,255,0.5)]`}>{CONNECTOR_TERMINAL.tailComment[0]}</span>
        <span className={`${LINE} text-[rgba(230,233,255,0.5)]`}>{CONNECTOR_TERMINAL.tailComment[1]}</span>
      </pre>
    </div>
  )
}
