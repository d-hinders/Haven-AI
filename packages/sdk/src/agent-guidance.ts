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
  "When a --json outcome reports approval.required: true, your first action must be to relay the approval instruction to me in your own reply — if the outcome carries approval.url, give me that link; otherwise tell me to return to Haven and approve this agent's budget — before verifying the connection, restarting anything, or any other step. Never build that link yourself: relay the one the outcome gave you or none at all. Any restart the outcome asks for is a separate instruction to give me afterwards, once the approval is done."

/** #2486: the prose-mode twin of the sentence above; each mode relays exactly once. */
export const AGENT_APPROVAL_RELAY_PROSE_SENTENCE =
  "If you ran the command without --json, the connector waits for the approval itself and prints its next steps when it finishes: relay the budget-approval instruction to me — the approval link if those steps printed one, otherwise that you need to return to Haven and approve this agent's budget — only if those printed next steps still ask for it. If they report the budget as already approved, there is nothing for me to approve."

/**
 * #2551, handed to #2528 by PR #2567 so a third writer would not land on the
 * money-path prompt file for one line.
 *
 * The connector's `wiring_collision` refusal is the THIRD case where the agent
 * owes its user a decision rather than an action of its own — beside
 * `approval.required` and the runtime-refusal retry. Named explicitly because
 * the other two are, and an unnamed relay case is one an agent resolves by
 * guessing: here it would guess `--replace` (silently displacing a working
 * agent) or `--name` (quietly wiring a second one). Both are the user's call.
 */
export const AGENT_WIRING_COLLISION_RELAY_SENTENCE =
  'If the connector refuses with wiring_collision, this machine is already wired to a different agent: relay that refusal to me with the superseded_agent_ids and suggested_name it carries, and let me choose whether to replace the existing wiring or add this agent alongside it. Never pick for me by adding --replace or --name yourself.'

/** #1719: exactly two permitted changes, and the second is bounded by the refusal's own list. */
export const AGENT_COMMAND_MODIFICATION_SENTENCE =
  'Only two changes to the command above are permitted, and no others: appending --json, and — only if the connector refuses because it could not determine the agent runtime — re-running it once with --runtime <name> added, naming the harness you are running in, using one of the values that refusal lists. Never invent a runtime name and never change anything else.'

/**
 * The agent-facing section every published README carries (#2533, A6).
 *
 * ONE string, six copies, one instrument. All five npm READMEs plus the repo
 * README open with dashboard-first instructions, which strand the reader this
 * epic exists for: an agent whose user has no account yet. This is the entry
 * that redirects them, and it is defined here rather than written six times
 * because six hand-maintained copies is exactly the drift #2310 was about —
 * `agent-guidance.test.ts` fails if any copy differs by a byte.
 *
 * TWO links, and the second is not redundant. The path is correct wherever
 * Haven is actually served and needs no host we do not own (#2520's rule); the
 * GitHub URL is the one that resolves for a reader on npmjs.com, who has no
 * origin to resolve a path against. A path alone would be unfollowable in the
 * place these READMEs are most often read; an absolute app host alone would be
 * a host nobody owns. Naming both is the honest answer, and the runbook itself
 * is committed at that path, so the fallback is a real file rather than a
 * promise.
 *
 * It says what the agent CANNOT do first. The account and the passkey are the
 * user's, always — stating that up front is what stops an agent trying, and it
 * is the epic invariant no slice may weaken.
 */
export const AGENT_README_SECTION_MD = `## You are an AI agent and your user has no Haven account yet?

Read **\`/for-agents.md\`** on the Haven host your user gave you — or
[the copy in this repository](https://github.com/d-hinders/Haven-AI/blob/dev/packages/frontend/public/for-agents.md)
if you do not have that host yet.

Your user creates the account and the passkey: those are theirs, they need a
human, and you should never ask for their password. You can do everything else
— including running the connector command from the setup prompt they paste you,
and managing the account from the shell with \`@haven_ai/cli\`.`

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
 * The budget-approval hand-off is now a LINK when the connector has one, and a
 * tab when it does not — #2528 landed the half of this that was missing.
 * `ConnectOutcome` (`packages/connect/src/runtime.ts`) carries
 * `approval: { required, expires_at, url? }`; `url` is the same-origin
 * `approval_url` the register response returns, so the agent relays a
 * destination instead of "return to Haven".
 *
 * The step-5 hand-off is TWO blockquotes, not one with the alternative in
 * brackets. It was the bracket form briefly, to save ~110 bytes against the
 * size ceiling, and haven-design-reviewer was right to push back: this
 * section's own header says "Send these as your own message", so every other
 * script in it is paste-ready. A bracketed either/or inside the quote makes
 * the agent perform text surgery on something presented as copyable — and a
 * naive relay ships the raw brackets to the human, which reads as broken
 * rather than as a choice. Two quotes cost bytes and buy back the property
 * the section is built on. Do not re-compress this to save them.
 *
 * `AGENT_WIRING_COLLISION_RELAY_SENTENCE` is deliberately NOT in this page's
 * rule list, though it IS in the setup prompt (#2551 via #2567). This page's
 * list is already a curated subset of the prompt's — it omits the network and
 * local-key sentences and adds the prose-relay one — and a collision can only
 * happen to an agent that is running the connector, which means it is holding
 * the prompt, where the sentence is. Repeating it here would cost every agent
 * that fetches this page bytes for a rule it will be handed at the moment it
 * applies.
 *
 * TWO limits, stated because the copy below depends on both. First, `url` is
 * OPTIONAL and its absence is normal: a backend older than #2528 sends none,
 * and `approval.required: false` carries none because there is nothing to
 * approve — so every sentence here has to work with and without it, which is
 * why they read "if the outcome carries a link". Second, the outcome still has
 * NO setup id: #2528 added the link only, and the connector's own status poll
 * (`GET /:setupId/connector-status`) still answers `{ status, approved_budget }`.
 * An agent must not construct an approval URL out of parts — it has the whole
 * one or it has none. `?next=` / `?via=agent` / `?setup=` are the hand-off
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

**At budget approval** (step 5) — the moment your run reports that approval is required, before anything else. Send the first if your run carried \`approval.url\`, the second if it did not.

> Setup is done on my side. Approve the budget here: <approval.url>. Approve it with your passkey; nothing can be spent until you do.

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

If the approval wait times out, nothing is lost — your agent is registered and the budget is still waiting to be approved. Send your user the \`approval.url\` your run reported, or, if it carried none, ask them to finish it in that same Haven tab. The outcome carries no setup id, so never assemble an approval link out of parts — relay the whole one it gave you or none at all.

## How to verify

Call \`haven_get_agent\`, one of the Haven MCP tools the connector wires into your runtime in step 4. It returns identity plus \`spend_authority_readiness\`:

- \`ready\` — a budget is live; you can pay.
- \`needs_approval\` — the connector finished, nobody approved yet. Ask your user again, in their Haven tab; there is no queue to wait in.
- \`revoked\` — the credential is not active; ask your user to create a new agent.

\`ready\` covers hosted identity and the budget only, not your local signer. Check that with \`npx -y @haven_ai/connect@<channel> --doctor\`, the same tag your prompt named — a separate command, so the two-changes rule does not bind it.

## If you cannot open a browser

Nothing here needs you to. Steps 1-3 are links: hand your user the full \`<host>/…\` URL and ask them to say when it is done. Step 5 is a link only when your run reported one in \`approval.url\` — otherwise it is the tab they already have open, as above. Then poll \`haven_get_agent\` until it reads \`ready\`. Do not route around the sign-in wall — it makes the account theirs, not yours.

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
