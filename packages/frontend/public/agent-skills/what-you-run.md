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



---

Next: [How to verify](/agent-skills/how-to-verify.md)
