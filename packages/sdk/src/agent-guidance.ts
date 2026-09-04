/**
 * Agent-facing onboarding guidance — canonical copy (#2523, epic #2519).
 *
 * Two exports, one source:
 *
 * 1. **The shared sentences** — the rules an agent must follow when it runs the
 *    connector. They appear in the backend's `setup_prompt`
 *    (`routes/agent-connection-setups.ts` `buildSetupPrompt`) AND in the runbook
 *    below. Before this file they existed once, inline in the route; the runbook
 *    would have been a second copy, and a second copy of a rule is how the two
 *    drift into contradicting each other in front of an agent that has no way to
 *    tell which is current.
 * 2. **`HAVEN_AGENT_RUNBOOK_MD`** — the runbook served as
 *    `packages/frontend/public/for-agents.md`, written to the agent whose user
 *    has no Haven account yet. `llms-full.txt`'s quickstart addresses the owner;
 *    this addresses the agent, and its job is to say which steps are the human's
 *    and exactly what to say at each hand-off.
 *
 * The frontend keeps the runbook as a static file rather than importing it:
 * `packages/frontend` has zero `@haven_ai/*` dependencies by design (standalone
 * Vercel deploys), and `public/` is served as-is. A byte-equality test
 * (`src/lib/__tests__/for-agents-runbook.test.ts`) pins the served file to this
 * string, exactly as `agent-skill-bundle.test.ts` pins the skill.
 *
 * Wording constraints, recorded because they are not stylistic (owner
 * constraints 2026-09-04, and `docs/regulatory/casp-risk-guardrails.md`
 * § Product Copy Rules): the human keeps every signature; there is no headless
 * account path; the runbook must never suggest the agent enters the user's
 * password; the owner-signed budget is what authorises a payment, and Haven
 * constructs and relays.
 */

/** Secret hygiene — the one rule that survives every mode and every runtime. */
export const AGENT_SECRET_HYGIENE_SENTENCE =
  'Do not print private keys, API keys, credential file contents, or config secrets in chat or logs.'

/** Where the signing key is made, and what Haven receives instead of it. */
export const AGENT_LOCAL_KEY_SENTENCE =
  'The Haven connector generates the signing key locally and sends Haven only the public signing address plus proof.'

/** Sandboxed environments: the command does not change, the environment does. */
export const AGENT_NETWORK_ACCESS_SENTENCE =
  'Network access is expected: this command downloads the npm package and contacts the Haven API, so if your environment is sandboxed, run it with network access enabled or request network access escalation; that changes the execution environment, not the command, and is not a third command modification.'

/** #2483: `--json` is a SHOULD addressed to agents, not to a human pasting the command. */
export const AGENT_JSON_MODE_SENTENCE =
  'If you are an AI agent running this command yourself rather than a human pasting it, you should append --json: the connector then emits one machine-readable, secret-free result object on stdout with progress on stderr, and returns promptly instead of blocking while it waits for the budget approval.'

/** #2483: one gate at a time — the approval relay comes before anything else. */
export const AGENT_APPROVAL_RELAY_JSON_SENTENCE =
  "When a --json outcome reports approval.required: true, your first action must be to relay the approval instruction to me in your own reply — return to Haven and approve this agent's budget — before verifying the connection, restarting anything, or any other step. Any restart the outcome asks for is a separate instruction to give me afterwards, once the approval is done."

/** #2486: the prose-mode twin of the sentence above; each mode relays exactly once. */
export const AGENT_APPROVAL_RELAY_PROSE_SENTENCE =
  "If you ran the command without --json, the connector waits for the approval itself and prints its next steps when it finishes: relay the budget-approval instruction to me — return to Haven and approve this agent's budget — only if those printed next steps still ask for it. If they report the budget as already approved, there is nothing for me to approve."

/** #1719: exactly two permitted changes, and the second is bounded by the refusal's own list. */
export const AGENT_COMMAND_MODIFICATION_SENTENCE =
  'Only two changes to the command above are permitted, and no others: appending --json, and — only if the connector refuses because it could not determine the agent runtime — re-running it once with --runtime <name> added, naming the harness you are running in, using one of the values that refusal lists. Never invent a runtime name and never change anything else.'

/**
 * The runbook, served at `/for-agents.md`.
 *
 * Every link is a same-origin path (#2520): resolve it against the host the
 * file was fetched from. The connector's npm dist-tag is the placeholder
 * `<channel>` rather than a literal, for two reasons that point the same way:
 * a published package must not hard-code one (#2423, guarded by
 * `scripts/release-bump.test.mjs`), and this string is committed as a static
 * file, so baking in a channel `release-bump.mjs` later rewrites would put the
 * served copy out of parity at exactly the moment nobody is reading it. The
 * page tells the agent to run the command its setup prompt hands it, where the
 * tag is real and deployment-correct.
 *
 * The budget-approval hand-off says "go back to your Haven tab", NOT "open this
 * link", and that is a fact about the connector rather than a stylistic choice.
 * `ConnectOutcome` (`packages/connect/src/runtime.ts`) carries
 * `approval: { required, expires_at }` and nothing else about the approval: no
 * URL, no setup id. `--json` prints that object alone
 * (`packages/connect/src/cli.ts`), and the connector's own status poll
 * (`GET /:setupId/connector-status`) answers `{ status, approved_budget }`, so
 * #2560's `approval_url` never reaches the agent — it is on the setup-create
 * and owner-authenticated status responses, which only the dashboard calls.
 * An agent told to relay a link would have none to relay. #2528 is the slice
 * that puts the link and the setup id in the outcome; when it lands, this
 * paragraph and the two sentences it governs can become the link they describe. `?next=` / `?via=agent` / `?setup=` are the hand-off
 * link shapes from #2522.
 */
