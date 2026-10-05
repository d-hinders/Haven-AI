## The sequence

Four of the six steps are your user's — each needs a human signature or a human decision. The rest is yours. If they already have a funded account, start at step 3.

1. **HUMAN — create the account.** Name, email, password, then a passkey (Face ID / Touch ID) or a wallet. Never offer to enter any of it: you must not have their password, and the passkey is bound to their device. With a terminal, `<packages.cli.one_liner> login --api <api-url>` afterwards gets you a scoped session for steps 3-4 (that flag or `HAVEN_API_URL`, on the first command — the session then remembers the backend; **the CLI's built-in default is Haven's hosted production backend**, so on any other deployment an omitted flag connects you somewhere real and wrong rather than failing) — they approve a code in the browser, you never hold their password. That command is the manifest's `packages.cli.one_liner` (`/.well-known/haven.json`) — run it as given: `packages.cli.channel` serves the full spec. Do not hold the process open while you wait: under `--json`, pass `--no-wait` to get the link object back at once, then poll it with `haven login --poll <device_code>` — one round per invocation, exit 3 while it is still pending, 0 once approved. It can set up agents and read the account; it cannot sign, approve a budget, move funds, or rotate any agent's keys.
2. **HUMAN — fund it.** USDC only, no ETH: Haven sponsors the gas. `/.well-known/haven.json` names `chains.default` as the deployment's expected chain, but after login `haven wallets funding` prints the address, the amount and which chain in one place; confirm that chain before you message your user. Without a CLI session, the dashboard's funding card shows the address and amount and its Receive-funds screen names the chain; never assume one: a testnet deployment and production both call themselves Haven. Before you write that message, read the manifest: `environment` says whether this deployment is `production`, and each `chains.supported` entry says whether that chain is a `testnet`. Real money is at stake only on a non-testnet chain of a `production` deployment — tell your user which case theirs is.
3. **HUMAN — create the agent, set its budget**, and paste you the **setup prompt** it hands back. With a CLI session (step 1) you can do this step yourself: `haven agents connect --name <n> --budget <amount> --token USDC --period <minutes>` prints the same connector command and approval link; add `--run` to do step 4 too.
4. **YOU — run the connector command** in that prompt (see What you run). It makes your signing key locally, registering only the public address.
5. **HUMAN — approve the budget** with their passkey, in the Haven tab they created the agent in: it advances to the approval step by itself once your run registers.
6. **YOU — verify, then pay.**



---

Next: [Budget changes later](/agent-skills/budget-changes-later.md)
