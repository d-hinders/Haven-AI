import { SITE_TYPE } from '../SiteSection'
import { CONNECTOR_TERMINAL } from './fixtures'

/**
 * Step 3's terminal (mockup `index.html:160-164`), settled state.
 *
 * The command is the connector command in its published, working form — see
 * `fixtures.ts` for why the mockup's bare one-liner was replaced and where
 * every output line is transcribed from. Unlike the product frames this
 * block is real page content, not a decorative frame: it is the answer to
 * "what would I actually run", so it stays in the accessibility tree.
 */
export function ConnectorTerminal() {
  return (
    <div
      data-connector-terminal=""
      className={`overflow-x-auto rounded-lg bg-[#0e1230] p-3.5 text-[12.5px] leading-[1.7] text-[#e6e9ff] ${SITE_TYPE.mono}`}
    >
      <pre className="whitespace-pre">
        <span className="text-[rgba(230,233,255,0.5)]">{CONNECTOR_TERMINAL.comment}</span>
        {'\n'}
        <span className="text-[#a5b4fc]">$ </span>
        {CONNECTOR_TERMINAL.command}
        {'\n'}
        {CONNECTOR_TERMINAL.output.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
        {'\n\n'}
        <span className="text-[rgba(230,233,255,0.5)]">{CONNECTOR_TERMINAL.tailComment}</span>
      </pre>
    </div>
  )
}
