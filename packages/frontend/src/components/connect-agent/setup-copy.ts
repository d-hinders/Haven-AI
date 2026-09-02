import type { AgentConnectionSetupStatusResponse } from '@/hooks/useAgentConnectionSetupStatus'
import { runtimeIsConfigured } from '@/hooks/useAgentConnectionSetup'

/** Presentation copy helpers for the connect-agent flow. */

export function formatAbsoluteDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function restartCopyForRuntime(runtime: string): string | null {
  // Mirrors the connector runtime registry's restartMode semantics:
  // hot-reload runtimes need no restart; desktop apps load MCP at launch.
  switch (runtime) {
    case 'cursor':
    case 'vscode':
    case 'vscode-insiders':
      return null
    case 'claude-desktop':
      return 'Restart Claude Desktop now — it only loads Haven tools at app launch.'
    case 'codex-desktop':
      return 'Restart Codex Desktop now — it only loads Haven tools at app launch.'
    case 'claude-code':
      return "Haven tools appear in your next Claude Code message. If they don't, restart the session."
    // #1682: `codex` and `cowork` are picker row ids. They normally lose to
    // the id the connector reports, but this copy also renders on the rare
    // path where no connector report arrived.
    case 'codex-cli':
    case 'codex':
      return "Haven tools appear in your next Codex message. If they don't, restart the session."
    case 'cowork':
      return "Haven tools appear in your next Cowork message. If they don't, restart the session."
    case 'openclaw':
      return 'Restart the OpenClaw gateway so it loads Haven tools.'
    case 'hermes':
      return 'Restart Hermes in a new session. Gateway users should run /restart. If Haven tools do not appear, install the MCP SDK in Hermes: pip install mcp.'
    default:
      return 'Restart the agent session so it loads Haven tools.'
  }
}

export function runtimeStatusLabel(install: AgentConnectionSetupStatusResponse['install_status']): string {
  if (!install) return 'Checking runtime setup'
  if (install.error_code) return 'Needs attention'
  if (install.restart_required && runtimeIsConfigured(install)) return 'Restart ready'
  if (runtimeIsConfigured(install)) return 'Configured'
  if (install.credential_files_written) return 'Credentials stored locally'
  return 'Manual setup needed'
}

export function runtimeStatusHelper(
  install: AgentConnectionSetupStatusResponse['install_status'],
  /**
   * The connector package spec the BACKEND handed out, from
   * `AgentConnectionSetupStatus.connector_package` (#2422).
   *
   * Passed in rather than restated: the dist-tag is deployment configuration
   * (`HAVEN_CONNECTOR_CHANNEL`), so the hard-coded `@haven_ai/connect@alpha`
   * that used to live in the template below told a developer on the DEV
   * dashboard to repair their setup with the PRODUCTION connector — the same
   * defect on the client that #2422 fixes on the server.
   *
   * Optional only to survive a rolling deploy against a backend that predates
   * the field. When it is missing the sentence names the connector's flags
   * without inventing a package spec, because a guessed channel is worse than
   * an unspelled command: the user would run the wrong one and it would look
   * like it worked.
   */
  connectorPackage?: string,
): string {
  if (!install) return 'Haven is waiting for the connector to report setup status.'
  if (install.error_code === 'local_mcp_ack_required') return 'Haven tools need one-time acknowledgement before this agent can load them.'
  if (install.error_code === 'local_signer_ack_required') return 'Local signing needs one-time acknowledgement before this agent can load Haven tools.'
  if (install.error_code === 'local_mcp_unsupported_node_version') return 'Update Node.js to version 22 or newer, then run the setup command again.'
  if (install.error_code === 'local_mcp_runtime_install_failed') return 'The connector could not install Haven tools locally. Run the setup command again; it uses Haven-owned local storage.'
  if (install.error_code === 'codex_config_invalid') return 'Codex config needs a manual fix before Haven tools can be added.'
  // #1719: an unparseable config is not a retryable write failure — running
  // setup again fails identically until the file itself is fixed. It also
  // cannot be retried with THIS command: the failure happens after the agent
  // is registered, so the setup token is already used and a fresh connection
  // would mint a second agent (#1688). The connector's own --repair rewrites
  // the config from the credentials it already stored. Its sibling
  // runtime_config_write_failed IS retryable and keeps the retry wording.
  //
  // The command is spelled out WITH --runtime because the connector's parser
  // requires it for --doctor/--repair and has no detection fallback on that
  // path (packages/connect/src/args.ts) — advice that reproduces the failure
  // with a second, less legible error is worse than no advice. `runtime` is
  // optional on the wire, so the placeholder keeps the shape correct when the
  // connector never reported one.
  if (install.error_code === 'runtime_config_unreadable') {
    const repairArgs = `--doctor --repair --runtime ${install.runtime ?? '<your agent client>'}`
    const lead =
      'The agent client config on that machine could not be read, so Haven left it untouched. Fix the file the connector named, then '
    // The spec the server handed out: spell the whole command.
    if (connectorPackage) {
      return `${lead}run \`npx ${connectorPackage} ${repairArgs}\` there — not the setup command, which this agent no longer needs.`
    }
    // #2422 design review: rolling-deploy skew. Bare FLAGS are not an
    // instruction — the user has nothing to attach them to — and inventing a
    // channel is worse still, because a plausible-but-wrong connector runs and
    // LOOKS like it worked. The third option delegates to the one invocation
    // that is guaranteed correct for their machine: the one they already ran.
    return `${lead}re-run the same \`npx\` connector command you used for setup, with \`${repairArgs}\` in place of its \`--setup\` flag — not the setup command unchanged, which this agent no longer needs.`
  }
  if (install.error_code === 'runtime_config_write_failed') return 'Haven could not update the agent client config on that machine. Check the connector output, then run the setup command again.'
  if (install.error_code === 'claude_code_config_failed') return 'Claude Code did not accept the Haven tools entry. Run the setup command inside Claude Code again.'
  if (install.error_code?.startsWith('local_mcp_probe_')) return 'The connector installed Haven tools, but the local check could not load them yet. Run the setup command again.'
  if (install.error_code) return 'The connector stored credentials, but runtime setup needs a manual finish.'
  if (install.restart_required && install.local_mcp_configured && runtimeIsConfigured(install)) return 'After approval, restart the agent normally so it can load Haven tools.'
  if (install.restart_required && install.activation_command_available) return 'The connector prepared a restart command. Use it after approval so this agent can load Haven tools.'
  if (install.restart_required) return 'Restart the agent session after approval so it can load Haven tools.'
  if (runtimeIsConfigured(install)) return 'The agent environment reported Haven tools are configured.'
  if (install.credential_files_written) return 'The connector wrote local credentials. Add Haven to the runtime before using this agent.'
  return 'Use the command fallback or runtime settings to add Haven manually.'
}
