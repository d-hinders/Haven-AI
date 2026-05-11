# Haven Screen Recipes

Use these recipes when designing or refactoring Haven product screens. They translate the product doctrine into repeatable structures Codex and Claude can reuse without inventing new UX each time.

## Global Rules

- Use one obvious primary action per screen or step.
- Lead with what the user controls, not the crypto mechanism underneath.
- Prefer `Haven account`, `Haven wallet`, `agent rules`, and `agent budget`.
- Hide Safe, module, signer, owner, relayer, raw hashes, and raw addresses unless the screen is an advanced/detail surface.
- Money-changing screens need a review moment before execution.
- Mobile layouts should keep the primary action reachable without compressing the risk summary.

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

## Approve Payment

Use when a payment request needs human approval.

Structure:
1. Header with the payment amount and status.
2. Payment intent card showing recipient, reason/source, Haven wallet, network, and agent.
3. Risk explainer showing why approval is required.
4. Primary action: `Approve payment`; secondary action: `Reject`.

Money and risk clarity:
- Make the amount and token the dominant information.
- Explain whether approval is required because the request exceeds the remaining budget.
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
3. Transaction activity rows or table depending on density.
4. Empty state that preserves the current filters.

Money and risk clarity:
- Show amount, token, status, counterparty, account, and date.
- Use external links for details, but do not make hashes the primary labels.
- Prefer `TransactionActivityRow` for history lists. It should show what happened first, then Haven wallet, initiator, counterparty, amount, status, and time.
- Use `Payment sent by you`, `Received payment`, and `Agent payment by [agent name]` before using technical transaction language.
- For x402 payments, collapse the internal Safe-to-agent funding step into one merchant-facing row such as `x402 payment by [agent name]`.
- Show the money path as a compact `From [wallet/counterparty] -> To [wallet/counterparty]` line instead of repeating wallet, initiator, and counterparty in a separate metadata row.
- Keep the amount side to two rows: amount first, then time plus an external-details icon when a transaction link exists.

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
2. Settings sections with one concept per card or row group.
3. Clear destructive or recovery actions with confirmation.
4. Success/error states close to the affected setting.

Money and risk clarity:
- Use `sign-in method` and `approve actions`, not `signer` or `owner`.
- Explain recovery limitations plainly without making the user feel at fault.
