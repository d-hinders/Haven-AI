---
description: "AI-driven browser exploration of the dev dashboard — drives a real browser via Playwright MCP over a deployed frontend pointed at the shared dev backend, hunting UX/layout/console/secret-leak issues, and writes a docs/bug-reports/ findings report. Non-gating (Layer 3, #579); read-oriented, testnet/dev-only."
---

Run an exploratory **UI** QA pass as the agent, using **this session's own model** (no separate API key), driving a **real browser** over the **dev dashboard**. This is **Layer 3** of the QA epic (#573): agentic coverage of the UI itself — layout breakage, confusing states, dead ends, overflow, console errors, and secret leakage that fixed-selector tests miss. It is **non-gating** (exploration, not a deploy gate) and **read-oriented** (no money movement beyond what the existing testnet QA flows already cover).

**Safety:** dev/testnet only (Base Sepolia), signed in as the seeded **QA user** — never a real user, never prod. Follow the report's secret-safety rule: never paste JWTs/cookies, setup tokens, API or private keys, or `Authorization` headers into the report or artifacts.

## Phase 1 — Point at a target & attach the browser driver

1. **Target URL** — a **non-production** Vercel deployment (a PR preview or the dev project). It must build with `NEXT_PUBLIC_HAVEN_ENV=dev`, or the `?apiBaseUrl` override is a no-op (production ignores it — the #582/#583 security gate). There is **no permanent dev frontend URL**; take it as input. If you don't have one, stop and ask.
2. **Re-point at the shared dev backend** by appending `?apiBaseUrl=https://havenbackend-dev-8b95.up.railway.app` to the URL (persists to `localStorage['haven_api_base_url']`). See `docs/operations/agent-qa.md` → "Stable dev targets".
3. **Attach Playwright MCP** — reuses the Playwright/Chromium setup when the sandbox already has it; otherwise Playwright MCP manages its own browser:
   `claude mcp add playwright -- npx @playwright/mcp@latest`
   Confirm with `claude mcp list` (`playwright` connected). Any browser-driving MCP with equivalent navigate/snapshot/console tools is fine.

## Phase 2 — Establish the dev QA session (do not skip)

4. Navigate to the target URL (with `?apiBaseUrl`) and sign in as the **seeded QA user** (`QA_USER_EMAIL` / `QA_USER_PASSWORD`, owner-provisioned — see `docs/operations/agent-qa.md` "QA identity, funding & secrets"). If you lack them, stop and ask; do not invent credentials.
5. Confirm you are on the intended stack before exploring: the **`DEV` badge** renders (confirms `NEXT_PUBLIC_HAVEN_ENV=dev`) and the dashboard shows **real** dev data, not fixtures. If the app is pointed at the wrong backend or shows a prod build, **stop and report** — do not explore an unexpected environment.

## Phase 3 — Explore the surfaces (the brief)

**Observe only — do not submit state-changing actions.** This layer looks, it doesn't act. Navigate, open, scroll, and inspect, but do **not**: complete the connect-agent flow / generate a credential, Approve or Reject in the approvals queue, or Send/Confirm a payment. The dev QA identity is shared with the deterministic harness and Layer 2b (#577); a stray submit here mutates state other runs depend on. Record what you observe per surface — including flows a scripted test wouldn't try, short of actually submitting them.

6. **Surfaces to visit:** dashboard (balances), transactions list + the transaction **detail panel**, agents list + the **connect-agent modal** (open it; do not complete it), and **approvals** (view; do not approve/reject).
7. **What to look for on each:**
   - **Broken layout / horizontal overflow** — the existing `expectNoHorizontalOverflow` helper (`packages/frontend/e2e/fixtures/haven-api.ts`) is the invariant to reproduce by eye: no horizontal scrollbar at standard widths.
   - **Secret leakage** — no private key, API key, JWT, or setup token ever rendered in the UI (especially the connect-agent setup prompt — reuse the "no-secret-leak" expectation from the mocked suite).
   - **Console errors / failed requests** — capture the browser console and network panel; a red console on a real deploy is a finding.
   - **Dead ends & confusing states** — buttons that go nowhere, empty states with no next step, ambiguous loading/error states.
   - **Money & authority clarity** — for any screen that moves money or changes agent authority, check it answers the AGENTS.md "Money And Risk Clarity" questions: who can spend, from which Haven wallet, how much, on what/for whom, when approval is required, what happened already, and how to pause/revoke/stop.
8. **Visual capture (optional):** screenshot key screens (dashboard, transaction detail, connect modal, approvals) for a visual-diff baseline across runs. Save under the Playwright artifact paths; review artifacts for secrets before committing.

## Phase 4 — Report

9. Copy `docs/bug-reports/_run-report-template.md` to a unique UTC/run-id path such as `docs/bug-reports/2026-07-01T143022Z-browser-exploration-dev.md`.
10. Fill in run metadata (mode = browser exploration, the frontend URL/build SHA, runtime/browser), the surfaces visited, and every finding in the **Friction, Bugs, And Infrastructure Failures** table (severity, surface, expected vs actual, reproducibility, evidence). Complete the secret review before committing the report or any screenshots.
11. File each concrete UI bug as its own issue and link it from the report. Leave **Notes for the coding agent** with UX gaps worth feeding back.

The findings report (not a pass/fail check) is the deliverable — this layer's value is the UX and visual friction it surfaces, and it never blocks a promotion.
