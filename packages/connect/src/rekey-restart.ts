/**
 * Restart guidance after a re-key (#1700).
 *
 * ## Why this is not `activationInstruction`
 *
 * The runtime registry already carries an activation line per runtime, and it
 * is right for what it does — a first-time setup, where the user is sitting in
 * front of the one thing they just configured. A re-key is a different
 * situation: the agent was ALREADY running, in however many places it was
 * wired, and every one of those processes is holding the old API key in memory.
 *
 * #1681 finding B is the reason this exists at all: different long-lived
 * processes park on different stale wiring, so restarting the one in front of
 * you is not enough and "restart your session" is not an instruction, it is a
 * shrug. #1694's review then asked for the specific fix — print the COMMAND.
 * "Restart Hermes" cost the reporter time that `systemctl --user restart
 * hermes-gateway` would not have.
 *
 * ## What these commands are, and are not
 *
 * They are the common case, named concretely so the ninety-percent user can
 * copy one. They are NOT a claim to know this machine's process supervision —
 * a gateway under launchd, docker, pm2 or a bare `nohup` is none of these. So
 * every runtime's guidance ends with the sweep instruction rather than
 * implying the listed command is exhaustive, and the sweep is the part that is
 * always true.
 */

export interface RestartGuidance {
  /** Copy-pasteable commands, most likely first. Possibly empty. */
  commands: string[]
  /** Rendered lines, commands included, for the human-readable path. */
  lines: string[]
}

const SWEEP =
  'Then restart EVERY other long-lived MCP host on this machine — gateways, TUI workers, ' +
  'editors. Each holds the wiring snapshot from its own start time, so after a re-key each ' +
  'one is still presenting the OLD API key and will fail with 401 until it restarts.'

const BY_RUNTIME: Record<string, { commands: string[]; how: string }> = {
  'claude-code': {
    commands: ['claude --continue'],
    how: 'Exit this Claude Code session and start a new one:',
  },
  'codex-cli': {
    commands: ['codex resume --last'],
    how: 'Start a fresh Codex CLI session:',
  },
  'codex-desktop': {
    commands: [],
    how: 'Quit Codex Desktop completely (not just the window) and reopen it.',
  },
  'claude-desktop': {
    commands: [],
    how: 'Quit Claude Desktop completely (not just the window) and reopen it.',
  },
  hermes: {
    commands: ['systemctl --user restart hermes-gateway', '/restart'],
    how:
      'Restart the Hermes gateway, or run /restart inside a Hermes session. The first form is ' +
      'the one that matters if you run it as a user service:',
  },
  cursor: {
    commands: [],
    how:
      'Cursor hot-reloads MCP config, so it will pick the new key up on its own. If a tool call ' +
      'still fails with 401, reload the window (Cmd/Ctrl+Shift+P → "Reload Window").',
  },
  vscode: {
    commands: [],
    how:
      'VS Code hot-reloads MCP config. If a tool call still fails with 401, reload the window ' +
      '(Cmd/Ctrl+Shift+P → "Reload Window").',
  },
  'vscode-insiders': {
    commands: [],
    how:
      'VS Code Insiders hot-reloads MCP config. If a tool call still fails with 401, reload the ' +
      'window (Cmd/Ctrl+Shift+P → "Reload Window").',
  },
}

export function restartGuidance(runtime?: string): RestartGuidance {
  const profile = runtime ? BY_RUNTIME[runtime] : undefined
  const lines: string[] = ['The new key is only live in a process that started after now.', '']

  if (profile) {
    lines.push(profile.how)
    for (const command of profile.commands) lines.push(`    ${command}`)
    if (profile.commands.length > 0) lines.push('')
  } else {
    // No --runtime, or one with no known command. Say so rather than printing
    // a command for the wrong host — a confidently wrong restart command is
    // worse than none, because it looks like it worked.
    lines.push(
      runtime
        ? `No standard restart command is known for "${runtime}" — restart it the way you start it.`
        : 'Pass --runtime <name> to get the restart command for a specific host.',
    )
    lines.push('')
  }

  lines.push(SWEEP)
  return { commands: profile?.commands ?? [], lines }
}
