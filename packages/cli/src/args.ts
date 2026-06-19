export interface ParsedArgs {
  command?: string
  sub?: string
  positionals: string[]
  flags: {
    json: boolean
    help: boolean
    version: boolean
    api?: string
    email?: string
    safe?: string
    agent?: string
    limit?: number
    direction?: 'in' | 'out'
  }
}

const VALUE_FLAGS = new Set(['--api', '--email', '--safe', '--agent', '--limit', '--direction'])

/**
 * `haven <command> [sub] [positionals] [--flags]`. Deliberately small — no
 * dependency, no clever aliasing. Unknown flags throw so typos fail loudly.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: ParsedArgs['flags'] = { json: false, help: false, version: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') flags.json = true
    else if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--version' || arg === '-v') flags.version = true
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      if (arg === '--api') flags.api = value
      else if (arg === '--email') flags.email = value
      else if (arg === '--safe') flags.safe = value
      else if (arg === '--agent') flags.agent = value
      else if (arg === '--limit') {
        const n = Number(value)
        if (!Number.isInteger(n) || n <= 0) throw new Error('--limit must be a positive integer')
        flags.limit = n
      } else if (arg === '--direction') {
        if (value !== 'in' && value !== 'out') throw new Error('--direction must be "in" or "out"')
        flags.direction = value
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      positionals.push(arg)
    }
  }

  const [command, sub, ...rest] = positionals
  return { command, sub, positionals: rest, flags }
}

export function helpText(): string {
  return [
    'haven — terminal-native companion to the Haven dashboard',
    '',
    'Usage: haven <command> [subcommand] [options]',
    '',
    'Auth:',
    '  login [--email <e>]     Sign in (password via prompt or HAVEN_PASSWORD)',
    '  logout                  Clear the saved session',
    '  whoami                  Show the signed-in user',
    '',
    'Read:',
    '  wallets list            List your Haven wallets',
    '  wallets balances [--safe <id|address>]   Token balances for a wallet',
    '  agents list             List your agents',
    '  agents show <id>        Show one agent + its budget',
    '  budget show <agentId>   Show an agent\'s configured budget',
    '  activity list [--safe <id>] [--agent <id>] [--direction in|out] [--limit <n>]',
    '  catalog list            List payable services',
    '',
    'Options:',
    '  --json                  Machine-readable output (for scripting)',
    '  --api <url>             Backend URL (default: HAVEN_API_URL or http://localhost:3001)',
    '  --help, --version',
    '',
    'On-chain actions (deploy, budgets, approvers, send) are signed in the',
    'dashboard — this CLI reads and manages; it never holds your keys.',
  ].join('\n')
}
