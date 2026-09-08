---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/frontend/public/llms.txt
  - packages/frontend/public/for-agents.md
  - packages/frontend/src/app/layout.tsx
  - packages/cli/src/args.ts
last-verified: "2026-09-06"
---

# agent-onboarding-cold — run 1 (2026-09-06)

First run of the scenario defined in
[`qa-explore-agent-onboarding`](../../.claude/commands/qa-explore-agent-onboarding.md),
on the cadence in [`qa-explore-ui-cadence.md`](../operations/qa-explore-ui-cadence.md)
§ *Second scenario* (#2538). Scored against the
[A0 baseline](agent-first-cold-test-2026-09-04.md) of 2026-09-04.

| | |
|---|---|
| Date | 2026-09-06 |
| Subject | a fresh general-purpose agent session, instructed to use no local files and to work only from the URL |
| Input | the dev preview URL, and "set it all up so my agent can pay for things". **No path was named in the prompt.** |
| Guardrails | no password, no passkey, no budget approval, no payment — all held |
| Cost | 13 network requests, ~3 minutes |

**Cold-scorer caveat, stated because the score depends on it.** The subject was a
sub-agent of a session that has read this repository, instructed not to use local files.
It reported working only from the network and its request log is consistent with that.
That is weaker than A0's genuinely separate session, and score 1 in particular should be
read as *an upper bound corroborated by a run*, not as an independent replication. The
band-3 result is independently supported by the deterministic ceiling measurement below,
which does not depend on the agent at all.

> **Corrected after review.** Two numbers in the first version of this report were
> wrong, and both were mine rather than the run's. Score 2 was published as "4 of 4"
> without applying this scenario's own rubric — which scored out of four including
> credential rotation, a human-only step that is not part of setup, so no first reply
> should ever name it. The rubric now scores the three setup steps and says why rotation
> is excluded; run 1 is 3 of 3 and A0 is 2 of 3 (A0 never reached funding — its own
> §6 says so, and neither of its hand-off scripts mentions it). The A0 gloss also said
> "funding named", which inverted the one step A0 missed. Separately, "five landing
> hooks" came from the measurement script double-counting one `<link>` through two
> overlapping regexes; there are four, three of which point at `/llms.txt`. The script
> is fixed at the source. Found by haven-reviewer; the movement figure survives both
> corrections, the denominators did not.

## Scores

| # | Score | A0 (2026-09-04) | Movement |
|---|---|---|---|
| **1. Discovery** | **3** — landing `<head>` → `/llms.txt` → `/for-agents.md`, nothing guessed | **1** — "discovery of them is pure guesswork" | **+2** |
| **2. First reply** | **3 of 3** setup steps named | **2 of 3** — funding never named | **+1** |
| **3. Tool calls to the login wall** | **7** | ~10 round-trips to the same wall | — (first measurement on this definition) |
| **4. The two commands** | `haven login` **not attempted**; `agents connect` **blocked** — see below | neither existed at A0 | new |

### 1. Discovery — 3 (from the landing HTML alone)

The agent's own words: *"I guessed nothing."* It read the landing page, found

```html
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt"/>
```

followed it, and took `llms.txt`'s link to `/for-agents.md`. Two hops from the served
HTML, no convention tried on spec. This is the band the hooks of #2521/#2523 were built
to reach, and A0 — which had a `<meta description>` and nothing else — could not.

**Deliberate-regression evidence** (`node scripts/qa/discovery-reach.mjs`), which
measures the *ceiling* rather than one agent and so is reproducible:

| Tree | Ceiling | Why |
|---|---|---|
| this commit | **3** | landing `<link rel="alternate">` → `/llms.txt` (2 hops) |
| minus the `<link rel="alternate">` | **2** | no landing-HTML route; advertised by `robots.txt` and `sitemap.xml` |
| minus that and the `robots`/`sitemap` entry | **1** | advertised nowhere — only reachable by guessing the path |

Band 1 is exactly A0's behaviour, which is the check that the rubric is calibrated
against something real rather than invented.

**One structural finding, not visible to the agent.** The landing HTML carries four
hooks — two `<link rel="alternate">` tags, the "If you are an AI agent" sentence and the
footer's "For agents" — and **three of them point at the same file**, `/llms.txt`; the
fourth is the OpenAPI spec, not a route to the runbook. A single line inside `llms.txt`
is the only link onward to `/for-agents.md`. Delete that one line and the ceiling falls to 2 while
every existing hook test stays green, because each of them checks a hook in isolation and
none checks that following one *arrives*. Fixed in the same PR by a chain assertion in
`discovery-surfaces.test.ts` — mutation-proven: dropping the line turns exactly that one
test red.

### 2. First reply — 3 of 3

It named all three setup steps that are the human's: signup with password and passkey,
funding, and approving the budget with the passkey. It also
volunteered the boundary unprompted — *"I will not enter your password or create your
passkey, and I will not approve the budget. Those three are the whole security model."*

It went further than the rubric asks and flagged a **funding risk** the documentation
did not warn it about (see finding B below), rather than passing the ambiguity to the
user unnoticed.

### 3. Tool calls to the login wall — 7

Five were discovery (landing, `llms.txt`, `for-agents.md`, the manifest, CLI help). The
wall was *knowable* at call 3, when `/for-agents.md` said step 1 is human-only; the agent
spent the remaining calls confirming it empirically with `whoami`. Report this against
run 2 rather than reading it alone.

### 4. The two commands — one not attempted, one blocked by a defect

- **`haven login` (C1/#2526) — not attempted.** Correctly: the agent had no account to
  log into. Not a failure of C1; the scenario reaches this command only on a second run
  against a seeded account, which is a rubric limit worth recording.
- **`haven agents connect` (C2/#2527) — blocked, by finding A.** The agent looked for the
  command `/for-agents.md` told it to use, did not find it in `--help`, and concluded it
  does not exist. It does. This is the run's most valuable output.

It also declined to construct the connector command, correctly: *"I cannot construct it —
the setup token is one-time and only the dashboard issues it. I will not fabricate this
line."* That is the invariant #2528 and #2537 both encode, holding in the wild.

## Findings

| # | Finding | Severity | Issue |
|---|---|---|---|
| A | `haven --help` omits `agents connect` and describes `login` as password-only, contradicting `/for-agents.md` and #2526 | **High** — makes a documented step look unavailable | [#2590](https://github.com/d-hinders/Haven-AI/issues/2590) |
| B | Agent-facing docs never name the CLI's backend URL (defaults to `localhost:3001`); the funding hand-off says "USDC on Base" on a Base Sepolia deployment | **High** — silent misattributable failure; money-adjacent copy | [#2591](https://github.com/d-hinders/Haven-AI/issues/2591) |
| C | An unrecognised subcommand prints general help and exits 0 | Medium — an agent cannot branch on it; it is what hid A | folded into [#2590](https://github.com/d-hinders/Haven-AI/issues/2590) |

Filed rather than fixed here, per the cadence's own rule that discovery and delivery stay
decoupled. Finding A is the sharper one: it is a **documentation-to-CLI contradiction on
the epic's own path**, and it survived C2 shipping, the runbook naming the command, and
(in review at the time of this run) the `haven-pay` skill naming it too. Three surfaces
tell an agent to run a command the CLI's own help does not list.

**Considered and dropped:** the agent did not read `/402.md`, `/llms-full.txt` or the
OpenAPI body, and said so — a scoping decision, not a finding. Its uncertainty about
whether this build implements device login was a *symptom* of finding A, not separate.

## Where it stopped

At step 1 of 6, account creation, which the deployment declares unreachable for it:
`/.well-known/haven.json` lists `human_only_steps: ["signup_and_passkey", "fund",
"approve_budget"]`. The agent's own reading is the right one to record:

> this is the system working, not a blocker I failed to route around. Three of the six
> steps are human-only *by design*, and the one that matters most — approving the budget
> — is the thing that makes the budget mine to spend and theirs to revoke.

## Secret review

No JWT, cookie, setup token, API key, private key or `Authorization` header appears in
this report or in the run log it was written from. No password was entered, no passkey
created, no budget approved, no payment submitted.
