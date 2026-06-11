import { CONNECTOR_VERSION, type ConnectOptions } from './runtime.js'

export interface ParsedCli {
  options: ConnectOptions
  help: boolean
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCli {
  const options: Partial<ConnectOptions> = {
    apiBaseUrl: env.HAVEN_API_URL ?? 'http://localhost:3001',
    connectorVersion: CONNECTOR_VERSION,
  }
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--setup' || arg === '--setup-token') {
      options.setupToken = requireValue(argv, ++i, arg)
    } else if (arg === '--api' || arg === '--api-url') {
      options.apiBaseUrl = requireValue(argv, ++i, arg)
    } else if (arg === '--runtime') {
      options.runtime = requireValue(argv, ++i, arg)
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

  if (help) {
    return { options: options as ConnectOptions, help }
  }

  if (!options.setupToken) {
    throw new Error('Missing --setup <hv_setup_...> setup token.')
  }
  if (!options.apiBaseUrl) {
    throw new Error('Missing --api <Haven API URL>.')
  }

  options.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')
  return { options: options as ConnectOptions, help }
}

export function helpText(): string {
  return [
    'Haven Connect Agent 2 local connector',
    '',
    'Generates the agent signing key locally, stores it on this machine, and',
    'sends Haven only the public signing address plus a proof signature.',
    '',
    'Usage:',
    '  npx -y @haven_ai/connect --setup hv_setup_... --api https://api.haven.example --ack-local-tools --runtime claude-code',
    '',
    'Options:',
    '  --setup <token>            Short-lived setup token from Haven.',
    '  --api <url>                Haven backend API URL. Defaults to HAVEN_API_URL or http://localhost:3001.',
    '  --runtime <name>           Agent runtime hint, such as claude-code, codex-cli, codex-desktop, cursor, vscode, or claude-desktop.',
    '  --credentials-dir <path>   Credential directory fallback. Defaults to ~/.haven/agents.',
    '  --environment-label <text> Non-sensitive label shown in Haven setup review.',
    '  --ack-local-tools          Write the one-time local Haven tools acknowledgement during setup.',
    '  --ack-signer               Backward-compatible alias for --ack-local-tools.',
    '  --local                    Advanced: install the fully-local Haven MCP (no hosted dependency).',
    '                             Only available for Claude Code and Codex. Default is hosted MCP + local signer.',
    '  --help                     Show this help.',
    '',
    'The connector never prints the private key and never sends it to Haven.',
  ].join('\n')
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}.`)
  }
  return value
}
