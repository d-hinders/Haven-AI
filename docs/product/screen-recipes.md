---
owner: "@d-hinders"
status: current
covers:
  - docs/product/README.md
  - docs/product/design-system.md
  - docs/product/copy-guidelines.md
  - docs/regulatory/casp-risk-guardrails.md
  - packages/frontend/src/components/ReceiveDialog.tsx
  - packages/frontend/src/components/ui/Select.tsx
  - packages/frontend/src/lib/agent-budget.ts
  - packages/frontend/src/lib/agent-list-filters.ts
  - packages/frontend/src/components/ConnectAgentModal.tsx
  - packages/frontend/src/components/connect-agent/ConnectAgentFlow.tsx
  - packages/frontend/src/components/connect-agent/InlineAgentSetup.tsx
  - packages/frontend/src/components/EditAgentModal.tsx
  - packages/frontend/src/components/PaymentCredentialsModal.tsx
  - packages/frontend/src/components/AgentPassportCard.tsx
  - packages/frontend/src/components/LabelsManagerModal.tsx
  - packages/frontend/src/components/agent-panel/ReplaceSigningKeyModal.tsx
  - packages/frontend/src/components/agent-panel/TaxDeclarationToggle.tsx
  - packages/frontend/src/components/agent-panel/McpServerName.tsx
  - packages/frontend/src/app/(authenticated)/agents/[agentId]/AgentSettingsTab.tsx
  - packages/frontend/src/components/DashboardOnboardingGuide.tsx
  - packages/frontend/src/components/haven/**
  - packages/frontend/src/app/(authenticated)/agents/[agentId]/AgentDetailClient.tsx
  - packages/frontend/src/components/transactions/TransactionDetailPanel.tsx
  - packages/frontend/src/components/ui/Input.tsx
  - packages/ui/**
  - packages/frontend/src/components/ui/PageHeader.tsx
  - packages/frontend/src/components/ui/Monogram.tsx
  - packages/frontend/src/components/ui/SegmentedControl.tsx
  - packages/frontend/src/components/ui/Skeleton.tsx
  - packages/ui/src/StatTile.tsx
  - packages/frontend/src/components/analytics/AgentsTable.tsx
  - packages/frontend/src/components/ui/PeriodPicker.tsx
  - packages/frontend/src/components/analytics/EmptyStates.tsx
  - packages/frontend/src/hooks/useAccountingFeed.ts
  - packages/frontend/src/components/settings/CompanyDetailsCard.tsx
  - packages/frontend/src/app/(authenticated)/transactions/TransactionsClient.tsx
  - packages/frontend/src/components/AgentPanel.tsx
  - packages/frontend/src/hooks/useAgentListFilters.ts
  - packages/frontend/src/lib/agent-list-filters.ts
  - packages/frontend/src/hooks/useAgentPanelState.ts
  - packages/frontend/src/lib/half-revoked.ts
  - packages/backend/src/routes/agents.ts
  - packages/frontend/src/app/(authenticated)/accounts/[accountId]/AccountDetailClient.tsx
  - packages/frontend/src/hooks/useTransactionsFeed.ts
  - packages/frontend/src/hooks/useUnfilteredTransactionTotal.ts
  - packages/connect/src/**
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/backend/src/rails/sweep.ts
  - packages/backend/src/routes/machine-payments.ts
  - packages/sdk/src/sweep.ts
last-verified: "2026-10-21"
---

# Haven Screen Recipes

Use these recipes when designing or refactoring Haven product screens. They translate the product doctrine into repeatable structures Codex and Claude can reuse without inventing new UX each time.

## Global Rules

- Authenticated routes should use the shared shell and `PageHeader` before inventing custom page chrome.
- Use one obvious primary action per screen or step.
- Lead with what the user controls, not the crypto mechanism underneath.
- Prefer `Haven account`, `Haven wallet`, `agent rules`, and `agent budget`.
- One name for one gate: the connect flow's approval gate is the `agent budget`
  (`Create setup prompt` on the budget step → the approval screen's
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

Structure (#3818):
1. Normal dashboard header and money card, with the "Needs attention" card below it at
   full width (#3897) — never a side column beside the balance.
2. The setup steps ARE the "Needs attention" card while setup is in progress — titled
   `Get started`, three numbered steps, then the rule items that still apply
   (another agent waiting for setup, a recommended backup signer once funded)
   below them in the same card. Never a second card beside it.
3. Only the next step is highlighted and carries the primary action. Connecting
   an agent stays available before funding, at secondary weight and without the
   highlight; step 3 stays locked until an agent can pay.
4. The steps own the card only until the first agent payment. After it, one
   `You're set up` line takes their place until dismissed (the dismissal persists
   per user), and the steps never return: USDC spent to zero, an expired budget
   or an unreadable balance belongs to the Needs attention rules from then on. "Hide
   for now" persists across reloads, until another step completes.
5. Before the first agent payment, the money panel's spending block says what it
   will show instead of three zero tiles.

What completes a step — never a weaker signal:
- Step 1: USDC on an account (any amount above zero), testnet accounts included.
  ETH or another token's dust does not count: agents spend USDC.
- Step 2: an agent that can pay — active or paused, with a usable budget. A
  connected agent still waiting for budget approval does not count; the step
  names the newest such agent with `Finish setup`.
- Step 3: the first agent payment.

Money and risk clarity:
- The funding step's action opens `Add funds` (after the account picker when the
  user has several accounts), which shows the exact address and network and
  carries the test-network faucet. Do not show the raw address, token
  list, QR code, or network detail in the guide; suggest an amount ("We suggest
  N USDC") rather than require one.
- For the first-agent step, say the user will connect an agent and approve a
  budget. Do not show budget/risk explainers or wallet summaries on the dashboard.
- Keep the next step honest, but move explanatory detail into the Add funds or Connect Agent flow.
- Avoid `import account` copy in the first-run path unless an existing-account flow is actually supported in the UI.

Avoid:
- Sidebar setup tours competing with the dashboard.
- Checklists with multiple active actions or equal visual emphasis.
- Empty-state panels such as `No agents connected yet` beside the first setup CTA.
- Repeating wallet, network, or activity facts that are not needed for the next action.

States:
- Loading the overview: do not show the guide yet — no false zero, no premature step.
- USDC read unavailable: the guide stays; step 1 says the balance could not be read
  and offers no funding action until it can. Never read an unknown balance as zero.
- No funds: primary action is `Add funds`.
- Funded with no agents: primary action is `Connect agent`.
- An agent waiting for setup: step 2 names it with `Finish setup`.
- Dismissed: keep the dashboard usable; other empty states should still offer the same next action.

## Agent Budget Setup

Use when the user creates or edits what an agent may spend.

Structure:
1. Page header with a plain-language title such as `Set agent budget` and a short sentence about what the agent will be allowed to do.
2. Primary configuration card for the agent name, Haven wallet, token, amount, reset period, and end date.
3. Agent rules summary showing the budget in human terms.
4. Risk explainer that states when Haven will ask for approval.
5. Primary action: `Create setup prompt` for creation — the budget summary
   lives on the same step as an always-mounted summary line, not a separate
   review step (#3688) — or `Review changes` for edits.

Money and risk clarity:
- Show the selected Haven wallet before the user reviews.
- Show the budget amount with token and reset period together, for example `250 USDC per day`.
- Show the end date as a CHOICE (#4350): 30, 90 (default), 180 or 365 days —
  no "never" option — with the resulting absolute day stated under the control
  before anything is signed. The pre-sign copy names it too ("One approval.
  Refills every period automatically until 21 Jan 2027."). The choice rides
  the grant's `expires_at`; the server's default of 90 days must never be
  silently substituted for a date the owner was shown.
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

Use before changing an agent's spending authority. Creation no longer has a
separate review step (#3688): the budget step carries the summary inline and
its primary action is `Create setup prompt`.

Structure:
1. Page header: `Review changes`.
2. Summary card answering who can spend, from which Haven wallet, how much, and how often.
3. Approval note explaining what will happen when a request exceeds the budget.
4. Secondary technical disclosure only if needed, collapsed or visually subordinate.
5. Primary action: `Update
   budget`/`Add budget` when the budget changed or `Save details` otherwise.
   Budget editing here is for delegation-rail agents — they manage budgets
   per-budget on the agent detail page, while legacy Safe accounts have no
   Haven budget-management surface. The identity edit modal therefore offers
   `Save details` only.

Money and risk clarity:
- Show whether the agent can make payments automatically within the budget.
- Show the end date both ways (#4350): the budget's CURRENT end on the "Now"
  line and the end the approval will set on the "After you approve" line,
  both as absolute days. An end-date-only change — the renewal — is a change
  on its own and enables the review; an edit whose owner touched nothing on
  the end-date control keeps the current end (it is sent as `expires_at`, so
  the server's 90-day default never silently restarts).
- Show how the user can pause or disable the delegation later.
- Keep raw addresses out of the primary summary unless there is no human-readable label.

## Connect And Approve Agent

Use after the user reviews the agent budget and needs to connect a delegation
agent to its runtime and approve its on-chain authority. The connector works
out which runtime that is (#1720) — the user is never asked — so this flow has
one setup prompt for every environment. Legacy Safe accounts are not rendered at
all since #2413, so this flow is unreachable for one rather than being refused by
a notice.

Two containers, one flow (#4065). `ConnectAgentFlow` owns the hook, the step
dispatch, the step-change focus rule and the stepper; the containers own chrome
only, so they cannot drift:
- **Modal** (`ConnectAgentModal`) — every entry except `/agents` with zero
  agents: the dashboard (with or without agents), `/agents` "Connect agent", and
  a `/agents?setup=<id>` resume link.
  Title "Connect agent", the X, backdrop and Escape close it, focus starts in
  *Agent name* on a fine pointer.
- **Inline first agent** (`InlineAgentSetup`) — `/agents` for a user with no
  agents (see Agent List). A `Card` titled "Connect your first agent", the same
  subtitle and stepper band, the same steps and copy, at the modal's width.
  Three differences, all for the same reason — there is nothing to dismiss:
  step 1 has no Cancel (its one action, "Set agent budget", is full width);
  Escape is not bound, so it never resets the flow or drops the setup prompt;
  nothing is focused on page load (focus moves on a step change only). Step 3's
  disclosure copy blocks drop their own card shell inside it (no nested filled
  card). It opens with the starter budget (10 USDC per day) prefilled. Every exit
  the flow offers — Done, or Close on the approval step, a terminal state or an
  unknown status — leaves it; "Cancel setup" moves to the cancelled state and
  does not.

Structure (the header band — Name / Budget / Connect — stays on step 3 with
Connect active, and step 3 is one unnumbered status checklist — copy → paste →
approve — that is both the instructions and the progress within that step,
#3832; see design-system.md § Step status checklist):
1. Create and copy a single setup prompt — identical for every environment. The
   copy action is the screen's one full-width primary (until the
   server-credential path issues credentials, when "Continue to wallet
   approval" takes that role); the prompt text sits in
   a closed "View the prompt" disclosure. Next to the steps, one line says the
   agent creates its own key and Haven only receives its public address — shown
   on the connector path only, since the manual path makes the key in the
   browser.
2. Wait for the local connector to generate the signing key and API key, then
   register the public signing address and proof with Haven. If it cannot
   connect after the bounded wait — or runs on a server or hosted backend, where
   the connector cannot run at all — the server-credential disclosure (#2482;
   no warning gate, one click) may create the one-time credential in the browser; the user saves it in the
   trusted agent workspace, and the browser registers the same public address
   and proof. It must be labeled as manual, never as an automatically
   configured runtime.
   If Haven still reports no connection after a bounded wait, say only that it
   has not received one yet; point them at the connector's own output first (it
   can refuse locally without ever contacting Haven, and then it is the only
   place naming why), offer the same local command, and let them cancel before
   creating a fresh one-time prompt. Do not show the budget approval until the
   connector or the manual fallback has registered that public address and
   proof.
3. Show the registered public address and reviewed agent budget before the
   delegation signature. The approval step carries the end-date choice
   (#4350): 30, 90 (default), 180 or 365 days, with the resulting absolute
   day under the control and a line that says renewal is a new approval on
   the agent's page — until this slice the connect flow showed no end date
   at all.
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
- On a **testnet account** (the selected account's chain, never the
  deployment's default — both Base and Base Sepolia are offered as an account
  network in every environment), hide the card-purchase on-ramp entirely
  rather than disabling it: buying testnet USDC by card has no real answer.
  Show a faucet link instead, once the address it points at is actually on
  screen — the faucet card is gated on the same condition as the address
  card, since its copy says "from above". It names Circle as the source and
  says plainly the money has no value; the claim that it comes from Circle,
  not Haven, is scoped to that one link, not restated as a product-wide
  claim that Haven never touches funds. A mainnet account (and any other
  registered network with no faucet, e.g. Gnosis) gets the on-ramp (when
  configured) and no faucet link
  ([#3478](https://github.com/d-hinders/Haven-AI/issues/3478)).
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

## Marketplace

Use when the user browses payable merchants and their offers, or hands an agent
one to pay (#3079, epic #3077). Renamed from Catalog; `/catalog` permanently
redirects to `/marketplace`.

Structure:
1. Grid of payable merchant cards: monogram or logo, name, category as plain
   text, two-line description, network chips, and a footer that leads with the
   price ("From <price> USDC", ink) and the offer count after it when there
   is more than one. A test
   merchant carries a neutral "Test" badge; its full note is on the merchant
   page. Coming-soon merchants are not cards: they list below the grid as
   linked rows in one "Coming soon" card, which renders only when it has rows
   (#4052).
2. The [List controls](design-system.md#list-controls--listtoolbar-facetmenu-periodpicker-4110)
   toolbar above the grid (#4114): search over name and description, the
   Network facet (offered when more than one chain is listed, opening on the
   user's own network), Verified ("Any" / "Verified only") and Test merchants
   ("Shown" / "Hidden") as single-select facets, and Category as the pill
   facet. Every control writes the URL — filters survive Back, a refresh and
   a shared link, and the `/catalog?category=…` redirects keep working. The
   standard count, chips, Clear filters and no-match copy apply. Test content
   has one control — the Test merchants facet — and no category pill; its
   default (shown or hidden) follows whether a listed network is a testnet.
3. Merchant page: header (monogram/logo, name, category, website, networks,
   Verified — with the funding action, when shown, below the text until
   `xl` and on its right-hand side from there),
   then the "How to buy" panel (#4005, live merchants with offers only): one
   Card, three steps whose state is claimed from the user's real data — the
   agent connected (or the failed read), the budget that can pay here named
   with its remaining amount (or the specific fix: the fund action, the
   agent's page, or a plain wrong-network sentence), then "ask your agent to
   buy" pointing at the offers below. Loading steps are skeletons that
   claim nothing. Then ONE offers list: each offer a single row — table on
   desktop, stacked card on phone — with a labelled Copy prompt button whose
   confirmation names the one agent that can pay ("Copied — paste it to
   <agent>"); the instruction
   itself is printed in the offer only when the user must edit it (a
   placeholder) or the clipboard refused it (#3998); the user's network's offers first,
   other networks behind an "n more on <chain names>" disclosure.
4. A `coming_soon` merchant page shows only its description, website and
   "Coming soon — not payable yet" — no offers list, no price.
5. An entry point for sellers, reusing the existing submission modal: on the
   grid, a note below the cards that says who it is for ("Sell an API or MCP
   tool?") with a "List your service" button rather than a toolbar button;
   an empty marketplace offers the same "List your service" button as the
   empty state's action. A merchant page offers no seller entry point.

Money and risk clarity:
- Every offer's instruction is the exact text an agent pastes to pay it —
  never a shortened or paraphrased form, so what the user copies is what the
  agent sends.
- Show the per-agent "within budget" / "above every agent budget" hint next to
  the price, never as a claim that a payment will succeed — the on-chain
  caveat enforcer is what actually decides.
- State the payment requirement once, in plain language: what makes the
  payment work is a budget that can pay any recipient — the agent's budget
  must not be limited to one recipient. No protocol names and no jargon
  ("EIP-3009", "unpinned") in rendered copy; in a mixed merchant, tag the
  offers that need it.
- A prospect ("Coming soon") must never look payable: no price, no
  instruction, no offers table.
- The Verified marker means domain control plus a confirmed payable endpoint —
  never merchant honesty, quality, or settlement reliability. One treatment
  everywhere (#4008): the quiet check plus the word "Verified" in sentence
  case, on the grid card and the merchant header alike — no uppercase badge.

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

## Agent List

Use for `/agents`: every managed agent as a card, with the list controls above it (#3165). The list spans every account the user has — there is no global active account narrowing it (#3719) — so when the user has two or more accounts each card names its account (the network is the account's, so the card does not repeat it, #4209).

Structure:
1. `PageHeader`, as on Accounts (#4209): the title and subtitle, **Connect
   agent** as the primary action level with the title, and a ⋯ menu
   (`EllipsisVertical`, the agent page's overflow icon) holding **Labels** and
   **Organizations**. No count chip — the list summary line owns the count. The
   header renders inside `AgentPanel`, beside the state it reads. With no Haven
   account the page shows the title and the "Create a Haven account" empty
   state, and no Connect agent.
2. Toolbar: the [List controls](design-system.md#list-controls--listtoolbar-facetmenu-periodpicker-4110)
   pattern (#4113), browser-filtered: search ("Search agents";
   name, description and delegate address, as its screen-reader description),
   the multi-select facets from the page's registry (Status, Budget, and
   Account and Organization when registered), **Archived** (single-select,
   Hidden / Shown, no All row, Hidden by default), and a **Sort: Name** chip.
   While a filter is active its status row carries a removable chip per
   active filter and Clear filters; the count sits on the pattern's list
   summary line below the card (#4196) — "3 agents", or "1 of 3 agents" while
   filtered. Below `sm` the
   facets and the sort sit in the pattern's Filters sheet. The page adds no
   control or string to it.
3. A warning callout under the toolbar (#3542, carried over by #4113) while
   archived agents are hidden and at least one still has a budget redeemable
   on-chain (`isHalfRevoked`): "1 archived agent still has an active budget"
   (plural for more), with **Show archived**, which sets Archived to Shown
   (omitted when every agent is archived, where the empty state offers it). A
   hidden group never hides redeemable spend authority.
4. The card grid, filtered and sorted by the toolbar. Cards stretch to the
   tallest in their row and pin their footer with `mt-auto`, so footers line
   up across a row, as on `/accounts` (#4209, owner decision 2026-10-21,
   reversing #2237's `items-start`). Archived cards, once shown, keep their
   archived treatment (Restore to list, no operational actions).
5. A filter that empties the list shows the pattern's no-match state
   where the cards were, and the toolbar stays. An UNFILTERED
   list can be empty too — every agent archived — and there Clear filters
   would change nothing, so it says "All your agents are archived" and offers
   Show archived instead.

The card (#4209, mockup version 4 on epic #4207), on the entity-card shell
with a stretched name link:
- **Head:** the agent's `Monogram` (`sm`, decorative), the name, one
  `StatusBadge` only when the agent needs attention, up to three label chips
  then "+N", and a ⋯ menu. The badge is the dashboard row's (`agentBadge`:
  "Needs setup", "Paused", "N% used" at 90% or more) plus "Archived" and
  "Revoked"; a healthy active agent shows none. The account name prints only
  with two or more accounts.
- **Body:** the dashboard row's own `AgentBudget` — meter, caption, "+N
  budgets", the received-sub-budget line, "No budget" — joined from the
  dashboard overview and budget reads by agent id (`GET /agents` carries no
  usage). A skeleton while those load, never "No budget"; an em dash if the
  overview failed. Revoked and archived cards draw no meter and say why
  ("Network access already revoked"; "History stays readable; restoring never
  re-enables spending", or "Restoring to the list does not end its budget"
  while a budget is live). The paused notice, the recoverable-funds notice and
  the half-revoked callout stay on the card.
- **One call to action, by state:** Finish revoking (a live budget after
  revoke or archive, #3542), else Recover funds (stranded funds — the list
  knows only that they exist, so it uses the agent page's own action, to the
  same recovery flow, rather than a count-aware "Review the N payments"),
  else Finish setup
  (`pending_approval`), else Set budget (active, no usable budget).
- **⋯ menu:** Pause payments or Resume payments, Move to organization (only
  when organizations exist), and Remove; Remove from list for a revoked agent;
  Restore to list for an archived one.
- **Footer, one line:** "Last paid {age} · {merchant}" — the merchant's name,
  else the x402 resource host, never an address — else "Connected {age}"
  (`mcp_last_seen_at`; "Last seen {age}" for an agent the overview does not
  cover, which can no longer connect), else "No payments yet". An agent the
  overview does not cover (revoked) never claims "No payments yet". The dashboard rows keep
  #3989's "Last paid" with no merchant.
- **Not on the card:** the MCP server name (on the agent page since #4209),
  the description, the network, and a separate "Last activity" stamp.

Archived agents (`archived_at` set, #1402) and Status "Revoked" are separate
axes: a revoked agent that is not archived is listed, and matched by Status:
Revoked, under the default Hidden. The "Removed (n)" disclosure below the list
is gone (owner decision, 2026-10-20).

First agent (#4065): a user with no agents — archived and revoked rows count as
agents, so this is `agents.length === 0` — gets the connect flow inline instead
of an empty state (see Connect And Approve Agent for the inline container).
- It appears once the first list load SUCCEEDS (a page load or reload shows
  the loading skeleton first, then the flow; a failed first load shows "Agents
  could not load", and its "Try again" shows the skeleton again, never the
  flow), and never over the "Agents could not load" retry state, the
  "Finalizing your agent…" placeholder or the taking-longer state. A later
  refresh of the list that succeeds (after a Labels change, say) does not count
  as loading again: the flow stays, with what the user typed. One that fails
  drops a flow with no setup yet into "Agents could not load".
- Once a setup is being created in it, it stays mounted (a first create that
  fails releases it again, since nothing is in progress) until the user leaves it,
  whatever the list says meanwhile: the connector's register adds a
  `pending_approval` agent the list poll picks up mid-setup, and an approval
  sets the finalizing state. Unmounting there would drop the flow (and an
  approval in flight). Before a setup exists (steps 1 and 2) it shows only while
  the list is empty, so an agent created elsewhere — another tab, an agent-led
  link — replaces it with the list on the next poll.
- While it shows, nothing else of the list surface renders: no header "Connect
  agent", no organization tree, no toolbar or count, no cards, no
  placeholders. The header's ⋯ menu (Labels, Organizations) stays.
- Leaving it shows the list when an agent now exists. With the list still empty
  (a setup cancelled or expired before the connector registered) a fresh flow
  replaces it, starter budget seeded again — except right after an approval:
  Done before the post-approval poll has found the new agent shows the
  "Finalizing your agent…" placeholder (or, if the poll runs out, the
  taking-longer state), and the list once the agent appears.
- `?setup=first` lands on the inline flow when there are no agents and opens the
  modal otherwise, decided after the first list load. A `?setup=<id>` resume
  link always opens the modal, and the inline flow does not render under it.
- The page subtitle states the budget boundary: "Agents pay for things up to a
  budget you set. You approve each budget yourself, and anything over it is
  refused on-chain."

Rules:
- Filter state lives in the URL through the pattern's URL codec (`?q=…&status=active,paused&budget=none&archived=shown&sort=seen`; the comma is percent-encoded on the wire), so a view is shareable and survives reload; `?setup=` and other parameters on the page are preserved in both directions (closing the setup modal drops only `setup`). The cards follow every keystroke and only a search's URL write waits for a 300 ms pause. No `archived` key means Hidden. Unknown values for the fixed facets (Status, Budget, Archived) are dropped from a pasted link; Account and Organization ids are kept until their options load, so a shared link survives the fetch.
- A facet is registered as data (`AgentFacet` in `lib/agent-list-filters.ts`: id, options, predicate, match mode, and optionally selection, default and `allLabel`; `toListFacet` hands it to the toolbar), so the labels facet (#3167), the organization facet (#3164) and the account facet (#3719) plug in without a toolbar change. The account facet is registered only when the user has more than one account; its options name the account with its chain (`Treasury · Base`); the card prints the account name alone (#4209). Facet counts answer "how many if I pick this" — a facet's own selection is excluded from its counts, and the multi-select rows show them.
- The budget facet offers what `GET /agents` can prove about authority (#3988): recurring, one-time, received, none. The first two are the agent's OWN budget cap (a zero cap is no authority, #3897); `received` marks a grant holder — an agent spending through an open sub-budget another agent granted it, which the server verifies against the whole redemption chain (`receivedSubBudgets[].open`) and which never classifies as `none`. Exhausted, near-limit and pending-signature still need a server field and are not offered, because an option that can never match reads as "no agent is near its limit".
- Sort keys: name, recently seen (`mcp_last_seen_at`, never-seen last), newest, largest budget (largest single allowance in its own token units — the row carries no price, so this is deliberately unit-blind; a grant holder, whose amount the row does not carry, ranks above zero-capped agents but below any known positive amount).
- Filtering is client-side over the loaded list; the API is unpaginated, so this holds until an account has enough agents for `GET /agents` itself to need paging.

## Agent Detail

Use for `/agents/[agentId]`: one managed agent — what it can spend, what it has
done, and how to stop it (#3691, epic). The page is the header, the banner
slot, the Spending hero, then tabs (#4226): **Activity** (the default),
**Tool calls** and **Settings** — `Tabs` keyed by `?tab=`, an unknown value
falling back to Activity, no counts on the tab row; switching tabs writes only
the tab into the URL, which clears the tab's filters (the account page's
rule). `?grant=` keeps working alongside `?tab=`. Sections, in order:

1. `PageHeader` with a decorative, name-hashed `Monogram` before the agent name,
   the description as `subtitle`, and the
   `meta` line — wallet · network · Created {age} · Last activity {age} (or
   "No activity yet"; last activity is `mcp_last_seen_at`). Labels sit under
   it. The actions slot: the status badge (renders nothing while active),
   **Pause payments/Resume beside the header** — Pause payments while active, Resume while
   paused, never for an archived agent — then the kebab menu. The per-state
   action matrix (#3694): the kebab renders for **every** state; Edit agent and
   Manage labels unless revoked; Payment credentials and Replace signing key
   unless revoked or archived; a separator; then the terminal item — **Remove
   agent…** (danger-styled, behind its own confirm dialog, so the irreversible
   step is the one the user reaches last and reads twice), or **Restore to
   list** once archived. Archived dominates: an archived agent that was never
   revoked gets Restore and never Pause or Remove. There is no "Update budget"
   item — it only scrolled to the budget card below.
2. State-banner slot: directly under the `PageHeader`, ONE slot stacking
   `ApprovalRequiredBanner`s by severity — danger (the next action cannot be
   undone) → warning (half-revoked credential, stranded funds, exhausted
   budget) → neutral (paused, snapshot reads); within a tone, the banner that
   asks for a decision first. Never scatter banners between sections. On
   agent detail that is: a failed header action, half-revoked (Finish
   revoking), recoverable funds (Recover funds), the refresh error, paused,
   the recovery minimum. A revoked or removed agent with no live budget gets
   one quiet status line under the header instead ("This agent no longer has
   access through Haven.").
3. No separate "About this agent" card: its facts are the header's `meta`.
4. Spending — the ONE budget surface (#3695): heading "Spending" and a
   one-line description (budgets are enforced on-chain) ABOVE the card (see
   the detail-page section rule in design-system.md). The hero is the
   dashboard money-card pattern (#4226): a `Card` with `Card.Section divided` —
   budgets on the left, **Last 30 days** on the right, stacked below `lg`.
   Each budget is one row — amount, period, recipient or merchant and a
   per-budget ⋯ menu whose items are **Edit budget**, **Add budget** and
   **Stop budget** (the first two open their controls; the irreversible action
   sits last, behind a separator, and its confirm still stands between the
   click and the signature) — each measured by a meter that spans its column
   and captioned
   by the shared budget-caption helper in the dashboard ROW style (#3806):
   "0.40 of 3.00 USDC · per day · refills in 24h" at two decimals, then the
   earlier of the refill and the expiry ("refills in 45m" / "refills Thu
   14:02" / "refills 14 Nov"), AND the budget's end date always stated as an
   absolute day after it — "refills in 5h · ends 21 Jan 2027" (#4350); when
   the budget ends first, "ends 1 Sept 2026" IS the next event. The
   refill is anchored on the row's `start_date`, never on the wall clock.
   When the chain read failed or the read's period has already ended, the row
   shows no meter and says usage couldn't be read — never "0 used", and the
   old amount is never paired with the next refill; a future `start_date` (a
   re-key's dormant steady grant) shows when it starts. Quiet note lines
   under the caption come from the helper too: "incl. … by {agent}" for
   sub-agents that spent and "… reserved for task budgets". A paused agent
   greys the meters and adds the shared pause line under each caption
   ("Payments paused in Haven — its budget is still live on-chain."); the
   caption itself is unchanged. A budget at or past 90% used renders the
   warning meter. **Last 30 days** comes from the dashboard overview's
   per-agent stats as three labelled figures across the column (#4260):
   **Spent** — #3803's NET figure in the display currency, the same
   booked-or-repriced, sweep-netted number the dashboard's money card and
   agents section read, so the two surfaces cannot disagree (#4274; an
   unpriced bucket with net 0 renders "—" like the dashboard headline, with
   no unpriced note — that note is account-level) — **Payments** and
   **Last paid** {age},
   each a small label over a 20px value (`Amount size="md"` for Spent), then
   "Last paid to {merchant}" on its own line below, with no divider — the
   merchant label is #4209's helper (name → x402 host → nothing, never an
   address), and with no label the line is omitted. With no payments in the
   window it reads "No payments in the last 30 days.", followed by "Last paid
   {age}" (plus "to {merchant}" when there is a label) when an older payment
   exists. With payments but no recorded time, Last paid reads "—". A revoked
   or otherwise uncovered agent is not in the overview, so it renders no
   Last 30 days column; its history is under Activity.
   **Add budget is collapsed once a budget exists**: with no budget the
   section reads "No budget yet." with a "Set budget" control that opens the
   grant form; once one exists, adding another is the rows' ⋯ menu "Add
   budget" item (#4261 — no button under the list), which opens the form in
   place (Cancel collapses it and returns focus to the row's trigger; after a
   `?grant=` prefill, which has no origin, focus goes to the first row's
   trigger, or to Set budget when there are no rows), never a permanent
   second form — unless `?grant=` asks for the form, in which case it opens
   expanded. Sharing part of an existing budget with another agent lives
   INSIDE the Add budget panel — a quiet line and an "Issue sub-budget"
   button below the grant form, shown only while the panel is open (#3716) —
   never as a permanent card row; the Sub-agent budgets list of issued slices
   stays on the card, outside the panel. A revoked or removed agent's
   section is read-only plus Stop (#3549). The one read-only budget summary
   on the page is the **Received budgets** block (#3988): when the agent
   RECEIVES sub-budget grants (not closed), the card lists each — the
   granting agent's name, the amount per period and its end ("ends …",
   "ended"; a pending grant reads "waiting for the sharing agent to sign it",
   a closing one "closing") — inside the same card, with no actions: closing
   a grant is the granting agent's owner's move. When the agent holds
   received grants and no budget of its own, the grant form's heading still
   reads "Set its first budget" but its line says the agent spends through
   the received budgets below — it must never imply the agent cannot pay.
5. Tabs and Activity (#4226): below the hero, the tab row (no counts), then
   the tab's panel. **Activity** — the agent's OWN payments (`payment_intents`,
   failed and pending included — deliberately NOT the wallet-scoped
   transactions feed, a different population that would drop both those
   states and the refused attempts this tab shows) drawn with the shared
   ledger pieces: `TransactionActivityRow` in ledger mode, merchant-first,
   under `TransactionActivityDayHeader` day bands; the row's "by <agent>"
   title and the "From … →" movement line are GONE — the page fixes the agent
   and the wallet, so neither repeats on a row. The standard toolbar rides on
   the card: search, a **Status** facet (All, Sent, Pending, Failed, Needs
   attention, Refused), **Token** and **Period** — all server-filtered on the
   kinded read (#4229, plus its `token` parameter) — and **Export CSV** in the
   actions slot (#4327): the shared list export action writing the ledger as
   shown through `GET /agent-activity/{id}/activity/export.csv`, under the
   tab's filters, saved as `haven-agent-payments-YYYYMMDD.csv`; on Refused it
   writes the refused attempts. **Refused** (#4323)
   switches the population: the tab then shows the agent's refused payment
   attempts (`payment_refusals`) — what the agent tried to pay, how much, and
   why a guardrail stopped it — through the same ledger row: the merchant
   title, a neutral **Refused** badge, the reason in words (the one
   reason-word map in `lib/refusal-reasons.ts`) and an UNSIGNED amount,
   because no money moved; rows are not interactive (there is no refused
   detail view — everything a refusal says is in the row), the Token facet
   hides (a refusal has no token address), the toolbar's noun reads "refused
   attempt", the empty state is "No refused attempts", and a `relayer_budget`
   row's subline says the payment stayed pending and can be retried (the same
   attempt also shows as a pending payment — the two cannot be linked). The
   deep link `/agents/{id}?tab=activity&status=refused` opens the tab on that
   population (#4324's "Review" lands there). The toolbar's count stands alone
   on the summary line — no figure beside it (#4274, owner decision (a): the
   former "Out" + server total repeated the count and, beside the account
   tab's money In/Out, read as an amount; the count alone is the List
   controls default for a page with no totals, #4196),
   `ListShowMore` sits below the card, and a row opens the shared
   transaction detail panel. No link to `/transactions` under the list
   (#4327): the tab is a full ledger, like the account Activity tab. Empty
   states: "No payments yet" — and for
   an agent still in setup, "Once you set a budget, every payment this agent
   makes shows here." When recoverable-funds payments exist, the Activity tab
   carries a warning dot, "Review the payment(s)" selects the tab and scrolls
   to it (never one payment's panel — #2196's rule), and the affected rows
   carry the Needs attention badge while the Status facet can narrow to them.
   The row badge reads the machine-payment lifecycle before the intent's own
   status, the same precedence as the wallet feed's rows: a stranded
   payment's intent is `confirmed` (its funding settled), so the status alone
   would say Sent (#4249).
   **Tool calls** is the agent's MCP audit log (see **Agent Tool Calls**
   below).
6. Settings (#4228): the tab is two sections, mirroring the account page's
   Security & details tab. Under a small **This agent** label, ONE `Card` of
   `Card.Section divided` rows —
   1. **Connection**: the **MCP server name** (#4209, moved here from the
      `/agents` card) with its copy button and a tooltip naming the
      hosted+signer pair, plus **Last active** (`mcp_last_seen_at`). The
      `not recorded` label keeps #2043's rule: its explanation is visible
      text beside it, never a tooltip. An agent with no name AND no
      `mcp_last_seen_at` reads "**No MCP connection recorded**" — and does
      NOT say "API key": a null name alone also means an MCP agent connected
      before names were recorded. An agent with an API-key prefix gets an
      **API key** line (the visible prefix half of the credential; the full
      key is shown once at creation and in the credentials modal), in every
      connection state.
   2. **Payment credentials**: **View** (opens `PaymentCredentialsModal`) and
      **Replace signing key** (`ReplaceSigningKeyModal`) — hidden for
      revoked and archived agents, matching the header ⋮ menu's
      `canManageCredentials`. The header ⋮ menu keeps every action (Edit
      agent, Manage labels, Payment credentials, Replace signing key, Remove
      agent), so each stays reachable both ways.
   3. **Labels**: the chips plus **Edit**, which opens `EditAgentModal`
      (where the agent's labels are set, #3167). `LabelsManagerModal`
      manages the vocabulary itself and stays in the ⋮ menu. Readable in
      every state; Edit follows the editor's own gate (not mounted when
      revoked).
   4. **Tax declaration**: `TaxDeclarationToggle`, rendered only when the
      company details are VIES-valid (the toggle owns its row and divider;
      the row is absent otherwise).
   5. **Agent Passport**: `AgentPassportCard`'s content as a row. Its own
      revoked-only gate stands — archived agents are not newly gated.

   Under **On {account name}**, a linked row to the account's **Backup &
   recovery** — the account's Security & details tab (`?tab=security`). A
   pointer, not a second copy (#1089). The old standalone "Identity and
   settings" section is gone; its tests moved with the rows.

Money and risk clarity:
- The budget section leads: it is the reason to open an agent at all. The
  identity rows are context, not the payload.
- Every banner names what happens on the next request (declined before money
  moves), never just a state name.
- Remove copy states the on-chain fact: revoking takes effect whether or not
  Haven is reachable, and finish mode ends any remaining budget.

## Agent Tool Calls

Use for the agent page's Tool calls tab (#4227): the
`agent_tool_invocations` audit log the backend writes when an MCP server tags
Haven API calls with `X-Haven-MCP-Tool`. Read-only — an audit trail, not a
spending control, and the tab's one-line intro says exactly that: "Calls from
this agent's MCP runtime: an audit trail, not a spending control."

Structure:
1. The standard toolbar on the card: search (by tool), a **Result** facet
   (All, OK, Error, Denied) and **Period** — all server-filtered on the
   kinded read (#4229, `kind=tool_calls`). The summary line reads "N errors"
   from #4229's `counts.error` (counted WITHOUT the status filter, so it
   holds while the facet flips) beside the call count; when a filter is
   applied the count compares the filtered population against the agent's
   unfiltered one (#4196's rule).
2. Generic `Row` list items under `TransactionActivityDayHeader` day bands —
   NOT `TransactionActivityRow`, which needs an amount and a direction mark
   an audit row does not have (a no-amount variant would be a design-system
   extension). Each row leads with a plain-language label — one per name in
   the closed allowlist `MCP_TOOL_NAMES` (`lib/tool-call-labels.ts`, kept in
   sync with the backend): `haven_get_agent` → "Checked identity and
   budget", `haven_quote_x402` → "Quoted a paid API", `haven_pay_x402_quote`
   → "Paid a quote", `haven_get_allowances` → "Read budgets". The raw tool
   name sits second, as `code`. A retired name in an old row falls back to
   its raw name — the raw name is the one fact the log is certain of.
3. Repeats fold: consecutive calls with the same tool, the same result and
   the same day are one row with "×N". The fold is client-side over the
   LOADED list, so loading more re-folds everything on screen and a run is
   never split at a page boundary; the dashboard's server fold is a
   different population and is not reused.
4. Error and Denied rows carry a `StatusBadge` (`result_status` is
   `ok | error | denied`) and the `error_code` in words
   (`errorCodeLabel`'s map of Haven's own refusal codes; unknown codes
   render as-is — the backend's `error` values are already sentences). OK
   rows render no badge, so the failures are the things that read.
5. A call with a `payment_id` links to that payment: the link selects the
   Activity tab (`?tab=activity&paymentId=…`) and opens that payment's
   shared `TransactionDetailPanel`, read by #4229's `paymentId` filter and
   adapted by `activityToTransaction`. The parameter is consumed — stripped
   once the panel is open — so a re-render or filter write cannot re-open
   it.
6. `ListShowMore` sits below the card, paging with #4229's `hasMore` and
   `total`.

Empty state: an agent with no tool calls gets "No tool calls" and a one-line
reason ("When this agent's MCP runtime calls Haven, each call shows here.")
— and the tab stays. A filtered read with no matches gets the standard
no-match state with the toolbar still up.

Row hairlines are the shared ones: the same-day inset (`--v2-border-subtle`,
#4165's rule) inside a day band and `--v2-border` between bands — never the
deleted `--v2-divider`, whose undefined token painted dividers bright in
dark mode.

## Agent Activity

Use for the agent page's Activity tab (#4226): the agent's own payments —
confirmed, pending and failed alike — in one ledger, and (#4323) the agent's
refused payment attempts. The population is the agent's `payment_intents`
(the kinded read, #4229) and the `payment_refusals` ledger, NOT the
wallet-scoped transactions feed: that feed serves a different set and would
drop both the failed and pending states and the refused attempts this tab
shows.

Structure:
1. The standard toolbar on the card: search, a Status facet (All, Sent,
   Pending, Failed, Needs attention, Refused), Token and Period —
   server-filtered — and Export CSV in the actions slot (#4327): the ledger
   as shown, through the agent's own export route and the shared list export
   action. An empty file reads "Nothing to export." (the ledger is plain
   Postgres, so there is no explorer-outage arm), and a 413 names this tab's
   filters. Token offers only ERC-20s on the agent's chain (when the
   page knows it): an agent payment is never in a native token. A selected
   token that does not resolve is sent as-is and matches nothing — never
   dropped into an unfiltered read under a "Token: …" chip (#4249). With
   fewer than two contract tokens to offer, the Token facet hides (a single
   option is no choice — the toolbar's rule).
2. `TransactionActivityRow` ledger rows, merchant-first, under
   `TransactionActivityDayHeader` day bands (#4225). No "by <agent>" title and
   no "From … →" movement line: the page fixes the agent and the wallet, so
   neither repeats on a row. A row opens the shared transaction detail panel.
3. Refused attempts (#4323): the Status facet's **Refused** value switches
   the population to the refusal ledger, served by the same kinded read
   (`kind=refusals`). A refusal row is the existing ledger row — merchant
   title, a neutral **Refused** badge, the reason in words, the UNSIGNED
   amount — and nothing else: no detail view, no row expansion, no controls.
   The subline reads "<reason words> · No money moved" (`relayer_budget`:
   "… The payment stayed pending and can be retried"). The Token facet hides
   while Refused is selected, the toolbar's noun is "refused attempt", and
   the empty state is "No refused attempts". The deep link
   `/agents/{id}?tab=activity&status=refused` reproduces the view.
4. The toolbar's count alone on the summary line (#4274, owner decision
   (a)) and `ListShowMore` below
   the card; no link to `/transactions` under it (#4327).
5. Empty state with the next useful action ("No payments yet"; for an agent
   still in setup, the budget pointer).

Money and risk clarity:
- Each row shows the user's currency (through `<Amount>`'s currency mode —
  the converted figure rendered plain — a list row never carries `≈` (#3950,
  #4165) — and an em dash when unpriced), direction/status, and whether it ran automatically or was
  declined by the agent rules. List
  rows show no addresses: the counterparty renders through
  `counterpartyLabel`'s no-address mode, the same helper the transactions
  page feeds (#3810, #3811).
- Technical hashes stay in detail surfaces.
- Use `TransactionActivityRow` in ledger mode for the agent's payments — the
  shared row, the day bands and the toolbar are the account tab's pieces, so
  the two ledgers read as one system, and `/transactions` is the same ledger.
  Lead with the merchant (`counterpartyLabel`'s no-address
  mode), not a raw recipient address.
- Put recipient, source, and links in row metadata or detail actions.

**One window for every "last 7 days" (#3975).** The dashboard's time windows
are ROLLING — the owner decision (epic #3801, 2026-10-09): `[now − 7×24h,
now)` on the payment instant, the same definition `/analytics/overview` uses;
no calendar months. The header sentence, the Needs-attention items that say
"in the last 7 days" and the Activity card all cover that one interval (the
wire's `activityWindowStart` is its boundary). They differ in what they put
in it, not when it ends: the header counts confirmed agent payments, the
Activity card also carries deposits, sweeps, failed and pending rows.

**The dashboard's activity list is grouped and merchant-first (#3810).** The
preview renders `GET /dashboard/overview`'s `activity` groups — one row per
group under user-local day headings, at most eight rows over the rolling
last seven days. The title is the counterparty through `counterpartyLabel`'s
no-address mode (merchant site, receipt name, "Deposit" or — for a transfer
from another of the user's own accounts — "From <account>" (#4099), "New
recipient" — never a truncated address); the subtitle is the agent's name, plus
"From <account>" — the account the money left — on a send when the user has
more than one account and a name came back (#4117); a group of N
renders "×N" ("×N+" when the count is a floor). A move between two of the
user's own accounts is ONE group (`ownTransfer`, #4268 — the server runs
#4265's fold before grouping): "Moved between your accounts", `DirectionMark
direction="move"`, the subline "<from> → <to>" through `TransactionMovement`,
an unsigned amount, and no "From <account>" subtitle. Unlike `/transactions`'
"You · …", the card names no initiator — its subtitle has only ever named the
agent. An arrival whose partner leg was not read stays "From <account>"
(#4099). The 5-row `transactions` preview is removed from the wire (#3858) —
no dashboard surface reads it.

The local day is the HEADING, not the window: the groups bucket by the
user's local day (`tz`), but membership is the rolling instant, so a
payment inside the header's 7-day window is always inside the card. Because
the window starts at an instant rather than a local midnight, its oldest
day heading can cover part of a day — when `activityWindowStart` cuts its
own local day, that heading reads "(partial)", the analytics precedent
(`docs/product/analytics.md`: an edge day is marked, never dropped or
stretched).

**Empty state distinguishes no activity from an empty window (#3944).** The
card covers only the rolling last seven days (`[now − 7×24h, now)`, the
backend's `ACTIVITY_WINDOW_DAYS`), so an empty list means one of two things
and the copy says which: a feed with no activity at all renders "No
activity yet" (first-run copy); a feed whose newest transaction is older
than the window renders "No activity in the last N days" with the
transactions page as its action — never a claim that nothing has happened.
The signal (`hasOlderActivity`) and the window (`activityWindowDays` and its
`activityWindowStart` boundary) ride the `/dashboard/overview` response; the
client names the window from the wire and never hard-codes the 7, because
the constant it would copy lives behind the backend's window and can drift.

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
2. The [List controls](design-system.md#list-controls--listtoolbar-facetmenu-periodpicker-4110)
   toolbar (#4111), filtering on the server (#4095), so the rows, the count
   and the CSV are the same set: search, then the Account, Initiator, Token,
   Direction and Network facets (each hidden while it has a single option)
   and Period (Last 7 / 30 / 90 days, All time, or a custom range), with
   Export CSV in the actions slot (content-width on phone — its own row
   after search and Filters, #4150). While a filter is active the status row
   carries a removable chip per active filter and Clear filters. The list
   summary line below the card (#4196) carries the standard count on the
   right — "{n} transactions", or "{shown} of {total} transactions" filtered,
   both server figures — and the "In <total> · Out <total>" money totals on
   the left (per #4266; a Direction filter shows only its half). The next page is "Show N more" below the ledger card
   (the pattern's paging rule); nothing renders under the list once every
   page is loaded. The URL keeps the keys it had before #4111 except search,
   written as `q` with the old `search` still read; the export request builds its API
   parameters with the list's own `transactionFilterParams`, apart from the
   URL codec. Order is newest first by date, fixed —
   there is no Sort chip and no column headers. The account page's Activity tab uses
   the same toolbar and codec (#4130).
3. The list is the shared ledger (per #4266): `TransactionActivityRow` in ledger
   mode with `onOpen`, in compact density, under
   `TransactionActivityDayHeader` day bands — the same anatomy the account and
   agent Activity tabs use. Each row: the title is the counterparty
   (merchant-first, `counterpartyLabel` no-address mode); the subline names who
   acted ("You" or the agent) plus " · <account>" when the user has two or more
   accounts; the badge is `transactionRowBadge(tx)` plus the accounting badge; the
   amount sits right with the time under it. An own-account transfer (the
   backend's `foldOwnTransfers=1`, #4265) reads "Moved between your accounts"
   with `DirectionMark direction="move"`, the subline "You · <from> → <to>" (or
   "Your accounts · …"), and an unsigned amount. The dashboard's Activity card
   shows the same move as one row too (#4268), without the actor. The summary line carries
   "In <total> · Out <total>" beside the count. No Initiator, From/To or link
   columns. A row opens `TransactionDetailPanel`, where the full address and
   explorer link live.
4. A filtered list with no rows shows the standard no-match state
   (`ListNoMatch`) where the rows were, below the toolbar; the page's own
   empty state covers a history with nothing in it yet.

Money and risk clarity:
- **List rows show the user's currency, never the token (#3805, #3811).** The
  amount renders through `<Amount>`'s currency mode via the shared
  `transactionFiat(tx, 'row')` helper: the converted figure — book-time
  `convertedAmount` or serve-time `approxAmount` alike — with NO `≈` mark
  (#3950, owner decision 2026-10-14: the mark's breakable space was the only
  break opportunity the otherwise-NBSP figure had, so approx-valued rows
  wrapped onto two lines; #4165 made it the one rule's answer for every
  row), and an unknown valuation as an em dash — never 0.
  The amount is `whitespace-nowrap`: a money figure never truncates (that
  hides digits) and never wraps — the title absorbs the difference. The token amount appears only where a
  budget is set and in the detail drawer; the `≈` mark lives beside it in
  the drawer, where it explains why the two figures differ — and only where
  the conversion changes the number: a re-priced figure in kr or €, or a
  floating token, never USDC shown in USD (owner decisions, #3811, #3950 and
  #4165; the rule is `shouldMarkApprox`, see `design-system.md` § Amount:
  currency mode).
- **List rows show no addresses (#3810, #3811).** The counterparty half of
  every row renders through
  `counterpartyLabel`'s no-address mode: the merchant's hostname, the source
  title, a resolved name, "Deposit", "From <account>" for a transfer from
  another of the user's own accounts (#4099 — the dashboard reads the server's
  name, the ledgers the chain-keyed own-account map), or "New recipient". A raw address never
  ellipsises into a list row; the detail drawer is where the address
  lives, shortened under Technical details with copy and an explorer link
  (#4267).
- Use external links for details, but do not make hashes the primary labels.
- Use `TransactionActivityRow` for every transaction list: compact previews
  such as Dashboard, and in ledger mode the full `/transactions` history and the
  account and agent Activity tabs.
- **Never present a capped list as a complete one (#2882).** The feed reads a
  bounded window per source per account — a fixed page budget (#2884) — so
  `total` counts what was returned, not what the account holds. When the
  response reports `truncated`, every
  claim on the screen softens together — the page subtitle ("Recent activity"
  rather than "All activity") and a caveat line beneath the count's summary
  line. Since #4196 a fully loaded list ends with its last row and no
  end-of-list string, so there is no third claim to soften. Softening one and
  leaving the other is worse than softening none:
  the louder claim is the one the reader believes. The same rule binds any
  other surface fed by the same hook — the account detail page's transaction
  count included. Hedge the wording ("may not be your full history"); the
  detection is not exact on every provider, and the reason lives in the code.
- The ROW leads with the counterparty (above), never "Agent payment by …" (#4266), and so does the detail drawer's title (#4267). "You" is reserved for human-initiated payments only (#2097): a transaction with no attribution never says "you" — the drawer's header line reads "Sent from", "Paid from" or "Attempted from" <account>, naming no actor.
- For x402 payments, collapse the historical Safe-to-agent funding step into
  one merchant-facing row titled with the merchant's hostname. On the
  eip3009 bridge the funding leg is REAL and present on every payment (#946):
  the account funds the agent's delegate key first, then the delegate pays
  the merchant from the agent's signed authorization. The row still
  represents the agent payment. The detail drawer's Settlement row says what
  the record proves, from `settlementTracking` (#4320) — "Settled (verified)",
  "Checking" ("Haven is looking for the merchant's settlement on-chain. This
  usually takes a minute.") or "Not tracked" ("This payment left your account.
  Haven has no record of the merchant's settlement for it.") — never a word
  that implies a paid payment failed, and never "confirmed by the merchant";
  while an older backend sends no `settlementTracking`, the two original
  states stand ("Recorded (verified)", or "Not recorded yet" with one
  line saying the payment left the account and no settlement has been
  recorded, #3763). Under Technical details a settled row adds "Matched by" —
  how the recorded settlement was attributed: "Payment nonce", "Signed
  payment header" or "Merchant receipt"; nothing for a `legacy` record. Both legs
  sit under Technical details: "Transaction" (the funding leg, also the
  footer's "View on explorer") and "Settlement transaction". Scheme-less and
  erc7710 rows are one transaction. Neither the row nor the drawer names the
  protocol (#2357, #4267): the row title is the resource hostname and the
  drawer calls it a "Paid request".
- The row's subline names who acted and, with two or more accounts, the
  account — never a `From … -> To …` line (#4266). Only a move between the
  user's own accounts draws an arrow: "You · <from> → <to>", or "Your
  accounts · <from> → <to>" when no owner send was recorded (#2097).
- **The detail drawer leads with the answer (#4267, epic #4263).** Its
  anatomy is documented once, in `design-system.md` § Transaction detail
  panel: a header summary (the counterparty, the kind in words, the amount,
  the status, one who/where/when line and a callout when one is needed), a
  few plain-word Details rows, and every raw value under a Technical details
  disclosure, closed by default. Addresses and hashes are shortened there,
  each with copy and an explorer link — this supersedes #3811's "in full"
  rule, whose two-line wraps the shortened form stops; the full value is one
  copy or one click away. The headline is still the user's currency figure
  with the token amount beside it, signless (owner decision 2026-10-09,
  #3811): the currency figure carries the sign, and a move between your own
  accounts carries none.
- The amount sits on the right at `sm` and up and rides under the title
  below `sm`; the time sits under the amount at every width; the explorer link lives in `TransactionDetailPanel`, not on the row.
  There are no columns to collapse and no sorting (#4266 — date order only).

## Analytics

Use for `/analytics`, the reporting surface of what the account's agents did
with their money in a chosen window ([#2947](https://github.com/d-hinders/Haven-AI/issues/2947),
epic [#2944](https://github.com/d-hinders/Haven-AI/issues/2944)). The page is
read-only: it moves no money and changes no authority, so the review-moment
rule above does not bind it, and it must not acquire controls that suggest it
does. The sidebar entry sits after *Dashboard* in the Overview group; the
mobile tab bar stays five cells and the entry rides in the *More* sheet with
the other secondary routes.

Structure:
1. PageHeader with title *Analytics* and the subtitle "What your agents did
   with your money.", plus the window caption beside the period picker. The
   caption comes from the response's own resolved window, not from the control,
   so a request answered for a different window than the one asked for is what
   the reader is told.
2. One `PeriodPicker` — the list-controls period control (#4110) — for the
   window (7d / 30d / 90d, default 30d), presets only: Last 7 / 30 / 90 days,
   no All time and no custom range, because the endpoint takes a rolling
   `range`, not dates. The choice is read in the initialiser, never in an
   effect, so the first request already carries it: a `?period=` on the URL
   wins (a shared link opens on the window it names), else the device's stored
   `haven.analytics.range` — the same device-local rule the theme key follows —
   and a value the endpoint would answer 400 to falls back to the default on
   either surface. Picking writes the stored key and mirrors `?period=` with a
   `replaceState`, no history entry per change (#4116). The display currency
   is read from the Settings currency preference, the one owner of that value;
   the page never re-asks it.
3. Four `StatTile` figures, one request behind all four: *Spent* with its
   basis ("based on N payments", plus how many submissions awaiting their
   settlement evidence are not counted), *Refused* with the attempts behind
   the count and the attempted amount, *Budget used* as a count of agents
   above 75% of their period budget, and *Fees paid to Haven*, which while
   Haven charges no fees says "No fees yet — Haven is not charging fees" in
   words rather than rendering `$0.00`, because "nothing charged in this
   window" is a different fact from "the product is not charging fees".
   (`StatTile` lives in `packages/ui/src/StatTile.tsx`; these are the card
   variant. The redesigned dashboard's hero figures use the `inline` variant
   — no card chrome, `text-base` value, no delta chip — #3805.)
4. The agents table: spend, share, payments, refusals, budget used, top
   merchant, last payment, each row a link into the agent. Budget figures ride
   in the delegation's own token units, captioned by the shared budget-caption
   helper (#3806) — the period length derived from the response's own bounds,
   and the next refill as its next event ("refills Thu 14:02"). There is no
   `expires_at` on this endpoint, so no "expires" branch.
5. Below the table: the spend-over-time chart (one bar per day with activity,
   stacked by agent, refusal caps, partial edge days striped; #3051), then the
   top-merchants table, then the balance-over-time chart (#2949). The table
   stays on the first screen; the charts are the same figures over time.

Money and risk clarity:
- A value is a reading, never a judgement: the figure is ink in every state,
  and only the delta chip carries tone, derived from what a *rising* value of
  that figure means (`StatTile`'s polarity prop owns the rule). More refusals
  is worse; more spend is neither.
- The refused figure is the *attempted* amount. Never "saved": a refused
  payment is money that was not spent, not money that was kept. The count's
  limit is said out — price-cap refusals in the agent's runtime are not
  recorded.
- A budget reading that cannot be made is not a measurement: a failed chain
  read, or a read whose period has already ended, renders "Usage this period
  couldn't be read" instead of a bar — never a 0 % bar and never a "read from
  Haven's last snapshot" claim (#3806).
- The states are mutually exclusive, because what they report about the
  request is: empty says the endpoint answered and the window holds nothing;
  error says it did not answer. A page of confident zeros is what an outage
  is mistaken for, so the empty state replaces the tiles rather than filling
  them, and the error state says the money has not stopped — the agents keep
  spending under the rules the user set — with the one remedy the page has
  evidence for, a retry.
- Fewer than three days carrying data is a reading too short for a trend: the
  tiles stay, and one line says what the charts need before they render.
- The table's two layouts are the same data: below `lg` the row list carries
  spend, refusals and budget on the face of the row and the rest in a
  disclosure. The collapse is a layout decision, not a second source — no
  figure is computed twice, so the two cannot disagree.

## Account Detail

Use for a Haven account or wallet detail surface.

Structure (#4097, epic #4093 — the page is the full record of one account;
the dashboard stays the inbox and the summary, and this page repeats none of
it):

1. Header with the account name, its badges in the metadata line, and key
   actions. "Test network" shows on testnets only (no network marker on
   Base); "Default account" shows only with two or more accounts. Send is
   primary once the account holds money; an empty account makes Receive
   primary and disables Send.
2. One summary card, three columns stacking on a phone:
   - **Balance** — one figure in the user's currency.
   - **Holdings** — a header row: the column label on the left and a small
     "Amount" label on the right (#4166, mockup v9); each token row carries a
     quiet monogram mark and the symbol on the left with its amount
     right-aligned under the "Amount" label — never inline after the symbol.
     The amount shows at most 4 decimals, rounded DOWN by truncating the
     decimal string (never through floats), keeping the wire's 2-decimal
     minimum; a non-zero amount under 0.0001 reads "<0.0001"; the served
     amount (up to 6 decimals) is the figure's tooltip (#4197). One token
     shows no value (it would repeat the balance); a non-USD display currency
     shows the rate instead ("1 USDC = 9,50 kr"); two or more tokens each
     show their value. The header row is the summary card's own anatomy — it
     is not a shared pattern.
   - **Last 30 days** — ONE row under the title (#4197): an in-arrow and the
     Money-in figure, then an out-arrow and the Money-out figure (replacing
     #4166's label row). Both figures sit at the secondary-figure size
     (20px, `Amount size="md"`) beside the 24px `DirectionMark
     density="figure"` (#4260); Balance stays the larger headline. The
     acceptance bar stands: at 1280 px the three columns' content blocks
     differ by at most 24 px. While loading, the skeleton is one row of the
     figures' height, so the card does not jump. Each figure carries sr-only
     text ("Money in" / "Money out") before the amount — a screen reader
     hears "Money in ≈ $19.99" — and the arrow's icon carries the tooltip
     with the same words. At 375px the pairs fit on one line or wrap
     cleanly. The figures come from the rolling `[now − 30×24h, now)` window
     read from the account's transaction feed. When the feed is capped at
     its explorer window the figures carry the partial-data qualifier
     instead of claiming completeness (#2882).
3. One tab row, owned by the page's `?tab=` (Activity default, Agents,
   Security & details). Only the Agents tab carries a count; Security &
   details carries a warning dot when only one signer can approve.
   - **Activity** — the account's transaction feed (#4098 owns this tab's
     final shape), on the list-controls pattern: "In · Out" for the filtered
     set (sr-only "Money in" / "Money out" before each figure) on the left of
     the list summary line, the count on the right (#4196), and "Show N more"
     below the ledger card.
   - **Agents** — one budget-snapshot summary line, then every active agent
     drawn with the shared agent row (#4096). Revoked agents are not listed;
     one line says how many are hidden and links to the Agents page's
     revoked facet.
   - **Security & details** — "Who can approve": the section carries ONE
     heading and ONE intro sentence (#4166 — the card no longer repeats
     them); it is the ONLY place in the app that can add or remove a signer
     or run recovery (`AccountSignersCard` renders here; Settings' Signers
     section lists signers without add or remove flows). With one signer a
     warning sits above the list and the tab carries its dot. Account
     details below: short address with copy and explorer link, network,
     created date.

   (A required-approval-threshold element belonged on this page until
   [#2848](https://github.com/d-hinders/Haven-AI/issues/2848) removed it: the
   approvers surface it described was already deleted by
   [#1989](https://github.com/d-hinders/Haven-AI/issues/1989), and no live
   screen renders a threshold. The delegation rail's `AccountSignersCard` is a
   different concept — the account's signer set, not a Safe owner threshold —
   and is not a substitute for it.)

Removed with #4097: the #3333 "Receiving USDC" off-ramp panel (cash-out
returns later as a saved destination inside Send, when a merchant partner
needs it), the "Agent access" card, the "Token balances" table, "Advanced
account details", and the 10-row transactions preview.

Money and risk clarity:
- Primary UX uses `Haven account` or `Haven wallet`.
- Technical disclosure is allowed here, but label it gently and keep it visually subordinate.
- The transaction count on this page comes from the same capped feed as
  Transaction History, so it softens with it (#2882) — see that section's
  rule. A preview card earns the shortened form ("N recent transactions",
  the count marked "loaded") rather than the full caveat sentence: a
  disclaimer longer than the thing it qualifies is worse than the terse one,
  and `View all` carries the reader to the surface that explains itself.

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
- Stopping the budget ends new funding but does not recover an existing
  agent-wallet balance. Present recovery as a separate action.
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
1. Two distinct OFF states, two copies, never interchangeable (#2869, owner
   decision 2026-09-11). **Hosted with the flag off** is *Coming soon*: the
   route stays visible in production, the sidebar entry carries a muted *Soon*
   pill (its accessible name, and its visible text below `lg`, is *Coming
   soon*), and the page explains what the feed will do and which platforms
   are being lined up — with no connect and no sync control reachable,
   disabled ones included. The page header and the Settings card carry a
   neutral one-liner in both off states; the product subtitle ("…your
   accountant codes and confirms them") is earned by the feed that is on. **Self-hosted** is *not available on self-hosted*: the copy
   must never read as coming soon (nothing is scheduled for that deployment),
   the sidebar entry is hidden, and the Settings card lists no providers.
2. Show add-on availability before connection controls (the flag-on,
   not-entitled case).
3. State whether live delivery is ready. A preview must say that nothing is
   being sent to Fortnox or another provider.
4. Show connected/disconnected provider state with ONE summary line at the
   top of the feed — where spend is going, or what needs the user's hand and
   where to fix it. The connect/disconnect actions themselves live in
   Settings → Accounting (#2868); the feed page links there and offers none.
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
2. Three tabs — General, Security, Business (`?tab=general|security|business`, #4358) — each a simple vertical list of settings sections. Do not make Settings feel like a dashboard. General is the default; an unknown value falls back to it; switching replaces the URL, so the tabs add no history entry.
3. One concept per row group, with the current value and action on the same row when practical.
4. Clear destructive or recovery actions with confirmation.
5. Success/error states close to the affected setting.
6. An Appearance row in Preferences ([#2927](https://github.com/d-hinders/Haven-AI/issues/2927)): the theme preference as a three-option `ui/SegmentedControl` (Light / Dark / System), `aria-label="Theme"`, radio semantics, and the detail line "System follows your device. The toggle in the sidebar changes the same setting." Default is `system` — the OS decides until the user picks explicitly. The choice is device-local under `haven.theme` (same per-device rule the locale key followed), not account data.

Money and risk clarity:
- Use `sign-in method` and `approve actions`, not `signer` or `owner`.
- Explain recovery limitations plainly without making the user feel at fault.
- Personal profile details (name, email, member since) live in Settings → General → Profile (#4358); `/profile` redirects there. General also carries Preferences and Your data; Security carries the passkeys/wallets and the recovery sections.
- Accounting connections and company details are Business-tab sections (#4358, reshaped #4359) whose TAB is visible only when one of them has something to show (a tri-state over the two reads: absent while pending — with an explicit `?tab=business` kept on a skeleton — and a deep link that settles empty falls back to the General body without rewriting the URL). One `SettingsRow` per connector the user can act on — coming-soon and not-configured providers render NO row, and a card with nothing to show renders nothing (#4359) — with a status chip and the one action that resolves the state; the feed settings open inline under the row (`Card.Section`-style block, never a nested filled card); Disconnect confirms and says history in Haven stays; a footer link, *See synced payments on Accounting*, points at the feed page when at least one connector shows; the section header carries the responsibility line (data tooling, not accounting or tax advice — the accountant remains responsible for coding, correctness and filing); copy follows the accounting guardrail — a payment *appears in the ledger with payment evidence attached; the accountant books it*.
- Company details (`CompanyDetailsCard`, #3332, reshaped #4359) is the same shape of Settings section as Accounting beside it: no frontend-side flag of its own (it reads the API's status alone — 404 hides it; 200 `null` shows "No company details" with **Add company details**, which reveals the blank form; a row renders the filled form), the purpose/retention text shown above the form and the Add button always (not behind a tooltip), Country a native `Select` of ISO 3166-1 names that saves the same alpha-2 code (a stored code outside the list renders as its own option and round-trips unchanged), the VIES state a `StatusBadge` ("Checked against VIES" success / "Not found in VIES" warning / everything else neutral — never "verified"), and "Remove company details" a `ghost` trigger in the footer row left of Save, a confirm dialog before `DELETE`, the same danger-button pattern Accounting's Disconnect uses. See [`docs/product/owner-company-details.md`](owner-company-details.md).
- "Passkeys and wallets" is a Security-tab section (owner decision 2026-10-09, #3825; tabbed #4358): a signer is its own object, not part of an account, so every passkey and wallet is listed once with the accounts it approves — each account a link to its `/accounts/<id>?tab=security`. The section speaks in outcomes ("Approves …", "Browser wallet", "Passkey · added {date}"), never "signer" (`copy-guidelines.md`); the account card's link to it ("All your passkeys and wallets in Settings") targets `?tab=security#signers`. No address by default — a wallet row reveals it behind "Show address" — and the browser-wallet connect/disconnect control lives here, as a quiet footer line rather than a row (a row in a list titled Passkeys and wallets reads as one more signer), now that the top bar carries no wallet pill.
- Avoid duplicating account summary facts already shown on Dashboard, Account details, or the Profile section.
