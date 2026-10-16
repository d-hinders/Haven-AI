---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/components/marketplace/HowToBuyPanel.tsx
  - packages/frontend/src/components/marketplace/MerchantHeader.tsx
  - packages/frontend/src/components/marketplace/OffersTable.tsx
last-verified: "2026-10-16"
---

# QA run report — browser exploration — merchant buying journey (epic #4002) — dev

> **Secret-safety rule:** Never paste private keys, API keys, JWTs/cookies,
> setup tokens or token-bearing prompts, credential files, Authorization
> headers, or secret-bearing logs. Record safe prefixes only where necessary,
> plus public addresses, payment IDs, transaction hashes, sanitized URLs, and
> redacted artifacts. Confirm artifacts were checked for secrets before commit.

## Run Metadata

- **Run mode:** browser exploration (`qa-explore-ui`, observe-only)
- **Flow/scenarios:** epic #4002 product verification. Covered `/marketplace/ampersend-demo-api` at 1280 px and 390 px in light and dark, as a signed-in user with a connected agent and a budget. Also covered `/marketplace/haven-demo-store` at 1280 and 1024 px for the header action and a mixed-width check.
- **Started / finished (UTC):** 2026-10-16 ~07:50 / 08:06
- **Runner:** Claude Code session (Claude Opus 5.5) driving the Claude desktop app's built-in browser pane. The skill allows any browser-driving tool with navigate, DOM, console and network reads.
- **Exact command:** `/qa-explore-ui` (scope: epic #4002 promotion checklist)
- **Process exit code:** n/a (interactive)
- **Git branch / SHA:** `docs/4002-qa-explore-ui` / report written at dev `d04617e82`
- **Frontend URL / build SHA:** `haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app` (the stable `dev` preview) / not exposed by the page. The build includes #4003, #4004, #4005 and #4008: "Copy prompt", the named per-offer answers, the "How to buy" panel and the aligned "Other networks" table were all present.
- **Backend URL / deploy SHA:** `havenbackend-dev-8b95.up.railway.app`, proxied as same-origin `/api/*` / not checked
- **Merchant URL / version:** `services.sandbox.ampersend.ai` and the Haven demo store (listing data only; no payment made)
- **Chain:** Base Sepolia (`84532`)
- **Runtime/browser:** Chromium in the Claude desktop browser pane; viewports emulated at 1280×800, 1024×800 and 390×844, with `prefers-color-scheme` emulated light and dark
- **Playwright base URL / project / retries:** n/a (Claude browser pane, not Playwright)
- **Package versions:** n/a (no agent connection exercised)
- **CI workflow/run:** n/a
- **Public QA identity:** a dev dashboard user signed in by the owner in the browser pane (no email recorded; public repo). The account is on Base Sepolia with two agents:
  - **"Delegate":** active, with a 2.00 USDC per-day budget that can pay anyone ("Enforced on-chain" on `/agents`).
  - **"Del 2":** "Needs setup", no budget.
- **Overall result:** pass with friction
- **Completeness:** 4/4 required views passed (Ampersend × {1280, 390} × {light, dark}) · 0 failed · 0 skipped. There were two extra checks (demo store at 1280 and 1024).

## Preflight

- [x] Dev/testnet only (`DEV` badge; real dev data).
- [x] Correct frontend and backend targets.
- [x] Remaining live budget recorded: Delegate showed "2 USDC left of 2 USDC today". Wallet balance not recorded (observe-only).
- [ ] n/a: relayer gas, delegate balance.
- [x] No credentials read or typed. The owner signed in.

## Command And Artifacts

- **Command output summary:** In-page DOM reads covered the panel text, the per-offer answers, the hairline rects against the card, the gap between each step title and its divider, the header column widths, and overflow of the document and `<main id="main-content">`. Console and network lists were also read.
- **Artifacts:** screenshots viewed in-session only; none committed.
- **Artifact secret review completed:** yes. No emails, tokens or credentials appear. Account and delegate addresses are deliberately not recorded.

## What was verified against the user's real state

| Check | Expected (from `/agents`) | Result | Evidence |
|---|---|---|---|
| Step 1 "Connect an agent" | done, names the one active agent; the agent that needs setup does not count | pass | "✓ Connect an agent — Delegate is connected on Base Sepolia." |
| Step 2 "Give it a budget it can spend here" | done, names Delegate and its remaining amount, open budget | pass, with friction | "Delegate has 2 USDC left of 2 USDC today, and can pay anyone — so it can pay Ampersend Demo API for some offers." "For some offers" is misleading: see the findings |
| Step 3 "Ask your agent to buy" | names Delegate as the paste target | pass | "…paste it into Delegate's chat…" |
| Per-offer answers, user's network | Delegate can pay each 0.001 USDC offer | pass | all 3 Base Sepolia rows: "Delegate can pay this", desktop and phone |
| Per-offer answers, other network | nobody can pay Base offers | pass | the 3 Base rows: "No agent can pay this yet"; the disclosure: "3 more on Base — none of your agents can pay on that network" |
| Header action on Ampersend | none (no ERC-7710 pay-to) | pass | no "Set a budget for this merchant" |
| Copy action | "Copy prompt", full width on phone | pass | button text; 316 px wide at 390 px |
| "Other networks" alignment (#4008) | columns line up | pass | outer and nested cells at 273/748/894/1028 vs 274/748/894/1027 px |
| Overflow | none | pass | the document and `<main>` scroll boxes equal client width in all views |
| Requests / console | no failures / no app errors | pass | every `/api/*` request returned 200, including `/dashboard/budget-remaining`, `/merchants/{slug}/budgets` and `/agents`. The only console errors are Vercel's preview-toolbar report-only CSP warnings |

## Friction, Bugs, And Infrastructure Failures

| Severity | Type | Step/scenario | Expected | Actual | Reproducibility | Mode/environment | Evidence | Issue | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| minor | product | "How to buy" panel, 1280 px | dividers within the card; padding above step titles | Each step hairline overshoots the card by 3 px on both sides (rect insets −3/−3), and each step title sits 1 px below its divider. The padding problem also shows at 390 px | always | dev, 1280 and 390 | rect measurements | #4014 | known (in flight) |
| minor | product | Step 2 wording | "so it can pay <merchant>" when every offer on the agent's network is payable | "…for some offers": the panel's `partial` counts the Base offers, which the agent's account can't reach. Same on the demo store (5 of 5 Base Sepolia offers payable) | always | dev | step-2 text vs the per-offer answers | #4015 | new |
| minor | product | Step 2 length | one statement of the budget rule | With an open budget, step 2 adds "A budget limited to one recipient can't pay … — keep the budget that can pay anyone open." after already saying "can pay anyone". Six lines at 390 px | always | dev, 390 | screenshot | #4015 | new |
| minor | product | Merchant header, 1024 px (demo store) | the name and description keep most of the width | With "Set a budget for this merchant" and its helper line on the right, the text column measured about 262 px and the description ran 4 lines. The owner saw the same at about 920 px | always at mid widths when the action shows | dev, 1024 | measured column width | #4015 | new |
| question | product | Header action on the demo store | owner to decide | "Set a budget for this merchant" shows although Delegate's open budget already pays every Base Sepolia offer there. The panel deliberately doesn't offer it in that case, because a locked budget wins over the open one and could lower what the agent may spend | always | dev | header vs step 2 | #4015 (owner question) | open |
| info | environment | Console | no app errors | Vercel preview toolbar CSP report-only warnings only | always on preview hosts | dev preview | console | n/a | preview noise |

## Cleanup And Residual State

- [x] n/a: no payment, no state written. Interactions were limited to opening the "Other networks" disclosure.
- [x] Seed for next runs: this identity stays usable for "connected agent with a budget" checks while Delegate's budget is live.
- [x] Secret review passed.

## Notes For The Coding Agent

- The budget answers are right where it matters: every row names the agent and matches its live remaining budget and network. The friction is wording and layout.
- #4014 (panel layout) is building now. #4015 should follow it, because both touch `HowToBuyPanel.tsx`.
