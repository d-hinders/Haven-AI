---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/agent-rekey.ts
  - packages/backend/src/infra/repositories/agent-rekeys.ts
  - packages/backend/src/modules/agents/rekey-carry.ts
  - packages/backend/src/modules/agents/rekey-guards.ts
  - packages/backend/src/modules/passport/reanchor.ts
  - packages/connect/src/rekey.ts
  - packages/connect/src/rekey-restart.ts
  - packages/connect/src/args.ts
  - packages/connect/src/storage.ts
  - packages/frontend/src/components/agent-panel/ReplaceSigningKeyModal.tsx
last-verified: "2026-08-23" # #1702: written against epic #1694 as merged — #1698 (backend stages), #1699 (passport re-anchor), #1700 (connect --rekey), #1701's shipped half (dashboard). Every claim checked against code rather than the epic's prose; the residual-funds and fresh-process-check cautions are stated because the code says so and nothing user-facing did.
---

# Replacing an agent's signing key

An agent signs with a **private signing key** that lives on the machine running it. If
that key is lost or exposed, you replace it: same agent, same name, same history, new
key.
This is **re-key**, and it is why losing one is a bad afternoon rather than a
disaster.

> **Re-key is not account recovery, and confusing the two is expensive.** An agent's
> signing key never held authority over your account — it can only *request* payments
> inside a budget you granted. Losing one is recoverable because you, the owner, are still
> there to replace it. Losing your account's only signer is a different situation with
> a different answer, and re-key does not help: see
> [account recovery](account-recovery.md).

## Before you start: money on the old key

**Read this one before anything else if the key is lost.**

An agent's own wallet address can hold a small balance — the x402 EIP-3009
path funds it briefly to settle with a merchant. Sweeping that balance back to your
Haven wallet requires a signature **from that signing key itself**. Haven cannot sign
it for you; that is the same non-custody that keeps your funds yours.

So the order matters, and it is not recoverable afterwards:

- **Key still works?** Sweep it back first, then re-key. Ask the agent to do it — the
  key is on its machine, so it is the only thing that can sign the transfer
  (`haven_sweep_delegate` over MCP, or `sweepDelegate()` if you drive the SDK
  directly).
- **Key lost?** Anything left on that address is **permanently stranded** — by you and
  by Haven alike. Haven's preflight reads the balance and refuses to continue until
  you say what happened to it, so you find out now rather than later.

## What re-key does

You authorise it from the agent's page in the dashboard. **An agent can never re-key
itself** — every step is signed by you, and Haven's re-key endpoints refuse an agent
credential outright. An agent that could rotate its own credentials would be an agent
editing its own authority.

The old authority is revoked **before** the new key gets any. That order is
deliberate: if something fails partway, you land on *this agent cannot spend right
now*, which you can retry. The other order would fail to *two live keys on a funded
account*, which nothing recovers by retrying.

### What carries over

| | |
|---|---|
| **The agent itself** | Same id, same name, same transaction history. Nothing downstream has to be re-pointed. |
| **The budget remainder** | If the agent had 40 of 100 USDC left this period, the new key gets 40 — not 100. |
| **The period boundary** | The carried 40 expires when the original period would have, and the full budget resumes then. Re-key is not a way to refill a budget. |
| **Passport standing** | If the agent has an [Agent Passport](agent-passport.md), its standing is unbroken. |

Two edges the example skips, both in your favour: a budget whose first period had not
started yet is simply reissued whole, and a grant that had already expired carries
nothing because there was nothing live to carry.

The budget carry is the part people expect to work differently, so it is worth being
exact. Carrying only the *amount* would mean an agent on a daily budget could be
handed its remainder hourly by re-keying repeatedly — a rate limit quietly turned
into a tally. The period travels with the amount to close that.

### What stops working, immediately

- **The old API key.** Rotated in the same instant as the signing key. Any host
  still holding it starts failing authentication at once — which is the intended
  behaviour, not a bug to work around.
- **The old signing key.** Its delegations are revoked on-chain; a payment attempt
  with it reverts.
- **Quotes that were waiting to be signed.** Any payment quoted against the old key
  and not yet sent is cancelled — the agent will need to ask again. Payments already
  submitted or confirmed are history and are left exactly as they are.

### What briefly lags

If the agent has a passport, its **on-chain attestation** is retired and a new one
naming the new key is issued. EAS attestations cannot be edited, so this is a
revoke-and-reissue, and there is a short window where the chain is behind. The
dashboard shows this as **Updating on-chain** while standing stays **Active** — the
agent is fully authorised the whole time. A chain problem here delays the anchor; it
cannot cost the agent its standing.

## Lost versus compromised

The mechanics are identical. The difference is what you should look at.

- **Lost** — the key is gone. Nobody else has it. Rotate at your convenience, minding
  the residual balance above.
