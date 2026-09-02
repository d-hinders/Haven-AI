---
owner: "@d-hinders"
status: current
covers:
  - docs/product/README.md
  - docs/product/design-system.md
  - docs/product/copy-guidelines.md
  - docs/regulatory/casp-risk-guardrails.md
  - packages/frontend/src/components/ReceiveFundsModal.tsx
  - packages/frontend/src/components/AddFundsModal.tsx
  - packages/frontend/src/components/ConnectAgentModal.tsx
  - packages/frontend/src/components/EditAgentModal.tsx
  - packages/frontend/src/components/DashboardOnboardingGuide.tsx
  - packages/frontend/src/components/haven/**
  - packages/frontend/src/components/transactions/TransactionsTable.tsx
  - packages/frontend/src/components/ui/Input.tsx
  - packages/frontend/src/components/ui/PageHeader.tsx
  - packages/frontend/src/components/ui/Skeleton.tsx
  - packages/frontend/src/hooks/useReporting.ts
  - packages/connect/src/**
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/sdk/src/sweep.ts
last-verified: "2026-09-02" # #2265: the Send Payment recipe had a LIVE subject (`DelegationSendModal.tsx`) and a retired Safe-rail shape — a separate review step, `Approve and send`/`Back`, "submitted for additional approval", and a multi-approval hold. Read against the live modal rather than the issue text: it is titled `Send`, single-step, `Cancel`/`Send`, with "Send from this account with one approval. No network fee for you." Recipe rebased on that, with a note recording what was removed and why, since a recipe is prescriptive — it was telling a contributor to rebuild a deleted screen. Its `/design-system` twin ("Manual payment review" → "Manual send") is rebased in the SAME change, per #2266's "fix both or neither". The retirement record's "answer HTTP 410" corrected to 404: #1986 made them 410, then #2055 deregistered the routes, and `index.ts` and 03-payment-sequence.md already said 404 — this was the last copy saying 410. DECIDED, not fixed: the "if the account needs more than one approval … submitted/waiting state" line sits INSIDE the "Approve Payment — RETIRED, kept as history" section under "Do not build against this recipe", so it is already correctly scoped and is left alone (this corrects my own earlier reading of it as live copy); and the Settings recipe's "approval"/"approve actions" wording is generic signing language, not queue framing, so it stays. Scope: the Send Payment recipe and that one retirement-record fact. NOT re-verified: the other recipes. Prior: #2357: two quoted example strings in this file were the SHIPPED row titles and stopped being so in the same diff that bumped this line — `paymentSourceTitle` no longer returns `x402 payment`. § Transaction History's terminology bullet listed it beside `Agent payment` as human event copy; it now lists `Machine payment`, the OTHER title that function returns (the retired-`mpp_demo` rows' one), rather than `Agent payment` twice. § Policy Violation's x402 collapse bullet quoted `x402 payment by [agent name]` as the merchant-facing row; it now quotes `Agent payment by [agent name]`, and gains the sentence naming what that costs — an x402 row and an ordinary agent payment now share a title, and `From -> To` plus the detail drawer are the disambiguation surface. That is an owner decision, recorded here so the next author reads the trade-off rather than re-litigating it. Found by haven-doc-reviewer; the coupling gate did not implicate this file, because it `covers:` `TransactionsTable.tsx` and not the `src/lib` module the strings actually live in. Scope: those two bullets only. NOT re-verified: any other recipe, the covered components, or this doc's other `covers:` files. Prior: #2258: Re-read the legacy Safe retirement, live delegation boundary, and covered claims for this implementation. Prior: #2097: the transaction-copy bullet in the Transaction History / terminology section — `Payment sent by you` is now human-initiated-only per the initiator-semantics invariant; the neutral `Payment sent` covers unattributed rows. Scope: that one line; no other recipe re-read. Prior: #1947: Agent Activity and Policy Violation recipes de-queued — "queued requests"/"required approval"/"blocked or queued" restated as declined-by-the-rules, the `Approval request` row-copy example replaced with `x402 payment`, and Policy Violation now states there is no queued state to present (rails/execution-rail.ts: the delegation rail is the only live rail; routes/payments.ts declines out-of-policy requests during prepare). Scope: those two recipes only; the Approve-Payment RETIRED block untouched. Prior: #1992: the money-and-risk bullet told designers to state a per-rail over-budget behaviour — "queued for approval on legacy Safe accounts". That branch does not exist: the approval queue died with the Safe rail (#1986/#1987), and a legacy account cannot mint a payment intent at all (HTTP 410), so there is no over-budget state for it to reach. Scope: that bullet; the rest of the agent-budget recipe was re-read and unchanged, and #1989's own corrections to the Approve-Payment recipe stand. Prior: #1989: the "Approve Payment" recipe documented `ApprovalQueue` / the `/approvals` route, both deleted here (and 410 server-side since #1986). No screen matches it on either rail. Marked RETIRED with the recipe kept verbatim in a details block, because its two-leg x402 money-and-risk guidance is the only written record of that presentation and the #946 bridge reintroduces a funding leg. Also dropped "and approvers" from the Account Detail advanced-details bullet, noting that `AccountSignersCard` is a different concept and not a substitute. Scope: those two places. Prior: #1701: adds the Replace An Agent Signing Key recipe — the point-of-no-return gate (name the irreversible step before it is taken, require an acknowledgement that names the consequence, say stopping is free up to the line, remove backdrop/Escape/close past it), tone escalation reserved for that step, and refuse-before-the-gate. Only the new recipe written; the existing recipes on this page were not re-read. Prior: #1852: the Receive Funds recipe's unresolved-network rule now names the QR code and the explorer link explicitly (a receive surface withholds them together with the address, or it is still instructing), adds the required-but-non-promising next action, and pins the account name as the one thing that stays. The unconditional "keep raw address visible" bullet is now conditioned on a confirmed network — it contradicted the #1844 bullet directly above it. Only the Receive Funds recipe re-read. Prior: #1844: the Receive Funds recipe gains the unresolved-network rule — a funding surface that cannot confirm the account's network names none, withholds the address and the on-ramp, and says so, rather than defaulting to Base mainnet. Only that recipe re-read. Prior: #1720: the Connect And Approve recipe no longer pairs a SELECTED runtime — the picker is gone and one setup prompt serves every environment; the bounded-wait step now points at the connector's output, which can refuse locally without Haven ever hearing about it. Other recipes on this page not re-read. Prior: #1684: the approval screen names the gate ONCE — the `Approve agent budget` card heading is gone on both rails, leaving the modal subtitle `Approve the agent budget`; the one-gate-one-name sequence and its per-viewport rule updated to match. Body re-read against the connect-agent components. Prior: #1572 named the gate `agent budget` end to end (recipe titles, primary actions, the one-gate-one-name rule); #1379 bounded pre-registration recovery re-verified alongside the existing Connect handoff and approval flow
---

# Haven Screen Recipes

Use these recipes when designing or refactoring Haven product screens. They translate the product doctrine into repeatable structures Codex and Claude can reuse without inventing new UX each time.

## Global Rules

- Authenticated routes should use the shared shell and `PageHeader` before inventing custom page chrome.
- Use one obvious primary action per screen or step.
- Lead with what the user controls, not the crypto mechanism underneath.
- Prefer `Haven account`, `Haven wallet`, `agent rules`, and `agent budget`.
- One name for one gate: the connect flow's approval gate is the `agent budget`
  (`Review agent budget` → `Confirm agent budget` → the approval screen's
  subtitle `Approve the agent budget`, matching the connector's own "approve
  the budget" narration, #1572). Say it ONCE per viewport: the approval screen
  carried the name as the modal subtitle *and* as the summary card's heading
  about 40px below it, which is the same sentence twice on the screen that
  grants spend authority (#1684). Keep `agent rules` for the broader authority
  concept (detail pages, revoke/pause copy) — never name the same gate with
  both words on one screen.
- Hide Safe, module, signer, owner, relayer, raw hashes, and raw addresses unless the screen is an advanced/detail surface.
- Money-moving, agent-authority-changing, or account-security screens need a
  review moment before execution. Show amount/rule, wallet/network, recipient
  or authority, who approves/signs, what already happened, and what happens
  next.
- Mobile layouts should keep the primary action reachable without compressing the risk summary.
- Use `.v2-tabular` for financial amounts, counters, and numeric metadata.

## First-Run Dashboard

Use after the user has created a Haven account but has not finished the first useful setup path.

Structure:
1. Normal dashboard header and balance hero.
2. True attention/error state only if it needs action now.
3. One compact setup sequence may show the first three steps, but only the
   current step has a primary action: `Receive funds` or `Connect agent`.
   Later steps remain subordinate or locked.
4. Full dashboard metrics and activity only after setup is dismissed or the
   user has enough product activity for those sections to be meaningful.

Money and risk clarity:
- For the funding step, say that Receive shows the exact Haven wallet address and network. Do not show the raw address, token list, QR code, or network detail inline on the dashboard.
- For the first-agent step, say the user will set a budget and connect the agent.
  Do not show budget/risk explainers or wallet summaries on the dashboard.
- Keep the next step honest, but move explanatory detail into the Receive or Connect Agent flow.
- Avoid `import account` copy in the first-run path unless an existing-account flow is actually supported in the UI.

Avoid:
- Sidebar setup tours competing with the dashboard.
- Checklists with multiple active actions or equal visual emphasis.
- Empty-state panels such as `No agents connected yet` beside the first setup CTA.
- Repeating wallet, network, or activity facts that are not needed for the next action.

States:
- Loading balances: do not show a false zero or premature `Connect agent` step.
- No funds: primary action is `Receive funds`.
- Funded with no agents: primary action is `Connect agent`.
- Dismissed: keep the dashboard usable; other empty states should still offer the same next action.

## Agent Budget Setup

Use when the user creates or edits what an agent may spend.

Structure:
1. Page header with a plain-language title such as `Set agent budget` and a short sentence about what the agent will be allowed to do.
2. Primary configuration card for the agent name, Haven wallet, token, amount, and reset period.
3. Agent rules summary showing the budget in human terms.
4. Risk explainer that states when Haven will ask for approval.
5. Primary action: `Review agent budget` for creation or `Review changes` for edits.

Money and risk clarity:
- Show the selected Haven wallet before the user reviews.
- Show the budget amount with token and reset period together, for example `250 USDC per day`.
- State the over-budget behaviour: **refused on-chain**. There is no queued-for-approval
  branch to describe — the approval queue died with the Safe rail (#1440), and a legacy
  Safe account cannot create a payment at all (HTTP 410).
- Do not say `AllowanceModule`, `delegate`, `policy engine`, or `session key` in primary UI.

States:
- Empty: prompt the user to create or link a Haven account before creating an agent budget.
- Loading: preserve card dimensions while loading accounts or balances.
- Error: explain what the user can do next, such as choosing another wallet or trying again.
- Success: move to the review or ready state rather than showing a dead-end confirmation.

## Review Agent Budget

Use immediately before creating or changing an agent's spending authority.

Structure:
1. Page header: `Confirm agent budget` (creation) or `Review changes` (edits).
2. Summary card answering who can spend, from which Haven wallet, how much, and how often.
3. Approval note explaining what will happen when a request exceeds the budget.
4. Secondary technical disclosure only if needed, collapsed or visually subordinate.
5. Primary action: `Create setup prompt` for creation; for edits, `Update
   budget`/`Add budget` when the budget changed or `Save details` otherwise.
   Budget editing here is for delegation-rail agents — they manage budgets
   per-budget on the agent detail page, while legacy Safe accounts have no
   Haven budget-management surface. The identity edit modal therefore offers
   `Save details` only.

Money and risk clarity:
- Show whether the agent can make payments automatically within the budget.
- Show how the user can pause or disable the delegation later.
- Keep raw addresses out of the primary summary unless there is no human-readable label.

## Connect And Approve Agent

Use after the user reviews the agent budget and needs to connect a delegation
agent to its runtime and approve its on-chain authority. The connector works
out which runtime that is (#1720) — the user is never asked — so this flow has
one setup prompt for every environment. Legacy Safe accounts remain readable,
but the dashboard refuses this flow with a retired-rail notice before creating
a signable setup.

Structure:
1. Create and copy a single setup prompt — identical for every environment.
2. Wait for the local connector to generate the signing key and API key, then
   register the public signing address and proof with Haven.
   If Haven still reports no connection after a bounded wait, say only that it
   has not received one yet; tell the user not to approve the budget, point them
   at the connector's own output first (it can refuse locally without ever
   contacting Haven, and then it is the only place naming why), offer the same
   local command, and let them cancel before creating a fresh one-time prompt.
3. Show the registered public address and reviewed agent budget before the
   delegation signature.
4. Ask the user to grant the agent budget in the modal; that signature activates
   the delegation agent.
5. Finish with `Done` plus a compact runtime-specific activation step and a
   read-only `haven_get_agent` / `haven_get_allowances` confirmation. Make clear
   that approval, not restarting, unlocks Haven tools; never require a payment
   to confirm setup.

Money and risk clarity:
- Repeat the budget and approval boundary.
- Include a clear pause or delegation-disable path. Legacy Safe permissions are
  outside Haven; only tell a known wallet owner to use Safe's own interface.
  Passkey-only and unknown-owner cases need a truthful no-self-serve-exit state.
- Say the API key identifies the agent but cannot spend by itself.
- Say the private signing key is created and held locally; Haven receives the
  public signing address and proof, not the key.
- A one-time credential card is a gated manual fallback, not the default setup
  path. If shown, explain that secrets cannot be displayed again.
- Avoid `generate credentials` and `hand the credential`; use `connect your
  agent`.

## Send Payment

Use when the user manually sends funds from a Haven wallet.

Structure:
1. Single form step for Haven wallet, token, amount, and recipient — there is no
   separate review step. `DelegationSendModal` is titled `Send` and submits from
   the same step it collects on.
2. Shared `Input` fields with inline validation. Use `MaxButton` for available balances and `PasteButton` for recipient addresses when available.
3. Lead with the amount and token as the dominant information.
4. Compact context for network.
5. Primary action: `Send`; secondary action: `Cancel`.

Money and risk clarity:
- Show the selected Haven wallet before money moves.
- Show the recipient as a contact name when available; keep raw addresses subordinate.
- Say that the send takes one approval and costs the user no network fee.
- Result states should say `Payment sent` or `Payment was not sent`.
- Use toasts for short success/copy feedback, but keep blocking validation next to the field.

> **Why there is no review step or approval hold here (#2265).** Both were the
> retired Safe rail's shape: a second confirm screen, and a multi-signature
> account that could hold a payment until the remaining owners signed. The
> delegation rail has neither — the owner-signed budget delegation is the
> approval, and a payment outside it reverts on-chain rather than waiting for
> anyone (epic #1440). A recipe that still prescribed `Approve and send` /
> `Back` was telling a contributor to rebuild a deleted screen; its
> `/design-system` twin ("Manual send") was rebased in the same change.

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
- `Add funds` is configuration- and review-gated. When enabled, it opens the
  licensed provider flow with the selected Haven wallet as destination; the
  provider handles KYC and funds. When unavailable, route to `Receive` without
  implying Haven operates an on-ramp.
- If the account's network cannot be confirmed, name no network, withhold the
  deposit address and the on-ramp, and say plainly that the network is unknown.
  A funding surface with a missing network refuses to instruct rather than
  guessing one — the user cannot tell a guess from a fact on that screen, and a
  guess that lands on mainnet costs real money ([#1844](https://github.com/d-hinders/Haven-AI/issues/1844)).
  On a *receive* surface this withholds the **QR code** as well, and that is the
  half worth stating rather than leaving to inference: an address is
  chain-agnostic, so the argument for still showing it is real — but a QR is an
  instruction to send in its most one-click form, and a user who scans it sends
  on whatever network their wallet is already on. Withholding an address costs a
  refresh; a transfer to the right address on the wrong network is often
  unrecoverable. Suppress the address, the copy action, the QR, the explorer
  link, the supported-token list and the send checklist together — a screen that
  keeps any one of them is still instructing
  ([#1852](https://github.com/d-hinders/Haven-AI/issues/1852)).
- The refusal still owes the user a next action, and the action must not
  re-promise what the sentence above it refused. `Refresh page` is the honest
  one — it promises only a retry — and it carries no accompanying sentence:
  "refreshing usually resolves it" would restate the network claim the refusal
  just withdrew. Do not offer a route to the other funding surface either; both
  refuse identically, so the handoff reads as the product forgetting what it
  just said (#1852).
- Keep the account name (and its `Default` badge) visible even while refusing.
  The refusal has to be about something, the name is true on every network, and
  it names no network and offers no way to send (#1852).
- With the network confirmed, keep the raw address visible because receiving
  funds requires it, but label it as the Haven wallet address.
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

## Approve Payment — RETIRED, kept as history

**Do not build against this recipe.** The approval queue was a legacy Safe /
AllowanceModule concept: a payment above the agent's remaining on-chain
allowance was queued for the owner. The delegation rail has no equivalent — it
enforces budget, recipient and expiry on-chain during gas estimation, so an
over-budget payment reverts instead of queueing.

The rail is retired ([#1440](https://github.com/d-hinders/Haven-AI/issues/1440)):
`POST /approvals/:id/approve` and `/proposed` answer HTTP **404** — #1986 made
them 410, then [#2055](https://github.com/d-hinders/Haven-AI/issues/2055)
deregistered the routes outright and dropped `approval_requests`, so there is no
handler left to answer 410. `packages/backend/src/index.ts` and
[03-payment-sequence.md](../architecture/03-payment-sequence.md) both already say
404; this record was the last copy still saying 410. And
[#1989](https://github.com/d-hinders/Haven-AI/issues/1989) deleted the screen —
`ApprovalQueue`, the `/approvals` route, the sidebar entry, the notification
bell and the dashboard's approvals attention row are all gone. No screen in the
product matches this recipe on either rail.

It is kept rather than deleted for one reason: the *money-and-risk* guidance
below is the only written record of how Haven presented a two-leg x402 payment
to a human, and the #946 EIP-3009 bridge reintroduces a bounded funding leg on
the delegation rail. If a human-facing surface for that ever ships, this is the
prior art — not a pattern to copy wholesale.

<details>
<summary>The retired recipe, verbatim</summary>

Use when a payment request needs human approval.

Structure:
1. Header explaining that agent payments wait here before money moves.
2. Payment request card with the amount and token as the dominant information.
3. Money path using `TransactionMovement`: From Haven wallet -> To recipient or merchant.
4. Compact context for agent, network, wallet, and source.
5. Status/source context and a plain-language explanation of why review is
   needed.
6. Primary action: `Approve payment`; secondary action: `Reject`.

Money and risk clarity:
- Make the amount and token the dominant information.
- Explain whether approval is required because the request exceeds the remaining budget.
- If the request is approved but not sent, keep it actionable with `Complete payment` and explain that the payment has not moved yet.
- If the account needs more than one approval, use `Approve and submit`, then move the request to a submitted/waiting state instead of leaving it in the active approval queue.
- For x402 approvals, show the merchant hostname when available instead of leading with a raw address.
- For x402, disclose the two legs: Haven wallet to agent spending wallet, then
  agent wallet to merchant. If the merchant rejects after funding, the agent
  wallet may hold recoverable funds.
- Include externally verifiable transaction links after execution, not before they exist.

</details>

## Agent Activity

Use for recent payments, declined requests, and agent events.

Structure:
1. Header with agent name and current status.
2. Compact filter or status tabs if the list is long.
3. Transaction/activity rows grouped by recent time.
4. Empty state with the next useful action.

Money and risk clarity:
- Each row should show amount, token, direction/status, and whether it ran automatically or was declined by the agent rules.
- Technical hashes stay in detail surfaces.
- Use a card/compact `TransactionsTable` when the agent history needs semantic
  columns, sorting, or pagination. Use `TransactionActivityRow` for a short,
  non-sortable preview. Lead with `Agent payment`, `Machine payment`, `Payment
  rejected`, or similar human event copy, not a raw recipient address.
- Put recipient, source, and links in row metadata or detail actions.

## Policy Violation

Use when an agent request is declined because it exceeds rules. There is no
queued state to present: the rules are enforced on-chain, so an out-of-policy
request is declined before any money moves, and the user's lever is the budget,
not a pending decision.

Structure:
1. Status banner with calm, specific copy.
2. Summary of the requested payment.
3. Explanation of which agent rule stopped automatic payment.
4. Primary action based on the surface: `Adjust agent budget` or `Open agent`.

Money and risk clarity:
- Do not imply Haven failed. Say the request was declined by the rules the user set.
- State what the agent can still do.

## Transaction History

Use for full lists of payments and account activity.

Structure:
1. Page header with concise description.
2. Filter controls for account, status, type, and time where useful.
3. The full-page `TransactionsTable` variant for `/transactions`; card/compact
   variants are valid for scoped histories on account and agent detail.
4. Empty state inside the table that preserves the current filters.

Money and risk clarity:
- Show amount, token, status, counterparty, account, and date.
- Use external links for details, but do not make hashes the primary labels.
- Use `TransactionActivityRow` for short non-sortable previews such as
  Dashboard. Use card/compact `TransactionsTable` for scoped sortable histories.
- Use `Payment sent` (neutral), `Received payment`, and `Agent payment by [agent name]` before using technical transaction language. `Payment sent by you` is reserved for human-initiated payments only (#2097); a transaction with no attribution renders as `Payment sent` with an explicit unknown initiator — never `You`.
- For x402 payments, collapse the historical Safe-to-agent funding step into
  one merchant-facing row such as `Agent payment by [agent name]`. Live
  delegation-rail x402 payments have no funding leg; the row still represents
  the agent payment, while any legacy Safe funding is historical only. The row
  title deliberately does NOT name the protocol (#2357): `x402` rides on the
  detail drawer's section heading, and the row's `From -> To` line carries the
  resource hostname, so an x402 row and an ordinary agent payment read the same
  at the title and are told apart by those two surfaces.
- Show the money path as a compact `From [wallet/counterparty] -> To [wallet/counterparty]` line instead of repeating wallet, initiator, and counterparty in a separate metadata row.
- Keep amount in its own cell; date and the external-details link are separate
  columns or controls.
- Full history table sorting must use raw transaction values for amount sorting and `aria-sort` on sortable headers.
- On mobile, preserve direction, activity/movement, amount, and the
  external-details link. Secondary columns, including date and initiator, may
  hide.

## Account Detail

Use for a Haven account or wallet detail surface.

Structure:
1. Header with account name, network, and key actions.
2. Balance card.
3. Agent access or budgets connected to this account.
4. Scoped transaction history.
5. Advanced details section for Haven wallet address, explorer link and
   required approval threshold. Show modules only if a real advanced
   module-management surface exists. (An approver list belonged here until
   [#1989](https://github.com/d-hinders/Haven-AI/issues/1989) deleted the
   Approvers surface. The delegation rail's `AccountSignersCard` is a different
   concept — the account's signer set, not a Safe owner threshold — and is not
   a substitute for it.)

Money and risk clarity:
- Primary UX uses `Haven account` or `Haven wallet`.
- Technical disclosure is allowed here, but label it gently and keep it visually subordinate.

## Recover Agent-Wallet Funds

Use whenever an agent-controlled wallet has recoverable funds, including an
interrupted/rejected payment or another residual balance.

Structure:
1. Header: `Recover funds`, with agent and network context.
2. Recoverable balance card showing the exact asset and amount.
3. Destination Haven wallet, with address subordinate but externally
   verifiable.
4. Recovery instructions for the agent/runtime and signing step.
5. Current screen states for checking, nothing recoverable, unsupported asset,
   load error, and recoverable/instructions.

Money and risk clarity:
- Say only the agent-held signing key can authorize the recovery; Haven never
  receives that key or holds the funds.
- State the supported recovery boundary. The current one-click gasless path
  returns Base USDC only; native ETH remains in the agent wallet.
- Explain that Haven's relayer pays gas but cannot change the signed destination
  or spend by itself.
- Pausing or revoking stops new Haven-supported funding but does not recover an
  existing agent-wallet balance. Present recovery as a separate action.
- Submission, success, retry guidance, and explorer links belong in the
  agent/tool result today. Surface them on this screen only if execution status
  is later wired back into the route.

## Replace An Agent Signing Key

Use for any owner-authorised change that revokes on-chain authority partway
through a multi-step flow. Today that is replacing an agent's signing key; the
shape generalises to any sequence with a step that cannot be taken back.

Structure:
1. Reason first, because the reasons carry different urgency. A lost key and a
   possibly-stolen one take the same steps, but the second needs the agent's
   recent spending on screen so the owner can judge the damage before deciding.
2. The new public signing address, generated on the agent's own machine and
   pasted here. Say plainly that the private half never reaches Haven and
   cannot be moved between machines.
3. What carries over and what stops working, as two separate lists in the
   owner's terms — budget remainder and period boundary carry; the old key,
   the old credential and any unmade quoted payment stop.
4. The gate. See below.
5. The new credential, shown once, with what to do with it.

The point-of-no-return gate:
- **Name the step that cannot be undone, before it is taken**, and say what the
  agent cannot do until the flow finishes. Do not present it as one step among
  several.
- **Require an explicit acknowledgement** that names the consequence, not a
  bare "are you sure".
- **Say that stopping is free up to here.** An owner who does not know where
  the line is has to treat the whole flow as dangerous.
- **Remove the escape hatches past the line.** Backdrop dismissal, Escape and
  the close button all go, so a stray click cannot strand the agent mid-flow.
  This is the case `product/README.md` § Modals already carves out.
- **Warn against pausing** when a measurement taken at the start is applied at
  the end. A flow that is safe to resume tomorrow should say so; one that is
  not must say that instead.

Money and risk clarity:
- Escalate tone only at the gate. Grouping every caveat into one warning and
  reserving the danger treatment for the irreversible step is what makes the
  irreversible step legible — several same-weight warnings in front of it read
  as one undifferentiated block of yellow and the alarm stops working.
- Where a balance becomes permanently unrecoverable, say permanently, name the
  amount, and offer the recovery that is still possible while it still is.
- Refuse before the gate, never after. When the account cannot sign the flow
  from this device, or the agent is on a rail that has no key to replace, say
  so up front with the reason and the alternative — a refusal discovered
  halfway through is a stranded agent.
- Let a blocked owner still read the flow. Disabling the irreversible action is
  the protection; disabling navigation only hides what they need to prepare.
- Never repeat a backend's prose about what happens next. Render its structured
  fields and write the sentence here, so a claim cannot go stale server-side
  without anything type-checking it.

## Reporting

Use for the guarded hosted reporting add-on. `/accounting` redirects here and
is not a separate product recipe.

Structure:
1. Hide the route when the deployment is self-hosted or the feature flag is off.
2. Show add-on availability before connection controls.
3. State whether live delivery is ready. A preview must say that nothing is
   being sent to Fortnox or another provider.
4. Show connected/disconnected provider state and explicit connect/disconnect
   actions.
5. Show draft transaction states with retry where supported. Only a live
   connector may say `Synced`. Preview/local tracking must say `Tracked`,
   `Prepared`, or `Not delivered`; it must not imply external delivery.

Regulatory and trust clarity:
- Records are factual, draft, and non-asserting. The user or accountant codes
  and confirms them.
- Do not claim Haven completed bookkeeping, reconciliation, VAT/tax judgment,
  filing, or posting.
- Keep empty, loading, error, unavailable, disconnected, preview, and sync
  states honest.

Known implementation gap: the preview currently maps backend `pushed` records
to a `Synced` chip even when `liveSyncReady` is false. The preview banner is not
enough to make that row label safe; change it before treating the surface as
live-delivery accurate.

## Settings And Recovery

Use for sign-in, approval, recovery, and account preferences.

Structure:
1. Page header explaining the setting in user terms.
2. A simple vertical list of settings sections. Do not make Settings feel like a dashboard.
3. One concept per row group, with the current value and action on the same row when practical.
4. Clear destructive or recovery actions with confirmation.
5. Success/error states close to the affected setting.

Money and risk clarity:
- Use `sign-in method` and `approve actions`, not `signer` or `owner`.
- Explain recovery limitations plainly without making the user feel at fault.
- Keep personal profile details on `/profile`; Settings should focus on preferences, access, approvals, recovery, notifications, and data controls.
- Avoid duplicating account summary facts already shown on Dashboard, Profile, or Account details.
