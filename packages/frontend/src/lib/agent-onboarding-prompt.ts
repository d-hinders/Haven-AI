/**
 * The onboarding prompt, as the dashboard renders it (#2535, epic #2519).
 *
 * A COPY, not the source. The canonical string is `AGENT_ONBOARDING_PROMPT` in
 * `packages/sdk/src/agent-guidance.ts`, where it sits beside the sentence
 * constants the backend's setup prompt is built from, so the two cannot tell
 * the same agent two different things. This file exists only because
 * `packages/frontend` has zero `@haven_ai/*` runtime dependencies by design
 * (standalone Vercel deploys) — the same reason `/for-agents.md` is a static
 * file and `agent-skill-bundle.ts` is a copy.
 *
 * `src/lib/__tests__/agent-onboarding-prompt.test.ts` pins these bytes to the
 * SDK constant. Do not edit this string here: change the SDK constant and
 * regenerate, or the pin fails — which is the point (#2334: a copy no
 * instrument compares is a copy that will differ).
 *
 * It is the **onboarding prompt**, never the "setup prompt" — that term is
 * canonical for the connect modal's token-carrying text
 * (`docs/product/copy-guidelines.md` § Agent-facing vocabulary).
 */
export const AGENT_ONBOARDING_PROMPT = `I have a Haven account and I am signed in at {{HAVEN_ORIGIN}}. Please set up Haven so you can pay for things within a budget I approve.

Start by reading {{HAVEN_ORIGIN}}/for-agents.md — it is written for you and explains which steps are mine.

Then:

1. Run \`npx @haven_ai/cli login\`. It prints a link and a code and does not need my password — it must never ask for it. Give me the link straight away and wait for me to approve it in my browser.
2. Once I have approved, run \`haven agents connect --name <a name you choose> --budget <amount> --token USDC --period <minutes>\` with the budget I tell you. If I have not given you one, ask me before running it. Add \`--run\` to complete the connection in the same step.
3. When a --json outcome reports approval.required: true, your first action must be to relay the approval instruction to me in your own reply — if the outcome carries approval.url, give me that link; otherwise tell me to return to Haven and approve this agent's budget — before verifying the connection, restarting anything, or any other step. Never build that link yourself: relay the one the outcome gave you or none at all. Any restart the outcome asks for is a separate instruction to give me afterwards, once the approval is done.
4. Once I have approved the budget, verify with the \`haven_get_agent\` tool: \`ready\` means you can pay, \`needs_approval\` means my approval has not landed yet.

Two things only I can do: approving that budget with my passkey, and funding the account with USDC on Base — no ETH, Haven sponsors the gas. Tell me if either is missing rather than working around it.

Do not print private keys, API keys, credential file contents, or config secrets in chat or logs.`

/** The placeholder the SDK constant carries so one committed string is truthful on every host. */
export const HAVEN_ORIGIN_PLACEHOLDER = '{{HAVEN_ORIGIN}}'

/**
 * Render the prompt for the host the user is actually signed in to.
 *
 * Substitution rather than a baked host: dev, preview and production each get a
 * prompt whose links resolve, from one committed string.
 */
export function buildAgentOnboardingPrompt(origin: string): string {
  return AGENT_ONBOARDING_PROMPT.split(HAVEN_ORIGIN_PLACEHOLDER).join(origin)
}
