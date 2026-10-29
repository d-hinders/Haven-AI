---
owner: "@d-hinders"
status: record
covers:
  - packages/frontend/src/app/(authenticated)/dashboard/ActivitySection.tsx
  - packages/frontend/src/components/agent-panel/AgentCard.tsx
last-verified: "2026-10-14"
---

# QA run report — browser exploration — dashboard redesign (epic #3801), user A — dev

> **Secret-safety rule:** Never paste private keys, API keys, JWTs/cookies,
> setup tokens or token-bearing prompts, credential files, Authorization
> headers, or secret-bearing logs. This report records public addresses,
> sanitized URLs and agent ids only.

## Run Metadata

- **Run mode:** browser exploration (`qa-explore-ui`, Layer 3, non-gating, observe-only)
- **Flow/scenarios:** Epic #3801 promotion checklist, box 1, "Product verification on `dev`". This run covers **user A only**. User B (at least 7 agents, two accounts, at least 40 same-day payments to one merchant) does not exist on dev yet, and building it is a write step outside this observe-only layer (owner decision, 2026-10-14).
- **Started / finished (UTC):** 2026-10-14 13:29 / 13:51
- **Runner:** captain session (Claude Code) driving the Claude desktop app's built-in browser pane. The owner signed in; the agent drove from there.
- **Exact command:** `/qa-explore-ui` (skill), with the epic #3801 arguments
- **Process exit code:** n/a (interactive exploration)
- **Git branch / SHA:** `dev` / `fcce7adc` (repo head at the end of the run)
- **Frontend URL / build SHA:** `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app` / **`6b940f31`**. This is the newest `dev` commit whose Vercel status is "Deployment has completed". The four later pushes (`686ac03c`…`fcce7adc`) show "Canceled by Ignored Build Step", so `6b940f31` is what the alias serves. It contains every #3801 slice merged so far, through #3914.
- **Backend URL / deploy SHA:** `https://havenbackend-dev-8b95.up.railway.app`, reached through the frontend's same-origin `/api` proxy. The deploy SHA was not read.
- **Merchant URL / version:** n/a (no payments made)
- **Chain:** Base Sepolia (`84532`)
- **Runtime/browser:** Claude desktop built-in browser (Chromium). Viewports: the pane's natural width (~829px), 1280×900, 390×844 and 375×812 (mobile emulation).
- **Package versions:** n/a (UI only)
- **CI workflow/run:** n/a
- **Public QA identity:** user A = the owner's dev test account. It has one account, `0x6d0149C6bB01AF61e377360D82a3D38C1EC8081e` ("My account"). One agent, "Del Agent" (`fac9c8f3-3fb6-49ee-b572-5f173a1e4480`), in `pending_approval` with no budget.
- **Overall result:** **partial/blocked**. User A passed with friction. User B and the p95 measurements were not run.
- **Completeness:** 6/6 user-A surfaces visited (dashboard, transactions and the detail panel, agents list, connect-agent modal, agent detail, and phone widths) · 0 failed · user B skipped (account does not exist)

## Preflight

- [x] Dev/testnet only. No production credentials, RPCs or real funds. No state-changing control was submitted.
- [x] Correct frontend and backend confirmed. The `DEV` badge renders, every data call goes to the same-origin `/api/*` proxy of the `-git-dev-` alias, and the account is on Base Sepolia.
- [x] Haven wallet balance recorded: 0,10 kr (0.01 USDC). No live delegation budget (the agent needs setup).
- n/a Relayer gas, delegate balance (no payments).
- n/a Secret names (the owner signed in interactively; no secrets were handled by the agent).

## Command And Artifacts

- **Command output summary:** observe-only walk of 6 surfaces at 4 widths. Horizontal-overflow and secret-pattern checks were run in page by script.
- **Artifacts:** none committed. Screenshots stayed in the session.
- **Artifact secret review completed:** yes. The page text was scanned for private-key, JWT, API-key and `sk_` patterns on the agent page only (no match); the other surfaces were checked visually, and no token, cookie or header was copied into this report.

## Epic #3801 Verification — user A

The account is a first-run user, so the dashboard rendered in **Get started** mode, not "Needs attention".