- **Compromised** — someone else may have it. The dashboard shows the agent's spend
  since the exposure you suspect, so you can judge the damage. Treat the budget
  remainder as potentially already spent by someone who is not you.

## Doing it

Re-key spans two places, because the new key is generated on the agent's machine and
never leaves it. Haven only ever receives an address.

**1. On the machine that runs the agent**

```
npx @haven_ai/connect@alpha --rekey
```

Add `--name <slug>` if you wired the agent under a name. It prints a new **public
signing address** and stops. Nothing has changed yet — the agent keeps working on its
old key.

**2. In the dashboard**

Open the agent, choose **Replace signing key**, paste the address. You will sign a few
times: once to revoke the old authority, then once per replacement budget. At the end
it shows a **new API key, once**. Copy it.

> **Finish this step in one sitting.** What is left of the budget is measured the
> moment you approve the revoke, but the replacement is worked out when you finish.
> If the agent's budget period rolls over while you are part-way through, it can come
> back with **nothing to spend until the following period**
> ([#1849](https://github.com/d-hinders/Haven-AI/issues/1849)). The agent also cannot
> pay at all between the revoke and the finish. Do not start this and go to lunch.

**3. Back on the machine**

```
npx -y @haven_ai/connect@alpha --rekey-finish --api-key <the key> --runtime <your runtime>
```

Add the same `--name <slug>` if you used one. This writes both new credentials in
place, at the same path as before, and updates that agent's entries in your MCP
config.

> **Pass `--runtime`.** Your API key is stored inside the MCP config, not just in
> Haven's credential files. Without `--runtime` the credentials on disk are correct
> and every wired host still presents the retired key and fails with 401. The
> connector says so loudly, but it is easier to just pass the flag.

**4. Restart every long-lived host**

Not just the one in front of you. Each long-running process — gateway, editor, TUI
worker — loaded its wiring when it started and is still holding the old key. The
connector prints the exact restart command for your runtime; the sweep across
everything else is on you.

## Checking it worked

**A fresh-process check does not prove your running session is healthy.** Commands
like `hermes mcp test haven` spawn a *new* process, which reads the current config and
passes — while the session you are actually using still holds the old registration in
memory. This is the single most misleading signal in this whole operation.

The check that works compares what the API key authenticates as against what the local
signing key actually is:

```
npx -y @haven_ai/connect@alpha --doctor --runtime <your runtime>
```

Its `identity_match` check fails loudly when the two disagree — the state where an
agent would quote as itself and sign as something else. Run it **after** restarting,
because it too can only see what is on disk and what a fresh process reports.

**If you started a re-key and never finished it, `--doctor` now says so (#1911).** It
reports the parked keypair per agent — that one exists, when it started, whether it has
expired, its **public** address and its path, never its private half — so an abandoned
re-key is not silent, and a lost terminal is not a cliff: the address you were meant to
paste is re-printable without discarding the parked key. An expired one is its own
failure rather than a footnote, and neither `--doctor` nor `--repair` deletes it —
dropping key material is your call.

One thing it **cannot** tell you, said here because the difference is expensive. If
Haven already reports the address this machine generated, the re-key completed and only
the local half is outstanding — run `--rekey-finish`. Otherwise the machine cannot see
whether the on-chain revoke on the agent page already ran. If it did not, closing the
re-key costs nothing. If it did, the agent's old delegations are revoked and no new ones
were issued, so it has **no spend authority until you re-grant it**
([#1868](https://github.com/d-hinders/Haven-AI/issues/1868)) — and nothing on this
machine records that. Check the agent page before assuming the harmless reading.

## Limits

- **Delegation-rail accounts only.** Agents on the legacy Safe AllowanceModule rail
  cannot be re-keyed: their authority is per-token allowances rather than a signed
  delegation, so there is nothing to revoke and re-issue. Re-onboarding is the path
  instead. **Replace signing key** stays reachable on those agents and explains this
  when you open it — deliberately, rather than being greyed out: if your key is lost
  you need to be told what to do instead, and a disabled menu item cannot tell you
  anything.
- **A key is never moved between machines.** There is no "restore my key here". The
  new keypair is generated on the target machine, and any design that transported one
  would break the non-custody the whole system rests on.
- **Telling two agents apart in your MCP config is not solved yet.** If you run
  several agents, the dashboard cannot currently show which wiring slug belongs to
  which agent — the slug never reaches Haven
  ([#1878](https://github.com/d-hinders/Haven-AI/issues/1878)). Until it does,
  `--doctor` on the machine itself is the way to see which agent a credential
  directory holds.

## See also

- [Account recovery](account-recovery.md) — the other thing that can go wrong, and why
  it has a harder answer
- [Agent Passport](agent-passport.md) — what standing means and why the anchor lags
- [`@haven_ai/connect` README](../../packages/connect/README.md) — every flag, including
  multi-agent wiring
