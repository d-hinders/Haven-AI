## Budget changes later (second token, raise, revoke)

The first budget rides the setup in The sequence. After the agent exists, a CLI session can construct the LATER changes — a second token, a bigger amount, a recipient pin, a stop — and hand your user a link; the human still signs, every time:

```
haven budget grant <agentId> --amount <n> --token USDC --period <minutes> [--recipient <address>] [--wait]
haven budget revoke <agentId> <delegationHash> [--wait]
```

The CLI never signs: it prints a dashboard link, your user opens it and signs with their passkey or wallet. `--wait` polls until the human's signature lands. The hash for `revoke` is in `haven budget show <agentId> --hashes`.



---

Next: [Hand-off scripts](/agent-skills/hand-off-scripts.md)
