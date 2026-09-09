---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/app/manifest.ts
  - packages/frontend/src/components/sidebar/*
  - packages/frontend/src/hooks/useVisiblePolling.ts
last-verified: "2026-09-09"
---

# Mobile demo runbook

Everything needed to put Haven on an iPhone as two installed apps (production
and dev) and run the agent-purchase demo from the phone, written so a
first-time reader can do it without asking anyone. The laptop half of the
presentation — connecting the agent, granting the budget, the Fortnox and SIE
acts — is [`../../operations/demo-agent-purchase-runbook.md`](../operations/demo-agent-purchase-runbook.md);
this document is the phone half and the choreography between the two.

Why `covers` names the sidebar directory rather than a `MobileTabBar.tsx`
file: the bottom tab bar lands with #2731 (branch `feat/2731-mobile-tab-bar`,
unmerged at last-verified), and the coupling gate must implicate this doc when
the tab bar changes without waiting for this front-matter to learn its final
path. Every file in that directory is the phone's primary navigation surface,
which is exactly what checklist rows 2 and 6 attest.

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
| 1 | Both installs side by side from the share sheet, labels "Haven" and "Haven Dev", icons distinguishable | | | | | |
| 2 | Standalone launch: no Safari chrome, status bar reads as part of the app | | | | | |
| 3 | Sign-in by email + password, autofilled by the cloud password manager inside the installed shell | | | | | |
| 4 | Login persists: force-quit and relaunch lands on the dashboard, no sign-in | | | | | |
| 5 | Viewport fit: nothing renders under the notch or the home indicator, portrait and landscape | | | | | |
| 6 | Tap targets as physical points: sidebar toggle and every MobileTabBar item land in their intended 44px areas | | | | | |
| 7 | Demo end to end: agent told to buy at the harness, product picked and go-ahead on the phone, purchase lands with no refresh | | | | | |
| 8 | Budget-change variant: passkey ceremony from the installed shell completes (per #2729 device checklist) | | | | | |
| 9 | First end-to-end demo run for epic #2736 | | | | | pending-operator |

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
