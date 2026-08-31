import { CONNECTOR_VERSION, type ConnectOptions } from './runtime.js'
import { assertValidServerSlug } from './server-names.js'
import { REKEY_FINISH_NEEDS_API_KEY } from './rekey-messages.js'

export interface ParsedCli {
  options: ConnectOptions
  help: boolean
  json: boolean
  /** #1589: diagnosis mode — no setup token required. */
  doctor: boolean
  repair: boolean
  /** #1681: retire an agent credential directory in place — no token required. */
  tombstone?: { directory: string; reason?: string; replacedBy?: string }
  /**
   * #2169: unwire one agent — tombstone it, then remove its MCP pair and
   * Hermes dotenv key from every runtime config. No token required; refuses
   * rather than guess when a bare pair is owned by a different agent.
   */
  unwire?: { reason?: string; replacedBy?: string }
  /** Optional positional value of --unwire <dir> (else --name / --credentials-dir resolve it). */
  unwireDir?: string
  /**
   * #1700: replace an agent's signing key on this machine. Two phases, because
   * the dashboard sits between them — `start` generates the key and prints its
   * address, `finish` writes the key the owner brings back. No setup token: the
   * re-key API is owner-authenticated and this connector never calls it.
   */
  rekey?: { phase: 'start' | 'finish'; newApiKey?: string }
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
  let rekeyPhase: 'start' | 'finish' | undefined
  let newApiKey: string | undefined
  let tombstoneDir: string | undefined
  let tombstoneReason: string | undefined
  let tombstoneReplacedBy: string | undefined
  let unwire: { reason?: string; replacedBy?: string } | undefined
  let unwireDir: string | undefined

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
    } else if (arg === '--rekey') {
      rekeyPhase = 'start'
    } else if (arg === '--rekey-finish') {
      rekeyPhase = 'finish'
    } else if (arg === '--api-key') {
      newApiKey = requireValue(argv, ++i, arg)
    } else if (arg === '--tombstone') {
      tombstoneDir = requireValue(argv, ++i, arg)
    } else if (arg === '--unwire') {
      unwire = unwire ?? {}
      const next = argv[i + 1]
      // Optional positional form --unwire <dir>; a following flag (usually
      // --name or --credentials-dir) means the directory is resolved later.
      if (next !== undefined && !next.startsWith('--')) {
        unwireDir = next
        i += 1
      }
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
    } else if (arg === '--name') {
      // Validated HERE, before any credential or config write can happen —
      // the slug is immutable once wired (#1694 owner decision), so a bad one
      // must die at the argument, not after files exist.
      options.serverName = requireValue(argv, ++i, arg)
      assertValidServerSlug(options.serverName)
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
  const rekey = rekeyPhase ? { phase: rekeyPhase, newApiKey } : undefined

  if (help) {
    return { options: options as ConnectOptions, help, json, doctor, repair, tombstone, rekey }
  }

  if (rekey) {
    // Re-key reuses STORED credentials, like --doctor: the whole point is that
    // the agent already exists here, so a setup token is exactly what it does
    // not need. It refuses the two ways a caller can mean something it cannot
    // do, rather than silently doing the other one.
    if (options.setupToken) {
      throw new Error('--rekey replaces an existing agent\'s key; it does not take --setup. Drop one of them.')
    }
    if (rekey.phase === 'start' && newApiKey !== undefined) {
      throw new Error(
        '--api-key belongs to --rekey-finish. --rekey generates the new key here and prints the ' +
          'address to paste into Haven; the API key does not exist yet.',
      )
    }
    if (rekey.phase === 'finish' && !newApiKey) {
      throw new Error(REKEY_FINISH_NEEDS_API_KEY)
    }
    return { options: options as ConnectOptions, help, json, doctor, repair, tombstone, rekey }
  }

  if (newApiKey !== undefined) {
    // Refuse rather than silently discard — the caller believed it did
    // something (the #1681 finding-2 rule, applied to the new flag).
    throw new Error('--api-key requires --rekey-finish.')
  }

  if (!tombstoneDir && !unwire && (tombstoneReason !== undefined || tombstoneReplacedBy !== undefined)) {
    // Refuse rather than silently discard — the caller believed these did
    // something. (#1681 review, finding 2)
    throw new Error('--reason and --replaced-by require --tombstone <dir> or --unwire.')
  }

  // --reason / --replaced-by ride whichever teardown mode is active.
  if (unwire && (tombstoneReason !== undefined || tombstoneReplacedBy !== undefined)) {
    unwire = {
      ...(tombstoneReason !== undefined ? { reason: tombstoneReason } : {}),
      ...(tombstoneReplacedBy !== undefined ? { replacedBy: tombstoneReplacedBy } : {}),
      ...unwire,
    }
  }

  if (tombstone) {
    if (unwire) {
      throw new Error('--unwire and --tombstone are separate operations; run one per invocation.')
    }
    // Retirement reuses STORED state, like --doctor — no token, no runtime.
    return { options: options as ConnectOptions, help, json, doctor, repair, tombstone, rekey, unwire, unwireDir }
  }

  if (unwire) {
    // Unwire reuses STORED state, like --doctor — no token, no runtime.
    if (options.setupToken) {
      throw new Error('--unwire removes existing wiring; it does not take --setup. Drop --setup.')
    }
    if (!unwireDir && !options.serverName && !options.credentialsDir) {
      throw new Error('--unwire needs a target: --unwire <dir>, --unwire --name <slug>, or --unwire --credentials-dir <path>.')
    }
    return { options: options as ConnectOptions, help, json, doctor, repair, tombstone, rekey, unwire, unwireDir }
  }

  if (doctor || repair) {
    // Diagnosis/repair reuse STORED credentials — a setup token is exactly
    // what they exist to avoid needing.
    if (!options.runtime) {
      throw new Error('--doctor/--repair need --runtime <runtime> (which config to examine).')
    }
    return { options: options as ConnectOptions, help, json, doctor, repair, tombstone, rekey }
  }

  if (!options.setupToken) {
    throw new Error('Missing --setup <hv_setup_...> setup token.')
  }
  if (!options.apiBaseUrl) {
    throw new Error('Missing --api <Haven API URL>.')
  }

  options.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')
  return { options: options as ConnectOptions, help, json, doctor, repair, tombstone, rekey }
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
    '                             that contradicts this hint wins (with a printed notice). When nothing is detected, an',
    '                             interactive terminal is offered the agent clients installed on this machine; this flag is',
    '                             how an agent, or a non-interactive run, answers instead. An unknown name is refused, never guessed.',
    '  --runtime-force <name>     Escape hatch: use exactly this runtime, ignoring environment detection.',
    '  --credentials-dir <path>   Credential directory fallback. Defaults to ~/.haven/agents.',
    '  --environment-label <text> Non-sensitive label shown in Haven setup review.',
    '  --name <slug>              Wiring slug for a NAMED agent: writes haven-<slug> / haven-signer-<slug>',
    '                             MCP entries and stores credentials at ~/.haven/agents/<slug>/, so several',
    '                             agents can run side by side in one runtime. 1-32 lowercase letters, digits,',
    '                             single hyphens; immutable once wired. Omit for the bare haven / haven-signer pair.',
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
    '  --rekey                    Replace this agent\'s signing key (no token). Generates a fresh keypair HERE and',
    '                             prints its public address to paste into the Haven agent page. Nothing changes',
    '                             until you finish; the agent keeps working on its old key throughout.',
    '                             Add --name <slug> for a named agent. Refuses a legacy-rail or revoked agent.',
    '  --rekey-finish             Second half of --rekey: writes the new key and the API key the agent page',
    '                             showed once, in place at the same path, and rewrites only this agent\'s MCP',
    '                             config pair. Server names do not change, so wired hosts need only a restart.',
    '  --api-key <key>            The new API key, for --rekey-finish.',
    '  --tombstone <dir>          Retire an agent credential directory in place (no token): replaces its signer',
    '                             wrapper with a diagnostic that names the retirement in MCP stderr logs, and',
    '                             writes TOMBSTONE.json. Touches NO key material and revokes nothing.',
    '  --unwire [<dir>]           Remove one agent\u2019s wiring from every runtime config it appears in (no token):',
    '                             tombstone-first, then drops the hosted + signer MCP pair from Hermes YAML, Codex',
    '                             TOML and the JSON configs (Cursor, VS Code, Insiders, Claude Desktop), plus the',
    '                             Hermes dotenv API-key line (MCP_HAVEN_API_KEY / MCP_HAVEN_<SLUG>_API_KEY).',
    '                             Target the directory directly, or add --name <slug> or --credentials-dir.',
    '                             An UNNAMED pair is only removed when this directory\u2019s wrapper is the one the',
    '                             config launches (or its key is the one the Hermes env holds); otherwise the',
    '                             command refuses rather than unwire a different agent — it never touches a',
    '                             pair another agent owns. Tears down the target directory: its signer key and',
    '                             API key are removed locally (record kept via the #2155 tombstone mirror) and',
    '                             nothing is ever revoked on the backend — that stays an owner action on the',
    '                             Haven agent page.',
    '  --reason <text>            Reason recorded in the tombstone (with --tombstone or --unwire).',
    '  --replaced-by <agent-id>   Successor agent recorded in the tombstone (with --tombstone or --unwire).',
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
