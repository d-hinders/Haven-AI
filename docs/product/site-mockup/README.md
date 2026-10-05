---
owner: "@d-hinders"
status: current
covers: []  # narrative — reference material for epic #3572; the files describe a design, not code
last-verified: "2026-10-05"
---

# Public site mockup

The approved design for Haven's redesigned public website, epic
[#3572](https://github.com/d-hinders/Haven-AI/issues/3572). Committed by
[#3573](https://github.com/d-hinders/Haven-AI/issues/3573) from the published
artifact <https://claude.ai/artifact/FNkZUEMVuT2Hz4Fdccoii6> (Version 15), and
from that commit on, **this committed copy is the spec**.

| File | Page |
|---|---|
| `index.html` | Home |
| `how-it-works.html` | How it works |
| `protocols.html` | How it works › Protocols |
| `developers.html` | For developers |
| `for-agents.html` | For agents |
| `signin.html` | Sign in |
| `signup.html` | Sign up |
| `site.css` | The shared stylesheet |

## Committed as approved

The eight files are byte-identical to the artifact the spec review checked, and
are **not edited** to match later decisions: the slices cite their line
numbers, so an edit here would move every citation. Confirm with
`shasum -a 256` over the eight files against the list in #3573.

They are reference material, not served by the app. They load fonts from Google
Fonts and link to each other by relative path, so open them straight from disk.
The app self-hosts its fonts through `next/font`.

**The mockup's own notes section is stale** (`index.html`, the "Mockup notes"
block near the end). It says the marketing surface stays light-only; the build
is light and dark, following the visitor's theme. Where the notes, or any page,
disagree with the table below, the table wins.

## Decided deviations

Reproduced from the epic. The build follows the right-hand column.

| Mockup shows | Build |
|---|---|
| Light design only; its notes section says "light-only" | Light and dark (decision 7). The notes section is stale. |
| Contact, Privacy, Terms, About in the footer; "Talk to the founders" on the home page | Removed (decisions 8, 9) |
| "API reference", "Security model", "Open /for-agents.md" as `#` links | `/api/openapi.json`, `/docs/security-model.md`, `/for-agents.md` |
| Sign-up with three fields, "At least 12 characters" and "your account is created on Base" | The real form: four fields, 8-character minimum; no chain named, since sign-up provisions every supported chain (slice 6) |
| "Claude, ChatGPT or your own harness" on the home page and How it works | "Claude, Codex, Cursor or any other agent harness" (decision 13) |
| For agents headline "pay with a budget, not a wallet" | "pay with a budget, not a credit card" (decision 14) |
| `npx @haven_ai/connect` in the home page terminal | A short storytelling script: the published prefix `npx -y @haven_ai/connect@alpha` verbatim, a `…` for the flags left out, and illustrative output lines short enough never to scroll sideways (owner decision 2026-10-05, #3644; slice 2 first showed the full working command and real connector output) |
| Snippets without `--api` | Commands in their published, working forms (slices 4, 5) |
| "Haven relays sign_hash 0x8b2f…" in the protocols flow | The agent signs the typed data; no bare hash is shown (slice 4) |
| `EXAMPLE-SETUP-TOKEN` on For agents | The runbook's `EXAMPLE-SETUP-TOKEN-NOT-REAL` (slice 5) |
| "© 2026 Haven" in every page's footer | "© {year} Haven Labs" (decision 16, #3586) |

The epic's owner decisions (navigation, protocols, MPP status, fonts, rollout)
are on #3572 and are not restated here. How the build implements the design —
section grounds, type roles, the product frame and the site gate — is in
[`design-system.md` § Public site](../design-system.md#public-site).