| Surface | What was checked | Result | Notes |
|---|---|---|---|
| Dashboard, money card | Balance in the preferred currency, test-network label, Add funds / Deposit address, sparkline | pass | `0,10 kr`, "Test network". A new user's flat sparkline leaves space above the buttons (known nit from PR #3909). |
| Dashboard, Get started card | Step state, primary action, header band | pass | "1 of 3 done". Step 2, "Finish setting up Del Agent", has the primary **Finish setup**; "Hide for now" is in the header. Nit N1 below. |
| Dashboard, Agents card | Setup row | pass | "Del Agent · Needs setup · No budget". No last-payment column on a setup row, as specified. |
| Dashboard, Activity card | Empty state | **fail** | F1: it says "No activity yet. Receive funds…" although the account was funded 13 days ago. |
| Transactions + detail panel | Row, panel, amounts | pass | "Received payment · From Deposit → My account · 13d ago · ≈ +0,10 kr". The panel shows 0.01 USDC, Executed, Base Sepolia, and copyable addresses and hash. |
| Agents list | Card, chips, actions | **fail** | F2: the raw `pending_approval` chip, and "Resume from pause" offered to an agent that was never paused. |
| Connect-agent modal | Step 1 (opened, not completed) | pass | Name, description and Advanced; "Set agent budget" disabled until named. No secret is rendered. |
| Agent detail | Header, budget card, activity, passport | pass with friction | "Needs setup", a first-budget form, and the on-chain enforcement sentence. Nit N3. |
| Phone widths | Horizontal overflow on dashboard, transactions, agents and agent detail | pass | `scrollWidth == innerWidth` at 390 and 375 on every surface. Nit N2 at 375. |
| Console / network | Errors, failed calls | pass | Only Vercel's preview-toolbar CSP report-only notices (`vercel.live` framing) and one 401 from before sign-in. A clean load fetches each `/api/*` endpoint once. |
| Money & authority clarity | Agent page: who can spend, how much, how to stop | pass | The budget card says what is spent per period, that it is enforced on-chain, and that one signature sets it. The Pause and Remove controls are on the card. |

**Not run (still open on the checklist):**
- user B;
- the Railway p95 for `GET /dashboard/overview` and `GET /dashboard/budget-remaining` as user B (the owner reads these from Railway when user B exists);
- the backup-signer item, which is verified from its visual-baseline fixture, per the checklist.

## Friction, Bugs, And Infrastructure Failures

| Severity | Type | Step/scenario | Expected | Actual | Reproducibility | Mode/environment | Evidence | Issue | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| should-fix | product | F1: dashboard Activity card, empty | An empty 7-day list on an account with older activity says so ("No activity in the last 7 days") and links to Transactions | "No activity yet. Receive funds or make your first payment…", while Get started ticks "Add USDC" and `/transactions` lists a 13-day-old deposit | always (any account whose activity is all older than 7 local days; generalised from the code, one account observed) | browser, dev `6b940f31` | `ActivitySection.tsx:25, :100, :103`; the backend's `ACTIVITY_WINDOW_DAYS = 7` (location in #3944) | #3944 (slice of #3801) | new |
| should-fix | product | F2: `/agents` card, `pending_approval` agent | Status chip "Needs setup"; a "Finish setup" action; no pause/resume | The chip prints `pending_approval`. The action row offers "Resume from pause" because the card renders Pause only for `active` and Resume otherwise; revoked and archived agents take their own branches, so `pending_approval` is the case that reaches Resume. The backend resumes only `paused` agents, so a click returns 404 "Agent not found or cannot be resumed", shown as a toast (read from the code; not clicked in this observe-only run) | always | browser, dev `6b940f31` | `AgentCard.tsx:84, :88, :176, :421, :446, :462`; `agents.ts:860–861`; `routes/agents.ts:570–573` | #3945 | new |
| nit | product | N1: Get started step 3 | Names what is actually blocking | "Set up an agent first to unlock this step", although the agent exists and only needs its budget | always | browser | dashboard text | — | noted |
| nit | product | N2: mobile tab bar at 375px | Labels fit | "Transactions" truncates to "Transacti…" at 375px (iPhone mini/SE). It fits at 390px. | always at ≤375px | mobile emulation | tab-bar label measured as clipped at 375, not at 390 | — | noted |
| nit | product | N3: agent page Activity empty state | An action relevant to this agent | The only action is "Open dashboard" | always | browser | agent page | — | noted |
| nit | product | N4: `/agents` page copy | User-facing copy | The subtitle "Delegation agents use on-chain rules; historical agent records remain readable." and an always-visible "Not recorded means Haven has no MCP server name…" read as internal notes | always | browser | `agents/page.tsx:9`, `McpServerName.tsx:74` | — | noted |

**Harness artifacts, not product findings.** These are recorded so the next run does not re-file them.
- While hidden, the built-in browser pane flips the tab's visibility about every 2 seconds (4 `visibilitychange` events in 8 seconds were measured). Each flip makes `useVisiblePolling` refetch, as designed, so a hidden pane looks like it polls every 2 seconds. In a normal browser the cadence is the hook's default 10 seconds (`VISIBLE_POLL_INTERVAL_MS`; consumers can set their own).
- Screenshots in phone emulation lagged the DOM. A 375px dashboard screenshot showed loading skeletons while `document` already held the loaded text ("0,10 kr", "Test network") and every `/api/*` call had returned 200. Read `document` state before reporting a "stuck loading" screen.

## Cleanup And Residual State

Nothing was written. No control that changes state was submitted:
- the connect modal was closed at step 1;
- "Finish setup", "Set budget", "Resume from pause" and "Remove" were not clicked.

The viewport emulation was reset to desktop.

## Notes For The Coding Agent

- F1 and F2 share a theme: **the UI should name the state the user is actually in**. Neither "never had activity" nor "never paused" was true for this account. Where an enum or a time window drives copy, test the copy against each value of the enum or each side of the window.
- When user B exists, re-run this report's dashboard rows as user B: "Needs attention" mode, the money card's 30-day spending with counts, the agent rows with budgets of mixed periods, and the activity groups. Have the owner read the p95 figures from Railway in the same session.
