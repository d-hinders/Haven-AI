# 2026-10-19 — "approve, not sign" on the public site and the CLI

**Perimeter: unchanged.** Copy only. Follows #4049, which applied the owner's
2026-10-16 rule — the owner approves a money action, only an agent's key
signs — across the app and recorded it in `docs/product/copy-guidelines.md`.

## What changed

- **Public site** (`components/marketing/site/`): the home page now reads
  "Nothing spends without your approval", How it works "You approve it once,
  it refills itself, and you can stop it at any time", and For agents "The
  budget is a delegation they approve, enforced on-chain". The home page's
  step-card mock keeps its "Signing…" state (owner decision: an illustration
  of the passkey prompt, not a claim).
- **CLI** (`packages/cli/src/commands.ts`): `haven budget grant` and `haven
  budget revoke` print "Open this link and approve …", "Waiting for your
  approval …", "Approved and active." and "The budget keeps working until you
  approve …".

## Why the perimeter is unaffected

No authority moves and no custody claim changes. The owner still authorises
every budget with their own passkey or wallet; "approve" names that act and
does not attribute it to Haven — every changed sentence keeps the owner as
the subject ("your approval", "you approve", "they approve"). The CLI still
never signs: it prints a dashboard link the owner opens, exactly as before.
The non-custody statements on the same pages ("not their wallet, and not a key
to their funds", "Haven constructs and relays the payments") are untouched,
and the agent-readable runbook (`public/for-agents.md`, bundled by the CLI
and SDK) is not changed by this diff. Tests: the how-it-works page test and
the CLI `budget grant` test pin the new wording.

Perimeter unchanged.
