import { buildManifestFrom } from '@/lib/capability-manifest'

/**
 * Fixture data and manifest-derived values for the For developers page
 * (#3577, epic #3572), built from `docs/product/site-mockup/developers.html`.
 *
 * Package NAMES come from the capability manifest's static half —
 * `buildManifestFrom(origin, null)` needs no fetch and makes no page dynamic
 * (the issue's acceptance criterion: the fetching builder is off-limits here,
 * because it would make the visual baseline move with every release). Each
 */

/** The table's order, the mockup's: connector first, SDK beside it. */
export const PACKAGE_ORDER = ['connect', 'sdk', 'mcp', 'signer', 'cli'] as const

/** The five published packages, by name, from the manifest's static half. */
export function packageNames(): string[] {
  const manifest = buildManifestFrom('', null)
  return PACKAGE_ORDER.map((key) => manifest.packages[key]?.name).filter(
    (name): name is string => name !== undefined,
  )
}

/** Per-package copy (mockup `developers.html` § Packages). */
export const PACKAGE_DESCRIPTIONS: Record<(typeof PACKAGE_ORDER)[number], { what: string; when: string }> = {
  connect: {
    what: 'One-command local connector. Installs the MCP runtime, generates the signing key locally.',
    when: 'Connecting any agent. Start here.',
  },
  sdk: {
    what: 'TypeScript SDK: payments, x402 quote, pay and resume, allowances, receipts.',
    when: 'You are integrating Haven into your own code.',
  },
  mcp: {
    what: 'Local MCP server for credential-file integrations.',
    when: 'Your runtime cannot reach the hosted MCP.',
  },
  signer: {
    what: 'Local edge signer. The delegate key never leaves the machine.',
    when: 'Installed by connect; run standalone if you split hosts.',
  },
  cli: {
    what: 'Terminal-native management: login, agents, budgets, funding.',
    when: 'Scripting setup, or letting an agent manage the account.',
  },
}

/**
 * The quickstart terminal (mockup `developers.html:48-58`), in the working
 * forms the runbook publishes. The connector command carries `--api` because
 * the connector refuses to run without it (`packages/connect/src/args.ts`:
 * "Missing --api <Haven API URL>") — the bare mockup form exits with an
 * argument error before anything runs, exactly as #3574 corrected the home
 * page's terminal. Owner-only files and the readiness probe follow the
 * runbook's vocabulary section.
 */
export const QUICKSTART_TERMINAL = {
  comment: '# from the setup prompt your dashboard hands you',
  command: 'npx -y @haven_ai/connect@<channel> --setup hv_setup_… --api <api-url> --ack-local-tools',
  files: [
    ['~/.haven/agents/<agent-id>/identity.json', 'API key: identifies, cannot spend'],
    ['~/.haven/agents/<agent-id>/signer.json', 'signing key: never leaves the machine'],
  ] as const,
  tailComment: '# verify from your agent',
  probe: 'haven_get_agent → spend_authority_readiness: ready',
} as const

/**
 * The 402 walk-through (mockup `developers.html:107-113`). Every tool name is
 * a real hosted/signed tool: `haven_quote_x402` and `haven_pay_x402` in
 * `packages/mcp-server/src/tools/plain-http-x402.ts`, `haven_sign_x402` the
 * local signer's x402 tool (`packages/sdk/src/types.ts:2871`).
 */
export const X402_TERMINAL = {
  head: 'GET https://api.example/v1/enrich',
  status: '← 402 Payment Required · 0.30 USDC',
  calls: [
    ['haven_quote_x402', '→ within budget · 214.00 used of 250.00'],
    ['haven_sign_x402', '→ signed on the agent’s machine'],
    ['haven_pay_x402', '→ settled on Base · receipt issued'],
  ] as const,
  tail: '← 200 OK',
} as const

/**
 * The CLI block (mockup `developers.html:126-131`), corrected to the command
 * forms the runbook and the manifest actually serve:
 *
 * - `login` is shown as the runbook's template —
 *   `<packages.cli.one_liner> login --api <api-url>` — because the manifest's
 *   `packages.cli.channel` holds the FULL package spec (`@haven_ai/cli@dev`),
 *   so a tag appended to the bare name doubles it (`@@`, the #3430 defect).
 *   The template composes with `packages.cli.one_liner` into a runnable
 *   command, the runbook's own static form. `--api` is load-bearing: the
 *   CLI's built-in default is Haven's hosted production backend, and the
 *   saved session only remembers the backend after the first command.
 * - The three management commands are the mockup's own — each is a real CLI
 *   verb in its published flag form (`haven agents connect`, `haven budget
 *   grant --wait`, `haven wallets funding`).
 */
export const CLI_TERMINAL = {
  comment: '# the CLI never signs: it prints a link, the owner signs with a passkey',
  commands: [
    '<packages.cli.one_liner> login --api <api-url>',
    'haven agents connect --name research --budget 250 --token USDC --period 43200',
    'haven budget grant <agentId> --amount 500 --token USDC --period 43200 --wait',
    'haven wallets funding',
  ],
} as const

/**
 * The architecture row (mockup `developers.html:83-89`): three parts, no
 * single one of them can spend.
 */
export const ARCHITECTURE = [
  {
    tag: 'agent runtime',
    title: 'Local signer',
    body: 'Any harness. Holds the key and signs exactly what Haven prepared.',
  },
  {
    tag: 'hosted MCP',
    title: 'Haven tools',
    body: 'Quote, prepare and relay. Never holds funds or a key.',
  },
  {
    tag: 'on-chain',
    title: 'The owner’s account',
    body: 'The budget is a signed delegation. Over budget reverts at execution.',
  },
] as const

/** The machine-readable files section (mockup `developers.html:115-124`). */
export const REFERENCE_FILES = [
  {
    href: '/api/openapi.json',
    label: '/api/openapi.json',
    body: 'The full API, OpenAPI 3. Generated types ship in the SDK.',
    static: true,
  },
  {
    href: '/.well-known/haven.json',
    label: '/.well-known/haven.json',
    body: 'Capability manifest: where to sign up, which steps are human-only, chains served, connector channel.',
    static: true,
  },
  {
    href: '/llms.txt',
    label: '/llms.txt',
    body: 'The agent-facing entry point. Start here if you are an agent.',
    static: true,
  },
  {
    href: '/exit',
    label: '/exit',
    body: 'Independent exit tool: inspect and revoke every budget with only a wallet and a public RPC.',
    static: true,
  },
  {
    href: '/docs/security-model.md',
    label: '/docs/security-model.md',
    body: 'What the on-chain envelope enforces, and what it does not.',
    static: true,
  },
  {
    href: '/docs/agent-key-rotation.md',
    label: '/docs/agent-key-rotation.md',
    body: 'Re-key a lost or exposed delegate key without re-onboarding.',
    static: true,
  },
] as const
