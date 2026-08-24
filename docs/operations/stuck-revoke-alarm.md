---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/passport/revocation.ts
  - packages/backend/src/modules/passport/attestation.ts
  - packages/backend/src/infra/repositories/agent-passports.ts
last-verified: "2026-08-23" # #1699: new §1a — there are now TWO passport alarms and this runbook described only one. #1699 added a `reanchor-alarm` phase whose meaning is the OPPOSITE of this one (a LIVE agent whose attestation names a retired delegate key, vs a REVOKED agent whose attestation is still live), and every query and remedy in §2-§4 is gated on `agents.status = 'revoked'` — so an operator who reached this page from the wrong log line would query an invariant that is false by construction and find nothing. §1a disambiguates the two and explicitly refuses §2-§4 for the re-anchor case. §1's "three independent phases / the third phase" corrected to five and fourth. Re-read §2-§5 against `revocation.ts` and `agent-passports.ts` as merged: every claim about the revocation alarm itself stands unchanged, including the #1758 convergence-probe behaviour, which the re-anchor path now shares via the extracted `retireAttestationOnChain`. Scope: §1/§1a only for new material; no §2-§5 remedy was re-executed against a live environment. Prior: written for #1793, against the code as of #1758 (PR #1786): the convergence probe, the settled-block read, the mined-only evidence pointer, and `passport_revoke`'s membership of REBROADCAST_SAFE_SUBMITTERS were each read from source rather than from the issue text
---

# Stuck-revoke alarm — operator runbook (#1793)

**The one-line meaning of this alarm: an agent that Haven has already revoked
still holds a LIVE, merchant-readable passport attestation on-chain.**

Haven's own answer is already correct — `agents.status = 'revoked'` *is* the
revocation, and `passportStanding()` (and through it the merchant-facing
verifier) reads that alone. A merchant who checks the verifier is safe during
the whole window this alarm covers. A merchant who checks **only the chain** is
not, and that is the entire risk this alarm describes. See
[`revocation.ts`](../../packages/backend/src/modules/passport/revocation.ts)'s
header for the consistency model.

