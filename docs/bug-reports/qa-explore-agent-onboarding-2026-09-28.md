---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/public/llms.txt
  - packages/frontend/public/for-agents.md
  - packages/frontend/src/lib/capability-manifest.ts
  - packages/cli/src/args.ts
last-verified: "2026-09-28"
---

# agent-onboarding-cold — run 2 (2026-09-28)

Second run of the `qa-explore-agent-onboarding` scenario, plus a focused run for
**epic #3302 box 4** (can a cold agent find the release/compat page from
`/for-agents.md`?). Target: the dev frontend
`https://haven-ai-frontend-git-dev-daniels-projects-f3327ba2.vercel.app`. The
manifest reported `environment: "dev"`; the dev backend was at `3e4654d2`.

**Cold or warm.** Both runs were executed by **fresh sub-agents**. Their only
input was the URL and the prompt, and they were forbidden from reading any local
file or the repository. The orchestrating session had read the repository, so it
only wrote the prompts and scored the transcripts. That makes score 1
A0-comparable. The caveat: the sub-agents share the model family of the
orchestrator, so "cold" means no repository and no product knowledge in context,
not a different agent.

## Scores

| Score | Run 2 (this) | Run 1 (2026-09-06) | A0 baseline | Moved |
|---|---|---|---|---|
| **1. Discovery** | **3** — landing → `/llms.txt` → `/for-agents.md`, nothing guessed | 3 | 1 | held |
| **2. First reply** | **3 of 4**: account + passkey, funding, budget approval. Credential rotation is not named. | 3 of 3 (scored on three steps) | 2 of 3 | rubric widened to four; see finding 5 |
| **3. Tool calls to the login wall** | **8** | 7 | ~10 | +1 (one extra call: a text re-extract of `/releases`) |
| **4a. `haven login`** | **correct** | not attempted | n/a | new pass |
| **4b. `agents connect`** | **not attempted**: blocked at the device login, which is the human's step. The command it drafted is correct. | blocked | n/a | — |

## Score 1 — request sequence (run 2a, landing URL only)

| # | Request | Status | Why |
|---|---|---|---|
| 1 | `GET /` | 200 | The given URL. The hero text says "start at /llms.txt"; a Dev marker is shown. |
| 2 | `GET /llms.txt` | 200 | Advertised on the landing page |
| 3 | `GET /for-agents.md` | 200 | The llms.txt "Start here" link |
| 4 | `GET /.well-known/haven.json` | 200 | Named by llms.txt and for-agents.md: `environment: dev`, CLI channel `@haven_ai/cli@dev` |
| 5 | `GET /releases` | 200 | The llms.txt link "Something broke — an update may be needed" |
| 6 | `npx -y @haven_ai/cli@dev --help` | ok | Named by for-agents.md |
| 7 | `haven login --api <dev api> --json --no-wait` | `ok: true` | for-agents.md step 1 |
| 8 | `haven login --poll <device_code> --api <dev api> --json` | `status: pending` | One poll round |

## Epic #3302 box 4 — release/compat page from `/for-agents.md` (run 2b)

Input: only the `/for-agents.md` URL, and the prompt "my Haven tools just told me
a client is out of date. Figure out what changed and what I should run".

| # | Request | Status | Why |
|---|---|---|---|
| 1 | `GET /for-agents.md` | 200 | The given URL |
| 2 | `GET /releases` | 200 | for-agents.md § *If something breaks*: "What changed: [/releases](/releases)" |
| 3 | `GET /.well-known/haven.json` | 200 | Named in for-agents.md; `/releases` says the same data is under `packages` |

**Result: found in one hop, with no guessing.** The agent read the per-package
minimum, recommended version, update command and notes. It identified the
signer as the only package with a minimum, and it answered with
`npx -y @haven_ai/connect@dev --doctor`, "then run any repair command it prints,
and retry". That is the #3412 contract, verbatim. **Box 4 holds.** Run 2a also
reached `/releases` independently, via the llms.txt link.

## Verbatim hand-off messages (run 2a)

First reply (message 1):

