# Haven Screen Recipes

Use these recipes when designing or refactoring Haven product screens. They translate the product doctrine into repeatable structures Codex and Claude can reuse without inventing new UX each time.

## Global Rules

- Authenticated routes should use the shared shell and `PageHeader` before inventing custom page chrome.
- Use one obvious primary action per screen or step.
- Lead with what the user controls, not the crypto mechanism underneath.
- Prefer `Haven account`, `Haven wallet`, `agent rules`, and `agent budget`.
- Hide Safe, module, signer, owner, relayer, raw hashes, and raw addresses unless the screen is an advanced/detail surface.
- Money-changing screens need a review moment before execution.
- Mobile layouts should keep the primary action reachable without compressing the risk summary.
- Use `.v2-tabular` for financial amounts, counters, and numeric metadata.

## First-Run Dashboard

Use after the user has created a Haven account but has not finished the first useful setup path.

Structure:
1. Normal dashboard header and balance hero.
2. True attention/error state only if it needs action now.
3. One focused next-step card with a single primary action: `Receive funds` or `Connect first agent`.
4. Full dashboard metrics and activity only after setup is dismissed or the user has enough product activity for those sections to be meaningful.

Money and risk clarity:
- For the funding step, say that Receive shows the exact Haven wallet address and network. Do not show the raw address, token list, QR code, or network detail inline on the dashboard.
- For the first-agent step, say the user will set a budget and add the Haven credential. Do not show budget/risk explainers, wallet summaries, or multi-step progress lists on the dashboard.
- Keep the next step honest, but move explanatory detail into the Receive or Connect Agent flow.
- Avoid `import account` copy in the first-run path unless an existing-account flow is actually supported in the UI.

Avoid:
- Sidebar setup tours competing with the dashboard.
- Multi-step checklists for brand-new users.
- Empty-state panels such as `No agents connected yet` beside the first setup CTA.
- Repeating wallet, network, or activity facts that are not needed for the next action.

States:
- Loading balances: do not show a false zero or premature `Connect agent` step.
- No funds: primary action is `Receive funds`.
- Funded with no agents: primary action is `Connect first agent`.
- Dismissed: keep the dashboard usable; other empty states should still offer the same next action.

## Agent Budget Setup

Use when the user creates or edits what an agent may spend.

Structure:
1. Page header with a plain-language title such as `Set agent budget` and a short sentence about what the agent will be allowed to do.
2. Primary configuration card for the agent name, Haven wallet, token, amount, and reset period.
3. Agent rules summary showing the budget in human terms.
4. Risk explainer that states when Haven will ask for approval.
5. Primary action: `Review agent rules`.

Money and risk clarity:
- Show the selected Haven wallet before the user reviews.
- Show the budget amount with token and reset period together, for example `250 USDC per day`.
- State that requests above the remaining budget require approval.
- Do not say `AllowanceModule`, `delegate`, `policy engine`, or `session key` in primary UI.

States:
- Empty: prompt the user to create or link a Haven account before creating an agent budget.
- Loading: preserve card dimensions while loading accounts or balances.
- Error: explain what the user can do next, such as choosing another wallet or trying again.
- Success: move to the review or ready state rather than showing a dead-end confirmation.

## Review Agent Rules

Use immediately before creating or changing an agent's spending authority.

Structure:
1. Page header: `Review agent rules`.
2. Summary card answering who can spend, from which Haven wallet, how much, and how often.
3. Approval note explaining what will happen when a request exceeds the budget.
4. Secondary technical disclosure only if needed, collapsed or visually subordinate.
5. Primary action: `Connect agent` for creation or `Save changes` for edits.

Money and risk clarity:
- Show whether the agent can make payments automatically within the budget.
- Show how the user can revoke or pause later.
- Keep raw addresses out of the primary summary unless there is no human-readable label.

## Agent Ready

Use after an agent budget is created and the user needs to connect the credential to an agent runtime.

Structure:
1. Success header: `Your agent is ready`.
2. Credential card with one clear copy action and a reminder that the credential is shown once if applicable.
3. Agent budget card confirming the active rules.
4. Next-step card for adding the Haven credential to the user's agent.
5. Primary action: `Go to agent`.

Money and risk clarity:
- Repeat the budget and approval boundary.
- Include a clear revoke path.
- Avoid `generate credentials` and `hand the credential`; use `connect your agent`.

## Send Payment

Use when the user manually sends funds from a Haven wallet.

Structure:
1. Form step for Haven wallet, token, amount, and recipient.
2. Shared `Input` fields with inline validation. Use `MaxButton` for available balances and `PasteButton` for recipient addresses when available.
3. Review step with the amount and token as the dominant information.
4. Money path using `TransactionMovement`: From Haven wallet -> To recipient or contact.
5. Compact context for network and approval method.
6. Primary action: `Approve and send`; secondary action: `Back`.

Money and risk clarity:
- Show the selected Haven wallet before money moves.
- Show the recipient as a contact name when available; keep raw addresses subordinate.
- Explain whether the payment will be sent immediately or submitted for additional approval.
- For multi-approval accounts, say no money moves until the remaining approvals are complete.
- Result states should say `Payment sent`, `Payment submitted`, or `Payment was not sent`.
- Use toasts for short success/copy feedback, but keep blocking validation next to the field.

## Receive Funds

Use when the user manually funds a Haven wallet with an on-chain transfer.

Structure:
1. Header that makes this a manual on-chain receive flow.
2. Haven wallet summary with account name and network.
3. Address block with copy as the primary action, plus optional QR code and explorer link.
4. Supported tokens for the selected network.
5. Short checklist explaining network, token, and confirmation requirements.

