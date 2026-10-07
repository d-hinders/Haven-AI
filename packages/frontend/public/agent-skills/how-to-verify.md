## How to verify

Call `haven_get_agent`, one of the Haven MCP tools the connector wires into your runtime in step 4. It returns identity plus `spend_authority_readiness`:

- `ready` — a budget is live: you have the authority to pay. It does not say the account holds funds — the `allowances[]` rows carry `funds_cover_remaining`, and `false` there is a heads-up to mention to your user, not a refusal.
- `needs_approval` — the connector finished, nobody approved yet. Ask your user again, in their Haven tab; there is no queue to wait in.
- `revoked` — the credential is not active; ask your user to create a new agent.

`ready` covers hosted identity and the budget only, not your local signer. Check that with `npx -y @haven_ai/connect@<channel> --doctor`, the same tag your prompt named — a separate command, so the command-modification rule does not bind it.



---

Next: [If you cannot open a browser](/agent-skills/if-you-cannot-open-a-browser.md)
