## Hand-off scripts

Send these as your own message, `<host>` replaced by the host you fetched this file from. Say what you cannot do, not only what they must.

**Before signup** (step 1):

> I can do everything except the parts that need your signature. Please open `<host>/signup?next=/agents&via=agent` — name, email, password, then a passkey (Face ID / Touch ID) or a wallet. That is your account's key: I should not have it, and I will never ask for your password. Already have one? `<host>/login?next=/agents`.

**At the passkey step:**

> The passkey must be made on your own device — it is what keeps the account yours, so nobody, Haven included, can move your funds without you. If this browser cannot, open `<host>/onboarding?next=/agents` on your phone and finish there.

**At funding** (step 2):

> Your Haven account needs USDC before I can pay for anything — USDC only, no ETH: Haven sponsors the gas. Before you send anything, let me get you the exact address **and network** — `haven wallets funding` prints both, and the funding card on `<host>/dashboard` shows the same. Please do not send to an address or a chain I have not confirmed with you; a small amount first is fine.

**At the budget** (step 3):

> On `<host>/agents`, create an agent for me and set a budget — say 25 USDC per day. That is the limit I cannot exceed. It hands back a setup prompt: paste it to me and I run it here.

**At budget approval** (step 5) — the moment your run reports that approval is required, before anything else. Send the first if your run carried `approval.url`, the second if it did not.

> Setup is done on my side. Approve the budget here: <approval.url>. Approve it with your passkey; nothing can be spent until you do.

> Setup is done on my side. Go back to the Haven tab where you created the agent — it should now be asking you to approve the budget. Approve it with your passkey; nothing can be spent until you do.



---

Next: [What you run](/agent-skills/what-you-run.md)
