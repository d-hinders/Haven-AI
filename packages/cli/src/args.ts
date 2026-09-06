export interface ParsedArgs {
  command?: string
  sub?: string
  positionals: string[]
  flags: {
    json: boolean
    help: boolean
    /** #2526: print the code and exit instead of polling for approval. */
    noWait: boolean
    /** #2527: run the printed connector command as a child process. */
    run: boolean
    /** #2527: poll `agents connect --status` until it settles. */
    wait: boolean
    version: boolean
    yes: boolean
    api?: string
    email?: string
    safe?: string
    agent?: string
    limit?: number
    offset?: number
    direction?: 'in' | 'out'
    format?: string
    from?: string
    to?: string
    company?: string
    /** #2527 */
    name?: string
    budget?: string
    token?: string
    period?: number
    status?: string
    /**
     * #2539: the budget magnitude for `budget grant`, in whole tokens as you
     * would say it (`25` is 25 USDC) — parsed to atomic units with decimals
     * read from the backend, exactly like `agents connect`'s --budget. Named
     * --amount because the issue's command sketch does, and because a grant
     * is not the same decision as a connect.
     */
    amount?: string
    /**
     * #2539: optional recipient pin for `budget grant`. An ADDRESS the budget
     * may pay and nobody else — the caveat enforcer set at build time. Absent
     * means an open budget, exactly like the dashboard form's blank field.
     */
    recipient?: string
    /**
     * #2539: optional expiry (unix seconds) for `budget grant`. Absent lets
     * the backend default (now + 90 days), the same default the dashboard's
     * builds get.
     */
    expires?: number
    /**
     * #2527: deliberately absent — `--recipient` for `agents connect`. The
     * issue sketched one, and neither `POST /agents` nor
     * `POST /agent-connection-setups` has a field to
     * put it in: a recipient pin lives in the delegation's caveat enforcers and
     * is set when the human approves the budget. A flag accepted here would
     * either be silently dropped or invent a wire field, and a budget control
     * that looks applied and is not is worse than one you cannot ask for.
     * (Note: `budget grant` DOES take `--recipient` — the delegation build
     * route has that field; connect does not.)
     */
  }
}

const VALUE_FLAGS = new Set([
  '--api', '--email', '--safe', '--agent', '--limit', '--offset', '--direction',
  '--format', '--from', '--to', '--company',
  '--name', '--budget', '--token', '--period', '--status',
  '--amount', '--recipient', '--expires',
])

