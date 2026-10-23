---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/components/marketplace/MerchantGrid.tsx
  - packages/frontend/src/components/marketplace/OffersTable.tsx
  - packages/frontend/src/components/marketplace/OfferRow.tsx
  - packages/frontend/src/components/marketplace/OfferInstruction.tsx
last-verified: "2026-10-15"
---

# QA run report — browser exploration — marketplace UX pass (epic #3978) — dev

> **Secret-safety rule:** Never paste private keys, API keys, JWTs/cookies,
> setup tokens or token-bearing prompts, credential files, Authorization
> headers, or secret-bearing logs. Record safe prefixes only where necessary,
> plus public addresses, payment IDs, transaction hashes, sanitized URLs, and
> redacted artifacts. Confirm artifacts were checked for secrets before commit.

## Run Metadata

- **Run mode:** browser exploration (`qa-explore-ui`, observe-only)
- **Flow/scenarios:** epic #3978 product verification. Covered `/marketplace` (the grid) and `/marketplace/ampersend-demo-api` (the merchant page), at 1280 px and 390 px, in light and dark.
- **Started / finished (UTC):** 2026-10-15 ~18:05 / 18:33
- **Runner:** Claude Code session (Claude Opus 5.5), driving the Claude desktop app's built-in browser pane. That is a browser-driving tool with navigate, DOM, console and network reads, which the skill allows in place of Playwright MCP.
- **Exact command:** `/qa-explore-ui` (scope: epic #3978)
- **Process exit code:** n/a (interactive)
- **Git branch / SHA:** `docs/3978-qa-explore-ui` / report written at dev `355af0718`
- **Frontend URL / build SHA:** `haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app` (the stable `dev` preview) / not exposed by the page. It serves a build that includes PR #4001 (`e47bddcaf`), because the labelled "Copy instruction" button and the one-row offers were present. It very likely also includes PR #4007 (#4004); see the budget-hint row.
- **Backend URL / deploy SHA:** `havenbackend-dev-8b95.up.railway.app`, through the `?apiBaseUrl` override, with requests proxied as same-origin `/api/*` / not checked
- **Merchant URL / version:** `services.sandbox.ampersend.ai` (listing data only; no payment made)
- **Chain:** Base Sepolia (`84532`), the default network
- **Runtime/browser:** Chromium in the Claude desktop browser pane; viewports emulated at 1280×800 and 390×844, with `prefers-color-scheme` emulated light and dark
- **Package versions:** n/a (no agent connection in scope)
- **CI workflow/run:** n/a
- **Public QA identity:** a dev dashboard user signed in by the owner in the browser pane. The account is on Base Sepolia. No email is recorded (public repo).
- **Overall result:** pass with friction
- **Completeness:** 8/8 views passed · 0 failed · 0 skipped. The views were grid × {1280, 390} × {light, dark} and merchant page × {1280, 390} × {light, dark}.

## Preflight

- [x] Dev/testnet only. The `DEV` badge rendered, and the data was real dev data, not fixtures (11 Haven demo store offers, Redpine and Berget AI as coming soon).
- [x] Correct frontend and backend targets confirmed (the stable `dev` host plus the dev backend override). n/a: hosted MCP and merchant payment.
- [ ] n/a: wallet balance and remaining budget. Observe-only; no money movement.
- [ ] n/a: relayer gas.
- [ ] n/a: delegate balance.
- [x] No secrets read. The owner signed in; the session never typed or read a credential.

## Command And Artifacts

- **Command output summary:** 8 views explored. Measured layout with in-page DOM reads (document and `<main id="main-content">` scroll boxes, cell positions). Read console errors and the network list.
- **Playwright base URL / project / retries:** n/a (Claude browser pane, not Playwright)
- **Artifacts:** screenshots viewed in-session only; none committed.
- **Artifact secret review completed:** yes. This report holds no tokens, cookies, emails or credentials. The network list was read for status codes only, and `_rsc` values were already redacted by the tool.

## What was verified (the epic's acceptance, on the live build)

| Check | Result | Evidence |
|---|---|---|
| Grid: search with a leading icon and the network dropdown on one row (two stacked rows at 390 px), then pills and checkboxes | pass | rendered at 1280 and 390, both themes |
| Grid: the network filter defaults to the user's network | pass | `Filter marketplace by network` value `84532` on load |
| Grid: merchants with no network (coming soon) stay visible under the filter | pass | Berget AI and Redpine listed under Base Sepolia, sorted after the payable merchants |
| Grid: no "Test-fixture" pill; "Show test merchants" kept | pass | pills: All, AI, API, Data, Media, Search, Storage |
| Grid: the seller note replaces the toolbar button | pass | "Sell an API or MCP tool? … — List your service" below the cards |
| Grid: card shows a "From … USDC" footer and a quiet verified check | pass | "From 0.001 USDC · 6 offers", check icon |
| Merchant page: one row per offer, no "Pay https://…" row | pass | no `Pay https://` text in the rendered page before a copy |
| Merchant page: user's network first, the rest behind "Other networks (3)" | pass | 3 Base Sepolia offers shown; 3 Base offers in the disclosure |
| Merchant page: labelled "Copy instruction", name "Copy instruction for <offer>" | pass | accessible names read from the DOM |
| Merchant page: clipboard refused, so the prompt is revealed in place | pass | the browser pane blocks clipboard writes; clicking the button printed "Pay https://services.sandbox.ampersend.ai/api/fact and return the result" with "Copying was blocked — select the instruction above to copy it." |
| Merchant page: the meta line keeps the freshness and truncates only the URL | pass | at 390 px, "services.sandbox.ampersend.ai/api… · verified just now" |
| One plain-language payment note, no "EIP-3009" / "unpinned" | pass | the any-recipient note renders once; no protocol jargon |
| No horizontal overflow | pass | document and `<main>` scroll boxes equal client width in all 8 views |
| No secrets rendered | pass | no keys, tokens or credentials on either surface |
| No app console errors or failed API requests | pass | all `/api/*` calls 200; see the infrastructure row below for the only console output |

## Friction, Bugs, And Infrastructure Failures

| Severity | Type | Step/scenario | Expected | Actual | Reproducibility | Mode/environment | Evidence | Issue | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| minor | product | Grid: category pills under the default network | Pills offer only categories that can match on the selected network, or a pill's empty result says why | "Media" and "Search" pills show under Base Sepolia, but every merchant in them is Base-only. Clicking one gives "No merchants match this filter". The pills are built from all merchants, ignoring the network filter | always | dev, 1280 and 390 | `cards: 0` after clicking "Media" with the network on Base Sepolia | #4008 | new |
| minor | product | Merchant page: "Other networks (3)" opened at 1280 px | Nested offers line up with the outer table | The nested table is a separate table with its own column widths. Cell left edges are outer 273/744/889/1022 vs nested 289/737/898/982, and the Copy button's right edge is 1231 vs 1215 | always | dev, 1280, dark | measured cell rects after opening the disclosure (the review flagged this as not captured) | #4008 | new |
| nit | product | Price formatting across surfaces | One number format on Haven surfaces | Both surfaces say "0.001 USDC" on dev (the card prefixes "From"), but the formatters differ on trailing zeros: the card's `formatTokenAmount` gives "0.1", the backend `price_display` gives "0.10". The merchant's own description says "$0.001 USDC", which is merchant data and out of scope. The frontend test fixtures still carry the pre-migration-062 `$` shape | always | dev + code | rendered text; spec review on #4008 | #4008 | new |
| nit | product | Verified marker | One treatment | The grid card uses the quiet check (#3980), while the merchant page header still shows the uppercase "VERIFIED" badge | always | dev | rendered | #4008 | new |
| nit | product (data) | Haven demo store card | The test-merchant note appears once | The card prints the note, then a description that starts with the same sentence | always | dev | card text | #4002 Notes | known |
| nit | product (data) | Offer names | The name does not repeat the Network column | "Ampersend — fact (Base Sepolia)" | always | dev | row text | #3998, out of scope | known |
| info | product | Merchant page budget hint | n/a | No per-offer budget answer showed for this user. The build very likely included #4004 (PR #4007, merged 17:58Z, about 7 minutes before this run): the merchant-page load requested `GET /api/dashboard/budget-remaining`, which the merchant page reads only since #4007 (`[slug]/page.tsx` `useBudgetRemaining`). Not confirmed, because other parts of the shell may make that call. Under #4007 the answer comes from `agentsThatCanPay` / `budgetAnswerLine`, which render nothing when no answer is a known yes or no, consistent with a user who has no matching live budget | always | dev | rows render with no answer line; network list | #4004 (shipped) | known |
| info | environment | Console | No app errors | The only console errors are the Vercel preview toolbar's report-only CSP warnings ("Framing 'https://vercel.live/' violates … report-only …"), plus aborted Vercel toolbar and prefetch requests (`/.well-known/vercel/jwe`, `OPTIONS /`, `HEAD`) | always on preview hosts | dev preview | console and network list | n/a | preview noise, not the app |
| info | environment | Clipboard | n/a | The embedded browser pane refuses `navigator.clipboard.writeText`, which is what exercised the reveal path above | always in this runner | Claude browser pane | reveal rendered | n/a | — |

## Cleanup And Residual State

- [x] n/a: no stranded delegate funds. No payment was made.
- [x] n/a: balances and budget. Observe-only.
- [x] No seed or reset needed: nothing was written. The only interactions were a category pill, the "Other networks" disclosure and one copy button (a clipboard write, refused).
- [x] Secret review passed.

## Notes For The Coding Agent

- The two minor findings and the two price/verified nits are filed together as #4008. They share the marketplace surface, so they are batched per new-task § Epics.
- The merchant-page buying journey that this run makes visible (no "how to buy", a budget hint that showed this user nothing, generic copy) is already filed as epic #4002 (#4003, #4004, #4005).
- To see the per-offer budget answer (#4004, shipped) on dev, the QA identity needs an agent with a live USDC budget on Base Sepolia. Seed one before epic #4002's promotion-checklist run, which calls for "a signed-in user with one connected agent and a budget".
