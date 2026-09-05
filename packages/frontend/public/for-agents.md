# Haven for agents — set your user up to let you pay

You are an AI agent whose user has no Haven account yet, or has one but has not connected you.

> Links below are paths on this same host: resolve them against the URL you fetched this file from.

## What Haven is, in three sentences

Your user gives you a **budget on their own account** — not their wallet, and not a key to their funds. The budget is a delegation they sign, enforced on-chain: a payment over it, to the wrong recipient, or past its expiry is refused at execution time, not by a dashboard promise. Haven constructs and relays the payments; you get an agent credential and a signing key made on your machine, and your user can revoke the budget without you and without Haven.

## The sequence

Four of the six steps are your user's — each needs a human signature or a human decision. The rest is yours. If they already have a funded account, start at step 3.

1. **HUMAN — create the account.** Name, email, password, then a passkey (Face ID / Touch ID) or a wallet. Never offer to enter any of it: you must not have their password, and the passkey is bound to their device. With a terminal, `npx @haven_ai/cli login` afterwards gets you a scoped session for steps 3-4 — they approve a code in the browser, you never hold their password. It can set up agents and read the account; it cannot sign, approve a budget, or move funds.
2. **HUMAN — fund it.** USDC on Base, to the address the dashboard shows.
3. **HUMAN — create the agent, set its budget**, and paste you the **setup prompt** it hands back.
4. **YOU — run the connector command** in that prompt (below). It makes your signing key locally, registering only the public address.
5. **HUMAN — approve the budget** with their passkey, in the Haven tab they created the agent in: it advances to the approval step by itself once your run registers.
6. **YOU — verify, then pay.**

## Hand-off scripts

Send these as your own message, `<host>` replaced by the host you fetched this file from. Say what you cannot do, not only what they must.

**Before signup** (step 1):

> I can do everything except the parts that need your signature. Please open `<host>/signup?next=/agents&via=agent` — name, email, password, then a passkey (Face ID / Touch ID) or a wallet. That is your account's key: I should not have it, and I will never ask for your password. Already have one? `<host>/login?next=/agents`.

**At the passkey step:**

> The passkey must be made on your own device — it is what keeps the account yours, so nobody, Haven included, can move your funds without you. If this browser cannot, open `<host>/onboarding?next=/agents` on your phone and finish there.

**At funding** (step 2):

> Your Haven account needs USDC on Base before I can pay for anything — USDC only, no ETH: Haven sponsors the gas. The dashboard shows the address to send it to; a small amount first is fine.

**At the budget** (step 3):

> On `<host>/agents`, create an agent for me and set a budget — say 25 USDC per day. That is the limit I cannot exceed. It hands back a setup prompt: paste it to me and I run it here.

**At budget approval** (step 5) — the moment your run reports that approval is required, before anything else. Send the first if your run carried `approval.url`, the second if it did not.

> Setup is done on my side. Approve the budget here: <approval.url>. Approve it with your passkey; nothing can be spent until you do.

> Setup is done on my side. Go back to the Haven tab where you created the agent — it should now be asking you to approve the budget. Approve it with your passkey; nothing can be spent until you do.

## What you run

The setup prompt carries a **connector command** shaped like this:

```
npx -y @haven_ai/connect@<channel> --setup EXAMPLE-SETUP-TOKEN-NOT-REAL --api <api-url> --ack-local-tools
```

Run the prompt's version, not this one: the token is one-time, the API URL is the backend's own, and `<channel>` is the npm tag your prompt names — never a tag you pick. The rules below come from that prompt, so "me" in them is your user, not Haven.

- If you are an AI agent running this command yourself rather than a human pasting it, you should append --json: the connector then emits one machine-readable, secret-free result object on stdout with progress on stderr, and returns promptly instead of blocking while it waits for the budget approval.
- When a --json outcome reports approval.required: true, your first action must be to relay the approval instruction to me in your own reply — if the outcome carries approval.url, give me that link; otherwise tell me to return to Haven and approve this agent's budget — before verifying the connection, restarting anything, or any other step. Never build that link yourself: relay the one the outcome gave you or none at all. Any restart the outcome asks for is a separate instruction to give me afterwards, once the approval is done.
- If you ran the command without --json, the connector waits for the approval itself and prints its next steps when it finishes: relay the budget-approval instruction to me — the approval link if those steps printed one, otherwise that you need to return to Haven and approve this agent's budget — only if those printed next steps still ask for it. If they report the budget as already approved, there is nothing for me to approve.
- Only two changes to the command above are permitted, and no others: appending --json, and — only if the connector refuses because it could not determine the agent runtime — re-running it once with --runtime <name> added, naming the harness you are running in, using one of the values that refusal lists. Never invent a runtime name and never change anything else.
- Do not print private keys, API keys, credential file contents, or config secrets in chat or logs.

If the approval wait times out, nothing is lost — your agent is registered and the budget is still waiting to be approved. Send your user the `approval.url` your run reported, or, if it carried none, ask them to finish it in that same Haven tab. The outcome carries no setup id, so never assemble an approval link out of parts — relay the whole one it gave you or none at all.

## How to verify

Call `haven_get_agent`, one of the Haven MCP tools the connector wires into your runtime in step 4. It returns identity plus `spend_authority_readiness`:

- `ready` — a budget is live; you can pay.
- `needs_approval` — the connector finished, nobody approved yet. Ask your user again, in their Haven tab; there is no queue to wait in.
- `revoked` — the credential is not active; ask your user to create a new agent.

`ready` covers hosted identity and the budget only, not your local signer. Check that with `npx -y @haven_ai/connect@<channel> --doctor`, the same tag your prompt named — a separate command, so the two-changes rule does not bind it.

## If you cannot open a browser

Nothing here needs you to. Steps 1-3 are links: hand your user the full `<host>/…` URL and ask them to say when it is done. Step 5 is a link only when your run reported one in `approval.url` — otherwise it is the tab they already have open, as above. Then poll `haven_get_agent` until it reads `ready`. Do not route around the sign-in wall — it makes the account theirs, not yours.

## Vocabulary

| Term | What it is |
|---|---|
| **setup prompt** | The text the dashboard hands your user to paste to you. Carries the command and its rules. |
| **connector command** | The `npx -y @haven_ai/connect@…` line you run. One-time token, one use. |
| **agent credential** | Your API key (`sk_agent_…`), written to `~/.haven`. It identifies you; alone it cannot move money. |
| **delegate key** | Your signing key, made on this machine and never sent anywhere. |
| **budget** | The on-chain delegation your user signed. It authorises the payment; Haven constructs and relays it. |

Next: [your agent hit a 402](/402.md) · [everything agent-readable](/llms.txt)