/**
 * `haven <command> [sub] [positionals] [--flags]`. Deliberately small — no
 * dependency, no clever aliasing. Unknown flags throw so typos fail loudly.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: ParsedArgs['flags'] = {
    json: false, help: false, version: false, yes: false, noWait: false, run: false, wait: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') flags.json = true
    else if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--version' || arg === '-v') flags.version = true
    else if (arg === '--yes' || arg === '-y') flags.yes = true
    else if (arg === '--no-wait') flags.noWait = true
    else if (arg === '--run') flags.run = true
    else if (arg === '--wait') flags.wait = true
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      if (arg === '--api') flags.api = value
      else if (arg === '--name') flags.name = value
      else if (arg === '--budget') flags.budget = value
      else if (arg === '--token') flags.token = value
      else if (arg === '--status') flags.status = value
      else if (arg === '--period') {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 0) throw new Error('--period must be a whole number of minutes')
        flags.period = n
      }
      else if (arg === '--email') flags.email = value
      else if (arg === '--safe') flags.safe = value
      else if (arg === '--agent') flags.agent = value
      else if (arg === '--limit') {
        const n = Number(value)
        if (!Number.isInteger(n) || n <= 0) throw new Error('--limit must be a positive integer')
        flags.limit = n
      } else if (arg === '--offset') {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 0) throw new Error('--offset must be a non-negative integer')
        flags.offset = n
      } else if (arg === '--direction') {
        if (value !== 'in' && value !== 'out') throw new Error('--direction must be "in" or "out"')
        flags.direction = value
      } else if (arg === '--recipient') {
        flags.recipient = value
      } else if (arg === '--amount') {
        flags.amount = value
      } else if (arg === '--expires') {
        const n = Number(value)
        if (!Number.isInteger(n) || n <= 0) throw new Error('--expires must be a unix timestamp in seconds')
        flags.expires = n
      } else if (arg === '--format') {
        if (value !== 'csv' && value !== 'sie') throw new Error('--format must be "csv" or "sie"')
        flags.format = value
      } else if (arg === '--from') flags.from = value
      else if (arg === '--to') flags.to = value
      else if (arg === '--company') flags.company = value
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
    'haven — set up and run a Haven agent from the terminal. It never signs.',
    '',
    'Usage: haven <command> [subcommand] [options]',
    '',
    'Auth:',
    '  login                   Sign in. Opens a browser device-code approval by default —',
    '                          it prints a code and a link, and never asks for a password',
    '  login --email <e>       Password path instead (prompt, or HAVEN_PASSWORD)',
    '  logout                  Clear the saved session',
    '  whoami                  Show the signed-in user, session expiry and API URL',
    '',
    'For agents:',
    '  guide                   Print the agent onboarding runbook (same text as /for-agents.md)',
    '  agents connect --name <n> --budget <amount> --token USDC --period <minutes>',
    '                          Create a connection setup; prints the connector command and',
    '                          the approval link for your human. --run executes it here.',
    '  agents connect --status <setupId> [--wait]   Read one setup\'s status',
    '',
    'Read:',
    '  wallets list            List your Haven wallets',
    '  wallets balances [--safe <id|address>]   Token balances for a wallet',
    '  wallets funding [--safe <id|address>] [--wait]   The paste-ready funding',
    '                          instruction: what to send, where, on which chain.',
    '                          --wait polls until the account counts as funded.',
    '  agents list             List your agents',
    '  agents show <id>        Show one agent + its budget',
    '  budget show <agentId>   Show an agent\'s configured budget',
    '  activity list [--safe <id|address>] [--agent <id>] [--direction in|out] [--limit <n>] [--offset <n>]',
    '  activity export [filters]   Emit CSV to stdout (--format csv, default)',
    '  activity export --format sie [--from <ISO>] [--to <ISO>] [--company <name>]',
    '                          Bookkeeping-ready SIE 4I (Fortnox/Visma/Bokio)',
    '  catalog list            List payable services',
    '  contacts list           List your address book',
    '',
    'Manage (backend-only — no on-chain signing):',
    '  agents pause <id>             Stop the agent spending; keeps its budget',
    '  agents resume <id>            Let it spend again',
    '  agents revoke <id> --yes      Permanently revoke an agent',
    '  agents rotate-key <id>        Issue a new API key (shown once)',
    '  agents rename <id> <name>',
    '  wallets rename <id> <name>',
    '  contacts add <name> <address>  Save an address under a name',
    '  contacts remove <id>          Forget one',
    '',
    'Budgets (construct-and-hand-off — the CLI never signs, #2539):',
    '  budget grant <agentId> --amount <n> --token USDC --period <minutes>',
    '          [--recipient <address>] [--expires <unix-s>] [--wait]',
    '        Prints a signing link; the human signs in the dashboard.',
    '  budget revoke <agentId> <delegationHash> [--wait]',
    '        Prints a revocation link; the human signs in the dashboard.',
    '',
    'Options:',
    '  --json                  One JSON value on stdout, prose on stderr, on every',
    '                          command including refusals: { ok: false, error: { code, message, hint? } }',
    '  --yes, -y               Skip the confirmation prompt for destructive actions',
    '  --api <url>             Backend URL. Default: HAVEN_API_URL, else Haven\'s hosted',
    '                          production backend — NOT localhost. On any other',
    '                          deployment an omitted flag connects to production.',
    '  --help, --version',
    '',
    'Exit codes: 0 ok · 1 failed · 2 usage · 3 not authenticated · 4 refused · 5 network',
    '',
    'On-chain actions (deploy, budgets, approvers, send) are signed in the',
    'dashboard — this CLI reads and manages; it never holds your keys.',
  ].join('\n')
}
