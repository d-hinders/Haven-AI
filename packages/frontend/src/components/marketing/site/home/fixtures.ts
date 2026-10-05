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
 * Step 3's terminal: a short storytelling script, not a transcript (owner
 * decision, 2026-10-05, #3644 — "It doesn't have to use the actual prompt,
 * this is more for story telling and showing how easy it is to set up").
 *
 * It replaced slice 2's full working command and verbatim connector stdout,
 * which could not fit a third of the page and scrolled sideways. What still
 * holds:
 *
 * - The command keeps the published prefix verbatim
 *   (`docs/product/copy-guidelines.md`: `npx -y @haven_ai/connect@<channel>`
 *   "stays verbatim wherever it appears"), with the `@alpha` dist-tag; the
 *   trailing `…` marks the flags left out. The mockup's bare
 *   `npx @haven_ai/connect` stays out: it throws "Missing --setup" before
 *   anything runs (`packages/connect/src/args.ts:256`).
 * - The output lines are illustrative and tell the real order: the key is
 *   made on the agent's machine, the agent connects, the user approves the
 *   budget in Haven. "Key", never "signing key" (copy-guidelines vocabulary).
 * - Every line, comments included, is at most 38 characters, so none wraps
 *   at 1280 (a column holds about 41 at 12.5px mono); narrower, the
 *   terminal wraps rather than scrolls.
 */
export const CONNECTOR_TERMINAL = {
  comment: '# in your agent\'s terminal',
  command: 'npx -y @haven_ai/connect@alpha …',
  output: [
    '✓ Key created on this machine',
    '✓ Agent connected to Haven',
    '→ Approve the budget in Haven',
    '✓ Setup complete',
  ],
  tailComment: ['# or paste the setup prompt from', '# your dashboard into your agent'],
} as const
