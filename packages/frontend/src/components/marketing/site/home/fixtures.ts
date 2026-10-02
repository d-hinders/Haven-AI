/**
 * Fixture data for the home page's product frames (#3574, epic #3572).
 *
 * Every figure is fixture data taken from the app's own test screens, exactly
 * as the mockup's notes state: agents Atlas and Iris, a 250 USDC monthly
 * budget, Ada Lovelace AB, Fortnox invoices 1041/1042. Nothing here is
 * presented as a customer's numbers, and the frames that render them are
 * decorative (their call sites wrap them in `aria-hidden`).
 */

/** The hero frame's two agent budget rows (mockup `index.html:40-57`). */
export const AGENT_BUDGETS = [
  {
    name: 'Atlas',
    role: 'Research agent',
    used: '201.50',
    total: '250.00',
    percent: 81,
    meta: 'Monthly budget · resets 11 Jul · any recipient',
  },
  {
    name: 'Iris',
    role: 'Data-feed agent',
    used: '5.00',
    total: '500.00',
    percent: 1,
    meta: 'Monthly budget · resets 11 Jul · pinned to Klara Data AB',
  },
] as const

/** The hero frame's recent-activity rows (mockup `index.html:60-74`). */
export const RECENT_ACTIVITY = [
  {
    agent: 'Atlas',
    detail: 'Paid data.example over x402',
    status: 'In Fortnox',
    amount: '−6.20 USDC',
    when: '1 h ago',
  },
  {
    agent: 'Iris',
    detail: 'Paid Klara Data AB over x402',
    status: 'In Fortnox',
    amount: '−5.00 USDC',
    when: '1 d ago',
  },
  {
    agent: 'Atlas',
    detail: 'Paid api.example over x402',
    status: 'In Fortnox',
    amount: '−8.25 USDC',
    when: '2 d ago',
  },
] as const

/** The accounting frame's feed rows (mockup `index.html:203-206`). */
export const ACCOUNTING_FEED = [
  {
    id: 'pay_01…3Y5A',
    detail: 'Fortnox invoice 1042 · payment evidence and merchant receipt attached',
    status: 'Synced',
    ok: true,
  },
  {
    id: 'pay_01…E0G2',
    detail: 'Fortnox answered 503 · will retry',
    status: 'Failed',
    ok: false,
  },
  {
    id: 'pay_01…9K1D',
    detail: 'Fortnox invoice 1041 · payment evidence attached',
    status: 'Synced',
    ok: true,
  },
] as const

/**
 * Step 3's connector command, in the working form the product publishes.
 *
 * The mockup's bare `npx @haven_ai/connect` throws before anything runs —
 * `packages/connect/src/args.ts:255` throws "Missing --setup" when no token is
 * given — so the page shows the command WITH its required flags, the shape
 * the setup prompt hands the agent (`agent-guidance.ts:235`:
 * `npx -y @haven_ai/connect@<channel> --setup … --api <url> --ack-local-tools`),
 * with the published dist-tag `@alpha` (agent-discovery-listings.md:137,
 * "everywhere, verbatim"). The token is the runbook's never-real placeholder.
 *
 * The output lines below are the connector's real stdout on the happy path,
 * transcribed from `packages/connect/src/runtime.ts` in print order:
 * `Minting…` (:636), `Configured hosted Haven MCP identity.` / `Configured
 * local Haven signer.` (printRuntimeInstall, :1407/:1412), the
 * `→ Action needed:` budget CTA in its no-approval-url fallback form
 * (approveBudgetCta, :1333), and `Haven setup on this machine is complete.`
 * (:819). Nothing here is invented.
 */
export const CONNECTOR_TERMINAL = {
  comment: '# in the agent\'s terminal — the command your Haven setup prompt prints',
  command: 'npx -y @haven_ai/connect@alpha --setup hv_setup_… --api https://api.haven.example --ack-local-tools',
  output: [
    'Minting a fresh signing key and API key — both stay on this machine.',
    'Configured hosted Haven MCP identity.',
    'Configured local Haven signer.',
    '→ Action needed: approve this agent\'s budget in the Haven dashboard — the approval button is live now. Setup continues here in the meantime.',
    'Haven setup on this machine is complete.',
  ],
  tailComment: '# or paste the setup prompt from\n# your dashboard into your agent',
} as const
