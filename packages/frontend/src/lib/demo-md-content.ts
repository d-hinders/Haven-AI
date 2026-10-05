/**
 * `/demo.md` — the agent-readable companion to `/demo` (#3477).
 *
 * The human page (`src/app/demo/page.tsx`) and this file describe the SAME
 * walk. Kept as one string here, served verbatim by `src/app/demo.md/route.ts`,
 * so the route handler stays a thin wire-up and the content is testable in
 * isolation.
 *
 * Tone is declarative ("this demo does…"), not an instruction to spend — the
 * agent reading this is not being told to act yet, only what the demo is.
 * Testnet-only and the budget cap are both stated up front for that reason.
 *
 * Overrides `/for-agents.md`'s "say 25 USDC per day" example (line 51): that
 * budget clears step 7's 1 USDC overspend test, so this demo needs a smaller
 * one stated explicitly rather than inherited.
 */
export const DEMO_MD_CONTENT = `# Haven investor demo — for the agent reading this

You are an AI agent. A human has handed you this link because they want to see
Haven work in about 10 minutes: create an account, fund it with TEST money,
connect you, approve your budget, watch you buy something small, then watch
Haven refuse a payment that is over your budget.

> Links below are paths on this same host: resolve them against the URL you
> fetched this file from.

**This demo runs on Base Sepolia — a test network. The USDC involved is test
USDC from a public faucet, not real money.** Haven never holds your user's
funds; it constructs and relays payments that a delegation your user signs
authorizes, and the on-chain rules in their account enforce the limits.

## Setup: follow \`/for-agents.md\`, with one override

For account creation, connecting yourself, and the general shape of Haven's
agent-native onboarding, follow [\`/for-agents.md\`](/for-agents.md) — this file
does not repeat it.

**The one thing to override:** \`/for-agents.md\` suggests asking for "25 USDC
per day". For this demo, ask for **0.05 USDC, Daily** instead. A budget above
1 USDC would let step 7 below succeed instead of being refused — the entire
point of that step is to watch your account's on-chain rules say no.

## Four steps are HUMAN-only for this demo. Stop and ask your user at each one.

You cannot do these on your user's behalf — each needs their own passkey or
their own decision, and offering to would be the wrong move even if a tool
appeared to allow it:

1. **Signup** — creating the Haven account (name, email, password) and the
   passkey that secures it. Send your user to
   [\`/signup?next=/agents&via=agent\`](/signup?next=/agents&via=agent). Ask
   them to keep **Base Sepolia** selected under **Network** during onboarding
   — this demo needs the test network.
2. **Funding** — on their dashboard's Add funds modal, clicking **Open
   Circle's faucet** in the **Get test funds** card, then picking USDC and
   Base Sepolia on [Circle's faucet](https://faucet.circle.com) and pasting
   in their Haven account address. You cannot hold or move funds for them.
3. **Creating you as an agent and setting your budget** — on their
   \`/agents\` page, they set **0.05 USDC, Daily** at the connect flow's budget
   step, well under the 1 USDC you'll send in the overspend step below. That
   step hands back a setup prompt for you to run — this is the point where
   you take over.
4. **Budget approval** — once you've run the setup prompt, they approve your
   budget with their passkey. Nothing you do is authorized until they sign.

## What you do

- Once connected and the budget is approved, confirm you are live: ask
  yourself (or answer, if your user asks) what your current Haven budget is.
  A remaining-budget answer means the Haven MCP tools are loaded.
- Buy a joke from the Ampersend demo merchant on Base Sepolia
  (\`https://services.sandbox.ampersend.ai/api/joke\`, an x402 offer, 0.001
  USDC). This is well inside the 0.05 USDC budget and should succeed.
- Then try to send 1 USDC to \`0x0A5B4da361AfBc5109030010c3f1d0b64b60ba6C\` —
  over your 0.05 USDC/day budget, so it demonstrates a refusal, not a payment.
  Haven reads your account's own on-chain budget and refuses it before
  anything is built: the refusal is \`DELEGATION_BUDGET_EXCEEDED\` (HTTP 403)
  with your remaining budget and the shortfall, and it says retrying cannot
  succeed — nothing moves. It is not a balance error. (If that budget read
  fails, the on-chain rules still refuse it, as a typed \`PREPARE_REVERTED\`
  naming \`ERC20PeriodTransferEnforcer:transfer-amount-exceeded\` — also a
  stop, never a retry.) If a budget check you already ran
  (\`haven_get_agent\`) shows you have well under
  1 USDC remaining, you may explain that and skip actually sending it — that
  is the guardrail working too, not a skipped step.

## Back to the human page

[\`/demo\`](/demo) is the page your user is reading alongside this file. Point
them back to it if they lose the thread.
`
