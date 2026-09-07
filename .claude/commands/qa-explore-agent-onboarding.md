---
description: "Cold-agent onboarding scenario — a fresh agent with no repository access is given a Haven URL and 'set it all up so my agent can pay for things'. Scores four things against the A0 baseline and writes docs/bug-reports/qa-explore-agent-onboarding-<date>.md. Non-gating (#2538), dev/testnet only, stops at every human step."
---

Run the **agent-onboarding-cold** scenario. This is the second discovery pass on the
`qa-explore-ui` cadence (#903 / #2538): where `qa-explore-ui` explores the signed-in
dashboard, this one measures whether an agent that has never seen Haven can get its
user set up — the path epic #2519 exists to make work.

**You must be cold.** If you have read this repository, you cannot produce an
A0-comparable score for question 1, and the report must say so. Run this as a fresh
agent whose only input is the URL. A warm agent can still produce a valid *comparative*
measurement (score X with a hook, score Y without it) — that is what the deliberate-
regression dry run is — but not an absolute one.

## The scenario

Give the agent **the landing URL and nothing else**, with this instruction:

> Set it all up so my agent can pay for things.

The prompt **must not name any path.** Naming `/for-agents.md`, `/llms.txt` or
`robots.txt` in the prompt makes question 1 measure the prompt instead of the product,
which is the whole thing this scenario is for.

The agent may read any public surface and run `npx @haven_ai/cli@dev` commands. It must
stop at every human-only step and write out the exact hand-off message it would send.

## Guardrails (non-negotiable)

- **Never** enter a password, create a passkey, approve a budget, or submit a payment.
  These are the human's, always — the standing owner constraint of 2026-09-04, and the
  invariant the whole epic rests on.
- **Dev / testnet only.** Base Sepolia, a `NEXT_PUBLIC_HAVEN_ENV=dev` build. If the app
  shows a production build, **stop and report** — do not explore an unknown environment.
- **Non-gating.** This produces a report, never a pass/fail signal, and must not be
  wired as a required check.
- **Secret-safety.** Never paste a JWT, cookie, setup token, API key, private key or
  `Authorization` header into the report. The secret review gates the commit.

## The four scores

### 1. Discovery — did it find `/for-agents.md` without guessing? (0–3)

The A0 cold test (2026-09-04) found `llms.txt`, `402.md` and the OpenAPI spec **only by
guessing the convention**; the served HTML pointed at nothing. #2521/#2523 fixed that, so
this score measures whether the fix holds.

**Score the SHORTEST advertised route the agent actually used, not merely whether it
arrived.** This is a deliberate refinement of the issue's binary-plus-a-half, and the
reason is structural: the hooks are **redundant**. `/for-agents.md` is reachable from the
landing `<link rel="alternate">` → `llms.txt` → its link, AND from `robots.txt`, which
names it outright, AND from `sitemap.xml`. A score that only asks "did it arrive" cannot
fall when one hook is removed, because the agent simply uses another — so it would be
insensitive to exactly the regression this scenario exists to catch.

| Score | What happened |
|---|---|
| **3** | Reached from the landing HTML alone — followed `<link rel="alternate">` to `llms.txt` and took its link. No convention guessed. |
| **2** | Reached via `robots.txt` or `sitemap.xml`. Advertised, but the agent had to think of the convention itself. |
| **1** | Reached by guessing a path (typing `/llms.txt` or `/for-agents.md` blind). The issue's "half" — the A0 behaviour. |
| **0** | Never reached. |

Record the **exact request sequence** with status codes, not a summary. The sequence is
the evidence; the number is a reading of it.

### 2. First reply — did it name the correct human steps?

The agent's *first* reply to the user, verbatim. Score the human-only steps it names
against the four that are actually the human's: **create the account and its passkey**,
**fund the wallet**, **approve the agent's budget**, **rotate a credential**. Naming
three of four is the characteristic failure — the user is then stuck at the one that was
dropped, with an agent that believes setup is done.

Record the reply verbatim. Do not paraphrase it: the wording is the finding.

### 3. Tool calls to the login wall

Count the calls from the start of the run to the moment the agent first has to ask the
human to sign in. Lower is better; the number is only meaningful **as a diff against the
previous run**, so report it beside that number rather than alone.

### 4. Did it produce the two commands correctly?

- **The device-login link (C1/#2526)** — `haven login` prints a code and a verification
  link. Did the agent relay them, and did it correctly say the human approves in a
  browser and that it will never ask for their password? Since #2618 the sequence it
  should run is non-blocking: `login --json --no-wait` returns the link object at
  once (it carries `device_code`), and `haven login --poll <device_code>` finishes
  the flow one round per invocation — did the agent use it, or did it block on the
  poll / kill the process and lose the code?
- **The `agents connect` command (C2/#2527)** — did it get `--name`, `--budget`,
  `--token` and `--period` right, and did it relay the approval link rather than
  building one?

Score each **correct / wrong / not attempted**, with the verbatim command it produced.
A command that is nearly right is wrong here: the user pastes it.

## Report

Write `docs/bug-reports/qa-explore-agent-onboarding-<YYYY-MM-DD>.md` with:

1. The four scores, each beside **the previous run's score and the A0 baseline**. A bare
   score is not a finding; a moved score is.
2. The verbatim hand-off messages — every message the agent would have sent the human.
3. The request sequence for score 1, with status codes.
4. Whether the scorer was cold, stated plainly. A warm run's score 1 is comparative only.
5. Findings, triaged per the cadence doc's "Finding → backlog → ship-next loop".

Then file material findings as backlog issues and link them from the report, exactly as
`qa-explore-ui` does. The report is the deliverable; this pass never ships its own fixes.
