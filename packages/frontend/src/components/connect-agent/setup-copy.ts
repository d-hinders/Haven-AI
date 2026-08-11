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
    case 'codex-cli':
      return "Haven tools appear in your next Codex message. If they don't, restart the session."
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

export function runtimeStatusHelper(install: AgentConnectionSetupStatusResponse['install_status']): string {
  if (!install) return 'Haven is waiting for the connector to report setup status.'
  if (install.error_code === 'local_mcp_ack_required') return 'Haven tools need one-time acknowledgement before this agent can load them.'
  if (install.error_code === 'local_signer_ack_required') return 'Local signing needs one-time acknowledgement before this agent can load Haven tools.'
  if (install.error_code === 'local_mcp_unsupported_node_version') return 'Update Node.js to version 20 or newer, then run the setup command again.'
  if (install.error_code === 'local_mcp_runtime_install_failed') return 'The connector could not install Haven tools locally. Run the setup command again; it uses Haven-owned local storage.'
  if (install.error_code === 'codex_config_invalid') return 'Codex config needs a manual fix before Haven tools can be added.'
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