export const HAVEN_AGENT_RUNBOOK_MD = `# Haven for agents — set your user up to let you pay

You are an AI agent whose user has no Haven account yet, or has one but has not connected you.

> Links below are paths on this same host: resolve them against the URL you fetched this file from.

## What Haven is, in three sentences

Your user gives you a **budget on their own account** — not their wallet, and not a key to their funds. The budget is a delegation they sign, enforced on-chain: a payment over it, to the wrong recipient, or past its expiry is refused at execution time, not by a dashboard promise. Haven constructs and relays the payments; you get an agent credential and a signing key made on your machine, and your user can revoke the budget without you and without Haven.

## The sequence

Four of the six steps are your user's — each needs a human signature or a human decision. The rest is yours. If they already have a funded account, start at step 3.

1. **HUMAN — create the account.** Name, email, password, then a passkey (Face ID / Touch ID) or a wallet. Never offer to enter any of it: you must not have their password, and the passkey is bound to their device.
2. **HUMAN — fund it.** USDC on Base, to the address the dashboard shows.
3. **HUMAN — create the agent, set its budget**, and paste you the **setup prompt** it hands back.
4. **YOU — run the connector command** in that prompt (below). It makes your signing key locally, registering only the public address.
5. **HUMAN — approve the budget** with their passkey, in the Haven tab they created the agent in: it advances to the approval step by itself once your run registers.
6. **YOU — verify, then pay.**

## Hand-off scripts

Send these as your own message, \`<host>\` replaced by the host you fetched this file from. Say what you cannot do, not only what they must.

**Before signup** (step 1):

> I can do everything except the parts that need your signature. Please open \`<host>/signup?next=/agents&via=agent\` — name, email, password, then a passkey (Face ID / Touch ID) or a wallet. That is your account's key: I should not have it, and I will never ask for your password. Already have one? \`<host>/login?next=/agents\`.

**At the passkey step:**

> The passkey must be made on your own device — it is what keeps the account yours, so nobody, Haven included, can move your funds without you. If this browser cannot, open \`<host>/onboarding?next=/agents\` on your phone and finish there.

**At funding** (step 2):

> Your Haven account needs USDC on Base before I can pay for anything — USDC only, no ETH: Haven sponsors the gas. The dashboard shows the address to send it to; a small amount first is fine.

**At the budget** (step 3):

> On \`<host>/agents\`, create an agent for me and set a budget — say 25 USDC per day. That is the limit I cannot exceed. It hands back a setup prompt: paste it to me and I run it here.

**At budget approval** (step 5) — the moment your run reports that approval is required, before anything else:

> Setup is done on my side. Go back to the Haven tab where you created the agent — it should now be asking you to approve the budget. Approve it with your passkey; nothing can be spent until you do.

## What you run

The setup prompt carries a **connector command** shaped like this:

\`\`\`
npx -y @haven_ai/connect@<channel> --setup EXAMPLE-SETUP-TOKEN-NOT-REAL --api <api-url> --ack-local-tools
\`\`\`

Run the prompt's version, not this one: the token is one-time, the API URL is the backend's own, and \`<channel>\` is the npm tag your prompt names — never a tag you pick. The rules below come from that prompt, so "me" in them is your user, not Haven.

- ${AGENT_JSON_MODE_SENTENCE}
- ${AGENT_APPROVAL_RELAY_JSON_SENTENCE}
- ${AGENT_APPROVAL_RELAY_PROSE_SENTENCE}
- ${AGENT_COMMAND_MODIFICATION_SENTENCE}
- ${AGENT_SECRET_HYGIENE_SENTENCE}

If the approval wait times out, nothing is lost — your agent is registered and the budget is still waiting to be approved. Ask your user to finish it in that same Haven tab. You cannot send them a direct link to it: the connector's outcome carries no URL and no setup id, so do not invent one.

## How to verify

Call \`haven_get_agent\`, one of the Haven MCP tools the connector wires into your runtime in step 4. It returns identity plus \`spend_authority_readiness\`:

- \`ready\` — a budget is live; you can pay.
- \`needs_approval\` — the connector finished, nobody approved yet. Ask your user again, in their Haven tab; there is no queue to wait in.
- \`revoked\` — the credential is not active; ask your user to create a new agent.

\`ready\` covers hosted identity and the budget only, not your local signer. Check that with \`npx -y @haven_ai/connect@<channel> --doctor\`, the same tag your prompt named — a separate command, so the two-changes rule does not bind it.

## If you cannot open a browser

Nothing here needs you to. Every human step is a link: hand your user the full \`<host>/…\` URL, ask them to say when it is done, then poll \`haven_get_agent\` until it reads \`ready\`. Do not route around the sign-in wall — it makes the account theirs, not yours.

## Vocabulary

| Term | What it is |
|---|---|
| **setup prompt** | The text the dashboard hands your user to paste to you. Carries the command and its rules. |
| **connector command** | The \`npx -y @haven_ai/connect@…\` line you run. One-time token, one use. |
| **agent credential** | Your API key (\`sk_agent_…\`), written to \`~/.haven\`. It identifies you; alone it cannot move money. |
| **delegate key** | Your signing key, made on this machine and never sent anywhere. |
| **budget** | The on-chain delegation your user signed. It authorises the payment; Haven constructs and relays it. |

Next: [your agent hit a 402](/402.md) · [everything agent-readable](/llms.txt)
`
