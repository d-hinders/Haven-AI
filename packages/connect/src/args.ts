import { CONNECTOR_VERSION, type ConnectOptions } from './runtime.js'

export interface ParsedCli {
  options: ConnectOptions
  help: boolean
  json: boolean
  /** #1589: diagnosis mode — no setup token required. */
  doctor: boolean
  repair: boolean
  /** #1681: retire an agent credential directory in place — no token required. */
  tombstone?: { directory: string; reason?: string; replacedBy?: string }
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCli {
  const options: Partial<ConnectOptions> = {
    apiBaseUrl: env.HAVEN_API_URL ?? 'http://localhost:3001',
    connectorVersion: CONNECTOR_VERSION,
  }
  let help = false
  let json = false
  let doctor = false
  let repair = false
  let tombstoneDir: string | undefined
  let tombstoneReason: string | undefined
  let tombstoneReplacedBy: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--doctor') {
      doctor = true
    } else if (arg === '--repair') {
      repair = true
    } else if (arg === '--tombstone') {
      tombstoneDir = requireValue(argv, ++i, arg)
    } else if (arg === '--reason') {
      tombstoneReason = requireValue(argv, ++i, arg)
    } else if (arg === '--replaced-by') {
      tombstoneReplacedBy = requireValue(argv, ++i, arg)
    } else if (arg === '--setup' || arg === '--setup-token') {
      options.setupToken = requireValue(argv, ++i, arg)
    } else if (arg === '--api' || arg === '--api-url') {
      options.apiBaseUrl = requireValue(argv, ++i, arg)
    } else if (arg === '--runtime') {
      options.runtime = requireValue(argv, ++i, arg)
    } else if (arg === '--runtime-force') {
      options.runtimeForce = requireValue(argv, ++i, arg)
    } else if (arg === '--credentials-dir') {
      options.credentialsDir = requireValue(argv, ++i, arg)
    } else if (arg === '--environment-label') {
      options.environmentLabel = requireValue(argv, ++i, arg)
    } else if (arg === '--ack-local-tools') {
      options.ackLocalTools = true
    } else if (arg === '--ack-signer') {
      options.ackSigner = true
      options.ackLocalTools = true
    } else if (arg === '--local' || arg === '--local-mcp') {
      options.localMcp = true
    } else if (arg === '--version') {
      process.stdout.write(`${CONNECTOR_VERSION}\n`)
      process.exit(0)
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  const tombstone = tombstoneDir
    ? { directory: tombstoneDir, reason: tombstoneReason, replacedBy: tombstoneReplacedBy }
    : undefined

  if (help) {
    return { options: options as ConnectOptions, help, json, doctor, repair, tombstone }
  }

  if (tombstone) {
    // Retirement reuses STORED state, like --doctor — no token, no runtime.
    return { options: options as ConnectOptions, help, json, doctor, repair, tombstone }
  }

  if (doctor || repair) {
    // Diagnosis/repair reuse STORED credentials — a setup token is exactly
    // what they exist to avoid needing.
    if (!options.runtime) {
      throw new Error('--doctor/--repair need --runtime <runtime> (which config to examine).')
    }
    return { options: options as ConnectOptions, help, json, doctor, repair, tombstone }
  }

  if (!options.setupToken) {
    throw new Error('Missing --setup <hv_setup_...> setup token.')
  }
  if (!options.apiBaseUrl) {
    throw new Error('Missing --api <Haven API URL>.')
  }

  options.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')
  return { options: options as ConnectOptions, help, json, doctor, repair, tombstone }
}

export function helpText(): string {
  return [
    'Haven Connect Agent 2 local connector',
    '',
    'Generates the agent signing key locally, stores it on this machine, and',
    'sends Haven only the public signing address plus a proof signature.',
    '',
    'Usage:',
    '  npx -y @haven_ai/connect --setup hv_setup_... --api https://api.haven.example --ack-local-tools',
    '',
    'Options:',
    '  --setup <token>            Short-lived setup token from Haven.',
    '  --api <url>                Haven backend API URL. Defaults to HAVEN_API_URL or http://localhost:3001.',
    '  --runtime <name>           Agent runtime hint, such as claude-code, codex-cli, codex-desktop, cursor, vscode, claude-desktop, or hermes.',
    '                             Usually unnecessary: the connector detects the runtime it runs inside, and a detection',
    '                             that contradicts this hint wins (with a printed notice). Needed only in a plain terminal.',
    '  --runtime-force <name>     Escape hatch: use exactly this runtime, ignoring environment detection.',
    '  --credentials-dir <path>   Credential directory fallback. Defaults to ~/.haven/agents.',
    '  --environment-label <text> Non-sensitive label shown in Haven setup review.',
    '  --ack-local-tools          Write the one-time local Haven tools acknowledgement during setup.',
    '  --ack-signer               Backward-compatible alias for --ack-local-tools.',
    '  --local                    Advanced: install the fully-local Haven MCP (no hosted dependency).',
    '                             Only available for Claude Code and Codex. Default is hosted MCP + local signer.',
    '  --json                     Emit one versioned, secret-free result object on stdout; progress stays on stderr.',
    '  --doctor                   Diagnose an existing setup (read-only, no token): config, credentials,',
    '                             signer runtime, hosted MCP, and a live signer handshake. Exits non-zero on any failure.',
    '  --repair                   Repair, then re-diagnose (implies --doctor): reinstall the pinned signer',
    '                             runtime, rewrite the wrapper and runtime config from stored credentials.',
    '                             Hosted topology only (refuses to touch a --local config). No keys, no token.',
    '  --tombstone <dir>          Retire an agent credential directory in place (no token): replaces its signer',
    '                             wrapper with a diagnostic that names the retirement in MCP stderr logs, and',
    '                             writes TOMBSTONE.json. Touches NO key material and revokes nothing.',
    '  --reason <text>            Reason recorded in the tombstone (with --tombstone).',
    '  --replaced-by <agent-id>   Successor agent recorded in the tombstone (with --tombstone).',
    '  --help                     Show this help.',
    '',
    'The connector never prints the private key and never sends it to Haven. JSON output never includes credential contents or full credential paths.',
  ].join('\n')
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}.`)
  }
  return value
}
