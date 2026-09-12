---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/app/manifest.ts
  - packages/frontend/src/components/sidebar/*
  - packages/frontend/src/hooks/useVisiblePolling.ts
last-verified: "2026-09-10"
---

# Mobile demo runbook

Everything needed to put Haven on an iPhone as two installed apps (production
and dev) and run the agent-purchase demo from the phone, written so a
first-time reader can do it without asking anyone. The laptop half of the
presentation — connecting the agent, granting the budget, the Fortnox and SIE
acts — is [`../../operations/demo-agent-purchase-runbook.md`](../operations/demo-agent-purchase-runbook.md);
this document is the phone half and the choreography between the two.

Why `covers` names the sidebar directory rather than a single file: when this
doc was written the bottom tab bar was still unmerged on `feat/2731-mobile-tab-bar`,
and the coupling gate had to implicate this doc when the bar changed without
waiting for this front-matter to learn its final path. #2731 has since landed
(PR #2805) at `packages/frontend/src/components/sidebar/MobileTabBar.tsx`, which
that glob reaches — so the directory form stays, now for the ordinary reason:
every file in it is the phone's primary navigation surface, which is exactly
what checklist rows 2 and 6 attest.

## What you need

- An iPhone with Safari. Any current iOS; record the model and version in the
  device checklist below.
- The demo harness for the agent half: the demo laptop, Claude remote access,
  or a partner driving the agent over Telegram. The agent is already connected
  and holds a budget (demo-agent-purchase-runbook Act 0).
- A Haven account with the credentials in the cloud password manager, ready on
  any device (per #1969).
- Roughly ten minutes of setup the day before, five minutes on stage.

## Install the two apps side by side

Both installs happen from the Safari share sheet. The two apps can coexist
because they differ in origin (two deployments) and in manifest `id`
(`haven` vs `haven-dev`); the shell labels each install with its environment
so the presenter can tell them apart at arm's length.

1. **Production.** In Safari, open `https://haven-ai-frontend.vercel.app`
   (the production alias). Share → Add to Home Screen. The home-screen label
   is "Haven".
2. **Dev.** In Safari, open the branch-tracking preview of the `dev` branch:
   `https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app`
   (the stable hostname recorded in
   [`../operations/dev-environment.md`](../operations/dev-environment.md)).
   Share → Add to Home Screen. The label is "Haven Dev" and the icon carries a
   DEV badge.

The dev install points at the **stable branch alias, never a per-PR preview
URL**. A per-PR preview is a different domain every time, and a different
domain is a different installed app: the phone would accumulate a dead icon
per PR and the session cookie would not follow the alias. If the label under
the icon is not exactly "Haven" or "Haven Dev", the wrong URL was installed —
delete it and start over.

## Sign in (email + password)

There is no passkey login path; sign-in is email and password only.

1. Launch the app from the home screen (not a Safari tab): it opens
   standalone, without browser chrome.
2. Sign in on the login screen by typing the credentials or letting the cloud
   password manager autofill them.
3. The session persists across launches — force-quit the app, reopen it, and
   the dashboard is there without signing in again. If it is not, the sign-in
   happened in a Safari tab instead of the installed shell.

Sign in on both installs if the demo will show both.

## The demo sequence

1. **On the phone:** open the installed shell and show the agent — its
   passport and verification status, its budget, and the supporting detail
   (recent activity, holdings) the room should have in view.
2. **At the harness:** tell the agent to buy from the demo merchant (the
   example prompt and product names are in
   demo-agent-purchase-runbook Act 1 — e.g. NordShield VPN Basic). The hosted
   MCP is keyless and cannot sign from a phone: the agent pays from the
   harness with its own delegate key.
3. **The user picks the product.** The agent proposes the purchase and the
   choice happens on the phone, in the installed shell.
4. **Go-ahead in chat.** The approval is granted and the agent completes the
   purchase on-chain, inside the already-granted budget.
5. **The payoff, no refresh.** The purchase lands on the phone on its own.
   The dashboard screens poll only while visible (#2732, shipped in `dev` as
   `3f9ba290`), so the completed purchase is on screen the moment the phone
   shows it — nobody touches pull-to-refresh, and narrate that: the phone
   found out by itself.

## Why the phone never signs

The standard demo has the phone sign nothing. The agent pays inside a budget
the owner already granted, with the agent's delegate key, and the on-chain
allowance module is what enforces the ceiling. That is the story: an agent
gets a budget, not a wallet.

The budget-change variant is different: granting or raising a budget is an
owner action, and from the installed shell it is signed with the owner
passkey from the cloud password manager. That ceremony is a device-verify
acceptance criterion of its own — it is checked on the #2729 device checklist,
and the row below records it for the demo phone.

## What the screenshot harness proves, and what only a phone can

`npm run screenshot` prints an "Installed-shell metadata check" every run: it
fetches `/manifest.webmanifest` and the root document and compares the
identity keys (`id`, `name`, `display`, `start_url`, `scope`) and the iOS meta
tags against what the app source declares, failing the run on a drift. That is
the headless half. What Playwright structurally cannot see is the rest of this
page: two installs, standalone launch, login persistence, the passkey
ceremony, viewport-fit compositing on a real notch, the tap targets as
physical points, and the no-refresh payoff. Those live in the device
checklist below, filled in by the operator the way the harness fills in its
capture manifest.

## Device checklist

One row per check, filled in on the demo phone. The "first end-to-end run"
row is the epic's first full pass; it ships as `pending-operator` until
someone runs this on a real iPhone.

| # | Check | iPhone model | iOS version | Date | Tester | Result |
|---|---|---|---|---|---|---|
| 1 | Both installs side by side from the share sheet, labels "Haven" and "Haven Dev", icons distinguishable | iPhone 12 | iOS 26.6.1 | 2026-09-10 | @d-hinders | **blocked** — prod serves no manifest until the `dev → main` promotion, so a prod install today yields a Safari stub. Dev half verified (label "Haven Dev", badged icon) on the #2729 pass. |
| 2 | Standalone launch: no Safari chrome, status bar reads as part of the app | iPhone 12 | iOS 26.6.1 | 2026-09-10 | @d-hinders | **pass** |
| 3 | Sign-in by email + password, autofilled by the cloud password manager inside the installed shell | iPhone 12 | iOS 26.6.1 | 2026-09-09 | @d-hinders | **pass** — carried from the #2729 device pass |
| 4 | Login persists: force-quit and relaunch lands on the dashboard, no sign-in | iPhone 12 | iOS 26.6.1 | 2026-09-09 | @d-hinders | **pass** — carried from the #2729 device pass |
| 5 | Viewport fit: nothing renders under the notch or the home indicator, portrait and landscape | iPhone 12 | iOS 26.6.1 | 2026-09-10 | @d-hinders | **pass**, both orientations. Portrait: chrome sits below the status bar, and at scroll end the last card rests ~20pt above the tab bar with its content gutter intact. Landscape: content inset ~47pt from both bezels, matching the device notch inset. Settles the open question from #2730 — iOS **does** report a non-zero `safe-area-inset-top` under `apple-mobile-web-app-status-bar-style: default`, so the top-inset rules are live, not inert. |
| 6 | Tap targets as physical points: sidebar toggle and every MobileTabBar item land in their intended 44px areas | iPhone 12 | iOS 26.6.1 | 2026-09-10 | @d-hinders | **pass** — all five slots navigate, including taps near the bottom edge; no slot press was swallowed by the iOS home-indicator swipe. |
| 7 | Demo end to end: agent told to buy at the harness, product picked and go-ahead on the phone, purchase lands with no refresh | iPhone 12 | iOS 26.6.1 | 2026-09-10 | @d-hinders | **pass**, both halves. Three x402 purchases of 0.001 USDC from `services.sandbox.ampersend.ai/api/joke` on Base Sepolia, driven through the real agent path (quote → local sign → relay → merchant retry). Foreground: row appeared unaided, "just now", no interaction. Backgrounded: app closed at the home screen during the purchase, and on reopen the row was **already present** — the visibility handler fires an immediate fetch on return rather than waiting out the 10s interval. No spinner or skeleton flashed over the balance, the stat cards or the list in either half, and the page held its scroll position — the refetch is silent, which is the qualifier that separates "appears without a refresh" from "appears acceptably". Evidence below. |
| 8 | Budget-change variant: passkey ceremony from the installed shell completes (per #2729 device checklist) | iPhone 12 | iOS 26.6.1 | 2026-09-09 | @d-hinders | **pass** — carried from the #2729 device pass, on an account the phone had never seen |
| 9 | First end-to-end demo run for epic #2736 | iPhone 12 | iOS 26.6.1 | 2026-09-10 | @d-hinders | **partial** — every phone-side behaviour the epic claims is verified (rows 2–8). Outstanding: row 1, which needs the promotion, and a full rehearsal with the laptop-side acts of the demo script. |

### Row 7 evidence — the 2026-09-10 payoff run

Three x402 purchases from `https://services.sandbox.ampersend.ai/api/joke`, 0.001 USDC each,
agent `devtest` (`4256cb9a-0a10-4a41-beb3-9b10b73a65fb`) on Base Sepolia, delegation rail,
EIP-3009 bridge (the merchant advertises no `extra.assetTransferMethod`, so the erc7710 path
does not apply). Budget 4.00 USDC/day, unpinned recipient; ~3.997 remaining after the run.

| # | Funding tx | What it tested | Result |
|---|---|---|---|
| 1 | `0x915b06a0876079744362f8ed617fb6b7872825bae894865d9de4d140bd05fb7a` | Foreground: dashboard open, phone untouched | Row appeared unaided, "just now" |
| 2 | `0xd29761b6e1faef41e32594cb046600d8f66180f175213b008089db103e5d740a` | Intended as the backgrounded run | **Void** — the app was still foregrounded when it fired; recorded rather than dropped, so the trail matches what happened |
| 3 | `0xec59861d7544367342625d766bce1613de9ae12473a66d2ad18e705357f095a3` | Backgrounded: app closed at the home screen, reopened after the purchase | Row already present on reopen — immediate fetch on return, not a delayed interval tick |

Observed across both halves: no loading skeleton or spinner replaced good data during a silent
tick, and scroll position was preserved. That is the behaviour `useVisiblePolling` and the
per-hook `silent` paths are built for, and it is only checkable by watching a real screen.

All three merchant legs returned HTTP 200 with `paid: true`, and all three were recorded via
`haven_report_x402_outcome`, each reaching `phase: payment_confirmed` / `next_action: none`.
No stranded delegate balance resulted, so no sweep was needed.

What this run does **not** cover, since the operator drove the agent from a session rather than
from the demo harness: the laptop-side choreography of the demo script itself (Acts 0–3 of
`../../operations/demo-agent-purchase-runbook.md`). The phone-side claim — a purchase landing
with no manual refresh — is what row 7 asserts, and that is verified.

## Troubleshooting

- **Home-screen label is neither "Haven" nor "Haven Dev".** A per-PR preview
  URL was installed instead of the branch alias. Delete the icon, reinstall
  from the stable hostname.
- **Sign-in asked again after a relaunch.** The credentials went into a
  Safari tab, not the installed shell. Sign in from the home-screen icon.
- **The purchase never lands on the phone.** The phone is showing a different
  environment than the agent is connected to (prod app against a dev agent).
  Check the DEV badge on both halves before the run.
- **The screen shows stale data after the purchase.** Confirm nobody disabled
  polling; the screens poll while visible (#2732). Foregrounding the app is
  enough — a manual refresh is never part of the demo.
