import { SITE_TYPE } from '../SiteSection'
import { CONNECTOR_TERMINAL } from './fixtures'
import styles from './motion.module.css'

/**
 * Step 3's terminal, settled state.
 *
 * The command is the connector command in its published, working form — see
 * `fixtures.ts` for why the mockup's bare one-liner was replaced and where
 * every output line is transcribed from. Unlike the product frames this
 * block is real page content, not a decorative frame: it is the answer to
 * "what would I actually run", so it stays in the accessibility tree.
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

export function ConnectorTerminal({ state }: { state?: TerminalRevealState } = {}) {
  return (
    <div
      data-connector-terminal=""
      className={`flex-1 overflow-x-auto rounded-lg bg-[#0e1230] p-3.5 text-[12.5px] leading-[1.7] text-[#e6e9ff] ${SITE_TYPE.mono}`}
    >
      <pre className="whitespace-pre">
        <span className="text-[rgba(230,233,255,0.5)]">{CONNECTOR_TERMINAL.comment}</span>
        {'\n'}
        <span className="text-[#a5b4fc]">$ </span>
        {CONNECTOR_TERMINAL.command}
        {'\n'}
        {CONNECTOR_TERMINAL.output.map((line, index) => (
          <span
            key={line}
            className={`block ${
              state?.looping && index >= state.printed ? styles.tline : styles.tlineOn
            }`}
          >
            {line}
          </span>
        ))}
        {'\n\n'}
        <span className="text-[rgba(230,233,255,0.5)]">{CONNECTOR_TERMINAL.tailComment}</span>
      </pre>
    </div>
  )
}