Money and risk clarity:
- Show the exact Haven wallet and network before the address.
- Make it clear users must send on the same network shown in the modal.
- Say Add funds is the future fiat on-ramp path; do not imply it works in the POC.
- Keep raw address visible because receiving funds requires it, but label it as the Haven wallet address.
- Do not imply Haven holds custody or can recover funds sent on the wrong network.
- Use a success toast after copying, but keep the address and network visible in the modal.
- QR loading should preserve space and use `Skeleton` rather than custom pulse divs.

## Contacts And Recipient Selection

Use when the user saves payment recipients or chooses who receives a manual payment.

Structure:
1. Header that frames contacts as saved recipients, not a technical address book.
2. Searchable list with contact name first and recipient address subordinate.
3. Add/edit modal with contact name and recipient address labels.
4. Delete confirmation that says past payments are not affected.
5. Send flow selector that lets users choose a saved recipient or paste an address directly.

Money and risk clarity:
- In Send, show the contact name as the primary recipient label and keep the raw address subordinate.
- If contacts cannot load, say saved recipients are unavailable and that the user can still paste an address.
- If no contacts are saved, offer a clear path to add contacts without blocking manual address entry.
- Prevent duplicate saved recipient addresses; do not imply duplicate contacts can be created.
- Keep contacts network-neutral in the POC; the Send flow must clearly show the network chosen by the selected Haven wallet before money moves.
- Use `recipient address`, `wallet address`, and `Haven account`; avoid `Ethereum address` in primary product copy unless the network context specifically requires it.

## Approve Payment

Use when a payment request needs human approval.

Structure:
1. Header explaining that agent payments wait here before money moves.
2. Payment request card with the amount and token as the dominant information.
3. Money path using `TransactionMovement`: From Haven wallet -> To recipient or merchant.
4. Compact context for agent, network, wallet, and source.
5. Neutral `ApprovalRequiredBanner` explaining why review is needed.
6. Primary action: `Approve payment`; secondary action: `Reject`.

Money and risk clarity:
- Make the amount and token the dominant information.
- Explain whether approval is required because the request exceeds the remaining budget.
- If the request is approved but not sent, keep it actionable with `Complete payment` and explain that the payment has not moved yet.
- If the account needs more than one approval, use `Approve and submit`, then move the request to a submitted/waiting state instead of leaving it in the active approval queue.
- For x402 approvals, show the merchant hostname when available instead of leading with a raw address.
- Include externally verifiable transaction links after execution, not before they exist.

## Agent Activity

Use for recent payments, queued requests, and agent events.

Structure:
1. Header with agent name and current status.
2. Compact filter or status tabs if the list is long.
3. Transaction/activity rows grouped by recent time.
4. Empty state with the next useful action.

Money and risk clarity:
- Each row should show amount, token, direction/status, and whether it was automatic or required approval.
- Technical hashes stay in detail surfaces.
- Prefer `AgentActivityRow` for agent-specific lists. The primary row title should be `Agent payment`, `Approval request`, `Payment rejected`, or similar human event copy, not a raw recipient address.
- Put recipient, source, and links in row metadata or detail actions.

## Policy Violation

Use when an agent request is blocked or queued because it exceeds rules.

Structure:
1. Status banner with calm, specific copy.
2. Summary of the requested payment.
3. Explanation of which agent rule stopped automatic payment.
4. Primary action based on the surface: `Review request`, `Adjust agent budget`, or `Reject`.

Money and risk clarity:
- Do not imply Haven failed. Say the request needs review or was blocked by the rules.
- State what the agent can still do.

## Transaction History

Use for full lists of payments and account activity.

Structure:
1. Page header with concise description.
2. Filter controls for account, status, type, and time where useful.
3. `TransactionsTable` for full history routes.
4. Empty state inside the table that preserves the current filters.

Money and risk clarity:
- Show amount, token, status, counterparty, account, and date.
- Use external links for details, but do not make hashes the primary labels.
- Use `TransactionActivityRow` for dashboard, account detail, and agent detail previews. Use `TransactionsTable` for the full `/transactions` route.
- Use `Payment sent by you`, `Received payment`, and `Agent payment by [agent name]` before using technical transaction language.
- For x402 payments, collapse the internal Safe-to-agent funding step into one merchant-facing row such as `x402 payment by [agent name]`.
- Show the money path as a compact `From [wallet/counterparty] -> To [wallet/counterparty]` line instead of repeating wallet, initiator, and counterparty in a separate metadata row.
- Keep the amount side to two rows: amount first, then time plus an external-details icon when a transaction link exists.
- Full history table sorting must use raw transaction values for amount sorting and `aria-sort` on sortable headers.
- On mobile, preserve the activity title, money path, amount, time, and external-details link while hiding secondary columns.

## Account Detail

Use for a Haven account or wallet detail surface.

Structure:
1. Header with account name, network, and key actions.
2. Balance card.
3. Agent access or budgets connected to this account.
4. Recent activity.
5. Advanced details section for Safe address, modules, and transaction links.

Money and risk clarity:
- Primary UX uses `Haven account` or `Haven wallet`.
- Technical disclosure is allowed here, but label it gently and keep it visually subordinate.

## Settings And Recovery

Use for sign-in, approval, recovery, and account preferences.

Structure:
1. Page header explaining the setting in user terms.
2. Compact summary cards for the settings that most affect trust, such as display currency, approver access, and sign-in method.
3. Settings sections with one concept per card or row group.
4. Clear destructive or recovery actions with confirmation.
5. Success/error states close to the affected setting.

Money and risk clarity:
- Use `sign-in method` and `approve actions`, not `signer` or `owner`.
- Explain recovery limitations plainly without making the user feel at fault.
- Keep personal profile details on `/profile`; Settings should focus on preferences, access, approvals, recovery, notifications, and data controls.