Since [#1758](https://github.com/d-hinders/Haven-AI/issues/1758) (PR
[#1786](https://github.com/d-hinders/Haven-AI/pull/1786)) this alarm is
**specific**. It used to be one of several noisy states, including a large
self-inflicted class — a revoke that mined *after* its confirmation wait
expired left the row `pending` permanently, alarming about a credential that
was already dead. That class now converges on its own. What is left is
narrower and, when it persists, real.

## 1. What fires the alarm

The passport sweep in
[`index.ts`](../../packages/backend/src/index.ts) runs every **5 minutes**
(`PASSPORT_SWEEP_INTERVAL_MS`) under a leader lock, in five independent phases
([#1699](https://github.com/d-hinders/Haven-AI/issues/1699) added a re-anchor
reconciliation and a second alarm — see §1a before acting on anything). The
**fourth** phase is this alarm:

```
WARN  Passport revocations unreconciled past threshold — agents revoked in
      Haven still hold a live attestation on-chain
      { count: <n>, agents: [ { agent_id, revocation_requested_at,
                               revocation_attempts, revocation_last_error } … ] }
```

`agents` carries at most the first **10** rows; `count` is the true total.

The threshold is **`PASSPORT_STUCK_REVOKE_SECONDS = 3600`** — one hour since
`revocation_requested_at` (falling back to `anchored_at`). That number is a
*reporting* threshold, not a verdict: it says "this has been diverged long
enough to look at", never "this is dead". See §5.

The row set is `LIST_STUCK_REVOCATIONS_SQL` in
[`agent-passports.ts`](../../packages/backend/src/infra/repositories/agent-passports.ts),
and it is defined by the **invariant**, not by a flag:

```sql
WHERE p.status = 'anchored'
  AND a.status = 'revoked'
  AND p.revocation_status <> 'confirmed'
  AND COALESCE(p.revocation_requested_at, p.anchored_at) < NOW() - MAKE_INTERVAL(secs => $1)
```

Read that literally when triaging: an agent revoked mid-anchor never reaches
`revocation_status = 'pending'` at all, and a flag-based scan would miss it.
The alarm sees every divergence, so a row here does **not** imply a revoke
transaction was ever attempted.

The alarm phase runs even when the issuance and reconciliation phases above it
throw — deliberately, because that is exactly when it matters.

## 1a. There are TWO passport alarms. Check which one fired.

This runbook is about **one** of them, and following it against the other will
lead you to the wrong query and the wrong conclusion about whether the agent is
even revoked. The log lines are adjacent and similar; the incidents are
opposites.

| | this runbook's alarm | the re-anchor alarm (#1699) |
|---|---|---|
| log line | `Passport revocations unreconciled past threshold — agents revoked in Haven still hold a live attestation on-chain` | `Passport re-anchors unreconciled past threshold — live agents hold an attestation naming a retired delegate key` |
| sweep phase | `alarm` (4th) | `reanchor-alarm` (5th) |
| the agent is | **revoked** (`agents.status = 'revoked'`) | **live and fully authorised** |
| row set | `LIST_STUCK_REVOCATIONS_SQL` | `LIST_STUCK_REANCHORS_SQL` |
| the invariant | a revoked agent's attestation is still live | a live agent's attestation names a key it no longer holds |
| the exposure | a merchant reading the chain alone serves a revoked agent | a merchant resolves a passport for an address that can no longer spend |

**Do not apply §2–§4 to a re-anchor alarm.** Every query and every remedy below
is gated on `agents.status = 'revoked'`, which is false by construction for a
re-anchor row — §2's queries will return nothing and §4's cancel remedy has no
valid target. The re-anchor case is described in
[`reanchor.ts`](../../packages/backend/src/modules/passport/reanchor.ts)'s
header and in
[`11-agent-passport-schema.md`](../architecture/11-agent-passport-schema.md)
§ *Re-anchoring after a re-key*; the short version an operator needs:

- **The agent is not at risk and neither are its funds.** Its spend authority
  is the signed delegation, which the re-key already rotated. `standing` is
  `active` and correct throughout, and the verifier reports the anchor as
  `re_anchoring` rather than claiming the retired credential is current.
- **It self-heals.** The queue is the invariant "the attestation names an
  address the agent no longer uses", so the row stays due and the sweep keeps
  retrying with the same 30s→1h backoff.
- **What to look at first** is `revocation_last_error` on the row, exactly as
  in §2 — a persistently stuck re-anchor is almost always the same underlying
  cause as a stuck revoke (relayer, RPC, unregistered schema), because both
  paths share `retireAttestationOnChain`.
- **Do not hand-edit `agent_passports` to force it forward.** Clearing
  `attestation_uid` before the retired attestation is confirmed revoked strands
  that credential permanently — `resetForReanchor` refuses exactly this, and a
  manual UPDATE would defeat the one guard standing in front of it.

A full parallel triage section for the re-anchor case is not written yet; if
you work one, write it here rather than leaving the next operator to re-derive
it.

## 2. Triage, in order — check before you touch anything

This ordering is not stylistic. The only remedy at the end of it (§4) is a
**cancel transaction on a shared relayer nonce lane**, and a cancel is a
lane-wide action with side effects on rows that have nothing to do with this
agent. Every step below exists to establish that you actually need it.

### Step 1 — is the attestation already revoked on-chain?

Ask the chain first. If the revoked bit is set, the credential is dead, no
merchant can be misled by it, and **there is nothing on-chain left to do** —
whatever the row says.

Get the UID and the row state:

```sql
SELECT p.agent_id, p.chain_id, p.attestation_uid, p.revocation_status,
       p.revocation_requested_at, p.revocation_attempts,
       p.revocation_next_attempt_at, p.revocation_last_error
  FROM agent_passports p
  JOIN agents a ON a.id = p.agent_id
 WHERE p.agent_id = '<agent_id>';
```

Then read the bit by hand. `getAttestation(uid)` on the pinned EAS contract
returns a 10-field struct
`(uid, schema, time, expirationTime, revocationTime, refUID, recipient,
attester, revocable, data)`. The field that answers the question is the fifth,
**`revocationTime`** — `0` for a live attestation, a unix timestamp otherwise:

```bash
cast call <EAS_ADDRESS> \
  'getAttestation(bytes32)((bytes32,bytes32,uint64,uint64,uint64,bytes32,address,address,bool,bytes))' \
  <attestation_uid> \
  --rpc-url <RPC_URL> \
  --block finalized
```

Three things to get right about this read, all of which mirror what the code
does:

- **Read at a settled block.** `--block finalized` (or `latest` minus ~300
  blocks — `SETTLED_CHAIN_READ_DEPTH_BLOCKS`). Haven refuses to read the head
  here because `confirmed` is terminal — `listStuckRevocations` never revisits
  a confirmed row — so a head read undone by a reorg would silence this alarm
  for a still-live credential. Your manual read should hold the same standard;
  a head read is fine for a quick look but is not evidence.
- **Check the echoed `uid`.** EAS returns a zeroed struct for a UID it does not
  know, and at a settled block that is the ordinary state of an attestation
  minted minutes ago — "not visible yet", never "not revoked". If the struct's
  first field is not the UID you asked about, you have **no answer**, not a
  negative one.
- **A live reading is not proof the revoke failed.** It is proof it has not
  landed *as of that block*.

Now branch:

- **`revocationTime != 0` (revoked)** → the credential is dead. Go to §3. Do
  **not** cancel anything, do **not** broadcast a revoke by hand.
- **Zeroed / wrong UID (no answer)** → you learned nothing. Re-read at a later
  block before doing anything else.
- **`revocationTime == 0` (live)** → the divergence is real. Go to Step 2.

### Step 2 — is a revoke transaction actually in flight?

```sql
SELECT id, status, tx_hash, nonce, created_at,
       max_fee_per_gas, max_priority_fee_per_gas
  FROM outbound_txs
 WHERE chain_id = <chain_id>
   AND submitter = 'passport_revoke'
 ORDER BY created_at DESC
 LIMIT 20;
```

Each retry of `reconcileRevocation` opens a **fresh** outbound record, so
several rows for one agent is the normal state, not a defect. Interpret:

- **No rows at all** → nothing was ever broadcast. Read
  `revocation_last_error` from Step 1; the usual causes are the passport not
  being configured for that chain, or no revoker/probe wired. This is a
  configuration incident, not a nonce incident, and §4 does not apply.
- **A `broadcast` row** → a revoke is in flight. Go to Step 3.
- **Only `failed` rows** → the revoke is reverting rather than stalling. Read
  the error; a revert is a different incident from a stall and §4 does not
  apply to it either.

### Step 3 — is the lane blocked, and by whose transaction?

The relayer is **one wallet per chain, shared by every submitter** — sweeps,
hybrid deploys, passport attests, passport revokes. One stuck transaction
blocks every later one on that chain.

```sql
SELECT id, submitter, status, nonce, tx_hash, created_at
  FROM outbound_txs
 WHERE chain_id = <chain_id>
   AND status IN ('queued', 'broadcast')
 ORDER BY nonce NULLS LAST, created_at;
```

**The lowest blocked nonce is the one that matters, and it is frequently not
this revoke's.** If a `passport_attest` row sits at an earlier nonce, that is
the incident — it is the one submitter the bump worker refuses to fee-replace
— and it is governed by
[`delegation-rail-vendor-ops.md`](delegation-rail-vendor-ops.md) §3, not by
this runbook. Handle it there. Cancelling this revoke's nonce would do nothing
for the revoke and would not unblock the lane.

If the revoke's own row is the lowest blocked nonce, check whether the bump
worker is already handling it. Unlike `passport_attest`, **`passport_revoke`
IS on `REBROADCAST_SAFE_SUBMITTERS`** (a second revoke of the same UID reverts
`AlreadyRevoked` and moves nothing), so the worker fee-replaces it at the same
nonce, up to `MAX_BUMPS_PER_NONCE = 3`, scanning rows untouched for
`STALE_BROADCAST_SECONDS = 180`. Expect to see:

```
INFO  outbound-bump: replaced a stuck broadcast with bumped fees
```

While that is happening, **the automatic path still owns this row.** Only when
the lane has capped out does it become yours:

```
ERROR outbound-bump: nonce lane stuck after 3 replacements — INCIDENT, not retrying
```

## 3. "Landed and unconverged" — this self-heals, and here is how long

If Step 1 found the revoked bit set while the row still reads `pending`, the
system is already converging. Since #1758 `reconcileRevocation` asks the chain
"is this attestation already revoked, as of a settled block?" *before* it
spends any gas, and a `revoked` reading closes the row — regardless of which
transaction set the bit, whether Haven ever saw a receipt, or whether an
operator revoked by hand. It is a **pull**, so it converges cases no push from
the relayer's ledger ever could.

**How long to wait before doubting it** is arithmetic over three constants,
not a guess:

| Input | Value | Where |
|---|---|---|
| Settled-block lag | `finalized`, else head − 300 blocks | `SETTLED_CHAIN_READ_DEPTH_BLOCKS` |
| Retry backoff | `min(30 · 2^attempts, 3600)` seconds | `revocationBackoffSeconds` |
| Sweep interval | 5 minutes | `PASSPORT_SWEEP_INTERVAL_MS` |

The row cannot converge before its next scheduled attempt, and that attempt is
only taken on a sweep tick. So the honest bound is:

- **A young row** (few attempts) converges within roughly one backoff step plus
  one sweep tick after the bit becomes visible at a settled block — minutes.
- **A row already at the backoff cap** — which is where anything that has been
  alarming for a while sits — can take **up to about 65 minutes** after the bit
  settles: one capped hour, plus one 5-minute sweep tick.

Read `revocation_next_attempt_at` and `revocation_attempts` rather than
guessing which case you are in. **If the bit is set and the row has not
converged well past that bound, it is not slow — it is stuck for a reason**,
and that reason is in `revocation_last_error`. There is one known, deliberate
shape:

```
attestation already revoked on-chain, but no revoke transaction is recorded for it —
cannot record a confirmation without its evidence pointer (#1758)
```

This means the chain agrees, but Haven holds no **`mined`** `outbound_txs` row
for this exact revoke calldata to name as evidence. Migration 049 refuses
`confirmed` without a `revocation_tx_hash`, and only a `mined` row counts —
`broadcast` rows are not accepted, because several `broadcast` rows for one
calldata is the *normal* state here and exactly one of them did the work, with
nothing in the row to say which.

This is a **cosmetic-ledger** incident, not a credential incident. The
attestation is revoked; no merchant can be misled. What is wrong is that
Haven's audit column cannot name the transaction. The design refuses to invent
a plausible-looking hash and keeps alarming instead. Escalate it as a
reconciliation question; **do not** cancel a nonce or broadcast a revoke to
try to manufacture the evidence — a second revoke of the same UID reverts
`AlreadyRevoked`, so it produces a `failed` row, not a `mined` one, and cannot
create the pointer.

## 4. "Live and not landing" — the dangerous action

Reach this section **only** when all of the following are true. Do not
shortcut it; the check-first ordering is the safety property, and the remedy
below is not reversible.

> **Preconditions — every one of them, verified in this order:**
>
> 1. **§2 Step 1 read `revocationTime == 0` at a settled block**, with the
>    echoed UID matching. The attestation is genuinely live.
> 2. **§2 Step 2 found a `broadcast` row** for `submitter = 'passport_revoke'`
>    on this chain — a transaction actually exists to be cancelled.
> 3. **§2 Step 3 confirmed that row holds the LOWEST blocked nonce** on the
>    chain. If anything else is lower, that row is the incident; go there
>    instead.
> 4. **The bump worker has capped out** (`nonce lane stuck after 3
>    replacements — INCIDENT`). Below the cap it is still fee-replacing and
>    the row is not yours.
> 5. **You have listed every other `queued`/`broadcast` row on the chain**
>    (the Step 3 query) and read what a cancel releases — see the hazard
>    below.

**The hazard, stated plainly: a cancel does not act on one transaction. It
releases the lane.** Cancelling nonce N does not merely kill the transaction
at N; it lets everything at N+1, N+2 … mine, immediately and without further
review. On this shared relayer that queue contains other submitters' work —
sweeps, hybrid deploys, and possibly a `passport_attest`, whose duplicate is
silent and permanent. Precondition 5 exists so that you know what you are
releasing *before* you release it, not after. This is the same shape as the
hazard [#1735](https://github.com/d-hinders/Haven-AI/issues/1735)'s reviewer
caught in the attest runbook: the remedy was written before the check, and the
remedy's real blast radius was in the queue rather than in the transaction
being cancelled.

With every precondition met, the action is a **same-nonce cancel**: a 0-value
self-transfer from the relayer at that exact nonce, with bumped fees, so that
the stuck revoke can never mine.

- **Do this even if the transaction has vanished from the mempool.** A dropped
  transaction does not free its own nonce here: its row is still `broadcast`,
  and migration 061's partial `UNIQUE (chain_id, nonce) WHERE status =
  'broadcast'` refuses the stamp, so `submitRecorded` re-reads the same nonce
  and fails with `could not win a nonce lane`.
- **Do not hand-broadcast the stored revoke calldata, and do not hand-run a
  fee bump.** A hand-run bump leaves no `outbound_txs` record, so nothing
  downstream can see it — the same objection that makes it forbidden for
  attests applies here for the same reason.

**Afterwards, the revoke recovers on its own.** Once the cancel is final the
lane is clear, and the next sweep tick calls `reconcileRevocation`, which
probes the chain, finds the attestation still live, and submits a fresh revoke
at a new nonce. There is no further manual step, and no duplicate to hunt for:
a duplicate revoke is harmless on-chain (it reverts `AlreadyRevoked`) — the
thing you were protecting when you read precondition 5 was the rest of the
lane, not the revoke.

Confirm recovery by re-running §2 Step 1: the bit set, then the row reaching
`revocation_status = 'confirmed'` within the §3 bound.

## 5. How long is too long — an open owner decision (#1743)

**There is no threshold in the code that declares a revoke dead, and this
runbook does not invent one.**

The one hour in `PASSPORT_STUCK_REVOKE_SECONDS` is when the alarm starts
*reporting*. It is deliberately not a deadline. There is no terminal `failed`
revocation state — a struggling revoke stays `pending` and due, and retries
with capped backoff until the DB and the chain agree (owner decision
2026-07-24). PR #1786 declined to take a position on this, explicitly.

The question — how long a revoke whose attestation is genuinely still live may
go unlanded before Haven declares it dead — is the revoke-side face of
[#1743](https://github.com/d-hinders/Haven-AI/issues/1743) ("when is an attest
dead"), and it is an **owner decision that has not been made**.

Until it is: **this is a judgement the operator makes, per incident.** Weigh
the actual exposure — whether any merchant for this agent reads the chain
rather than the verifier, how long the divergence has run, and what else the
lane is holding. Record the judgement you made and why, on the incident. Do
not treat the one-hour alarm threshold as an escalation deadline, and do not
read a number out of this document that is not here.

## Related

- [`delegation-rail-vendor-ops.md`](delegation-rail-vendor-ops.md) §3 — the
  stuck **attest** procedure, and the shared-lane failure modes.
- [`backend-scaling.md`](backend-scaling.md) § *Single point of stall* — why
  one stuck transaction blocks a chain, and which submitter is the exception.
- [`../architecture/11-agent-passport-schema.md`](../architecture/11-agent-passport-schema.md)
  — the schema, the convergence evidence rule, and the merchant-facing
  "check the verifier, not only the chain" rule.