> I've read Haven's agent guide for this site. It's a **dev/test deployment** (its manifest says `environment: dev`, and the only chain it deploys on is Base Sepolia, a testnet), so no real money is involved.
>
> Here's how it works: you give me a *budget* on your own Haven account, enforced on-chain. I never hold your wallet or your password. I can do all the plumbing, but four things need you: creating the account (with a passkey), funding it, and approving the budget with your passkey. You also create the agent and budget, unless you let me sign in to the CLI and do that part for you.
>
> Step 1: please open `<host>/signup?next=/agents&via=agent` and create your account (name, email, password, then a passkey with Face ID / Touch ID, or a wallet). That's your account's key. I shouldn't have it, and I'll never ask for your password. If you already have an account, use `<host>/login?next=/agents` instead.
>
> Once you're signed in, approve my terminal session so I can set up the agent for you. Open `<host>/device?code=<user code>` and confirm the code (valid for 15 minutes). That session lets me create the agent and read your account. It can't sign anything, approve a budget or move funds. Tell me when it's done.

(The user code and expiry were live values; they are replaced here because they
are a short-lived login credential.)

Message 2 (passkey fallback), message 3 (funding) and message 4 (budget
approval) follow the runbook's scripts. Message 3 says it will confirm the
address **and chain** with `haven wallets funding` before the user sends
anything. Message 4 relays `<approval.url>` rather than building a link.

## Findings

1. **The runbook's `<channel>` is a tag, but the manifest serves a full spec (material).**
   - `for-agents.md` says: "The `<channel>` in that command is the tag your deployment names — read it from `/.well-known/haven.json` (`packages.cli.channel`)".
   - The manifest serves `packages.cli.channel: "@haven_ai/cli@dev"` and `packages.connect.channel: "@haven_ai/connect@dev"`, which are full specs (`capability-manifest.ts:274`, `:280` set `channel` to `facts.cli_package` / `facts.connector_package`).
   - Substituted literally, that gives `npx @haven_ai/cli@@haven_ai/cli@dev`.
   - Run 2b spotted the mismatch. Run 2a worked around it by reading the spec whole.
   - Filed as #3430.
2. **Dev's manifest names Base mainnet as its default chain (material).**
   - `chains.default: 8453` (Base, `testnet: false`), while `chains.deployable: [84532]` (Base Sepolia only), on `environment: "dev"`.
   - Both runs flagged it. Run 2a would have told the user Base Sepolia only because it cross-read `deployable`.
   - A less careful agent could send a user to fund on mainnet.
   - Filed as #3431.
3. **`--doctor` reads as a health check, not the upgrade path (minor).** for-agents.md § *How to verify* presents `npx -y @haven_ai/connect@<channel> --doctor` as a check. Since #3412 the same command is the connector-installed packages' `upgrade_command`. § *If something breaks* ("run its `upgrade_command` as given, then any repair line it prints") covers it, so no agent went wrong. Not filed.
4. **Release notes say "see the changelog" without a link; "breaking" without `action_required` (minor, run 2b).**
   - The `/releases` notes reference "the changelog" and "(+N more in the changelog)", but neither `/releases` nor the manifest links one.
   - The mcp and sdk 0.6.0 notes say "breaking" with `action_required: false` and no minimum. Only the signer has one, and nothing on the page explains why.
   - Not filed; noted for the #3302 owner.
5. **First reply says "four things need you" and lists three (minor).** It also never names credential rotation, which is the fourth human step in this scenario's rubric. Rotation is not needed for first setup, so this is a rubric question as much as a finding. Not filed.
6. **`haven login --poll --json` echoes `device_code` (minor).** The device code is a short-lived secret that finishes the login. Echoing it on every poll makes it easy to leak into agent transcripts: run 2a's own redaction missed it once. `--no-wait` must return it once; the poll output need not repeat it. Not filed yet: check whether the poll echo is load-bearing for a client before changing it.

## Guardrails

- No password was entered, no passkey created, no budget approved, and no payment made.
- The device login was started and left pending after one poll. It expired unapproved.
- The environment was dev throughout.
- No token, key or cookie appears in this report.
