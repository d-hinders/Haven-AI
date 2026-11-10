# Issue review rubric

The canonical rubric for [review-issue](../SKILL.md). Run every block that
applies; a block that does not apply is reported as *not applicable* with the
reason, never silently skipped. Blocks 1–7 apply to a standalone issue and to
each sub-issue of an epic; block 8 applies to the epic as a whole.

Each finding is evidence-backed and ordered `blocking` / `should-fix` / `nit`.
"Evidence" means the command and its output, or the comment and its author —
never a recollection of what the code or the thread said.

## 1. Measured claims

**Start with the runner (#4799).** Run `node scripts/docs/issue-method.mjs
--body-file <snapshot>` against a root whose `origin/dev` is GitHub's ref, and
paste its output. A `differs` line is a wrong claim; a `refused` or `unproven
zero` line is a should-fix finding; a SHA refusal that goes away once GitHub's
`dev` is fetched into `refs/remotes/origin/dev` is your setup, not a finding. The details, and what the runner does not
prove, are in [review-issue § The runner](../SKILL.md#the-runner-4799). Then
continue by hand, for every free-form claim and for whether each checkable line
says what the prose says.

Re-run every claim in the body against the commit the body names (`Measured on
origin/dev @ <sha>`), reading the statement that does the work — the `INSERT`,
the `UPDATE`, the `return`, the guard — never the comment above it.

Report each claim as exactly one of:

- **reproduces** — the command returns the stated value;
- **wrong** — with the measured value and the command that produced it;
- **could not verify** — with what was missing (an unfetched ref, a private
  surface, a command that needs credentials).

A claim the body states as a question ("verify whether … holds") is not a
measured claim; answer it if the code answers it, and say so.

**Instrument self-reference.** A claim made from a measurement states what the
instrument actually looked at. Reject a count taken over a multi-column listing
without filtering to the column, an absence claim made over an unfetched tree,
and a "the value appears in the output" conclusion drawn from a probe that was
passed the value.

**Drift.** When current `origin/dev` has moved past the named commit, record a
separate drift line: what changed on the paths the issue touches, and whether
that change invalidates a claim. Do not re-measure the whole body at the new tip
and do not silently rebase the issue.

## 2. Completeness

Find every other copy of the claim or pattern the issue fixes — code, comments,
env examples, docs, tests, skill text, generated artifacts — and list the ones
the scope misses. Name the historical records (CASP shards, archive, ledger
entries, dated bug reports) that must stay as written, so a later builder does
not "fix" history.

A scope that names one copy of a pattern that exists in five places is a
`blocking` completeness finding: the fix would leave four copies behind.

## 3. Acceptance criteria

For each criterion, apply the three questions from
[§ The three questions](../SKILL.md#the-three-questions-per-acceptance-criterion):

1. false today;
2. reachable after the work;
3. impossible to satisfy while the problem survives.

Then apply the mechanism check: **does the proposed mechanism observe the
required transition?** Name the mechanism and the transition. A criterion whose
probe cannot see the state it is meant to detect is `blocking`, however
well-formed its wording.

Flag specifically:

- a criterion that forbids the fix (a diff cap, a "must not touch" list that
  includes the file the fix lives in);
- a criterion that matches something unrelated (a grep that also matches an
  unrelated word, so it can never go green or never go red);
- a criterion already true on unchanged code;
- a criterion whose guard would be made vacuous by the change (a rename inside a
  "must stay absent" test);
- a test fixture that already passes without exercising what its name claims.

## 4. Guards

Would the change as scoped weaken a test, lint, ratchet, or guard? Name the
guard, the mechanism by which it stops guarding, and the regression case that
would catch it. A guard that goes vacuous is worse than a missing guard, because
it reports green.

## 5. Levers

Name anything that could break an installed client or a live path:

- SDK, signer, connector, credential file, env var, persisted browser storage;
- a wire field or an API response shape;
- a live payment path, an x402/MPP flow, a merchant integration;
- migration ordering, a backfill, a schema change;
- a release train, a published package version, a dist-tag.

Each lever is either settled in the body or recorded as an open question naming
who answers it.

## 6. Gaps

List what the scope does not say that a builder would have to decide: naming,
file placement, error copy, retry policy, the shape of a new field, what happens
on the empty case. Answer any question the issue poses where the code answers it.

A gap that two builders would decide differently is a `should-fix`; a gap that
changes money movement, authority, or a schema is `blocking`.

## 7. Producer/consumer contracts

For any issue that adds or changes a state, a field, or a message between two
components, check each of these and say which the body addresses:

- **Detectable state transitions** — can the consumer tell the new state from the
  old one, and is the transition observable at the point the consumer reads?
- **Persistence scope** — what is stored, where, for how long, and what happens
  when the store is unavailable.
- **Idempotency** — what happens when the same operation is applied twice.
- **Retry and response-loss** — what the producer does when the response is lost
  after the write, and what the consumer does when it retries.
- **Concurrency** — two writers, two readers, a read during a write; which one
  wins and how that is decided.
- **Bounded time windows** — every timeout, TTL, and window has a stated value
  and a stated behavior at the boundary.
- **Replay behavior** — what a replayed message or a re-run of the job does.
- **Device/server scope** — which side owns the state, and what the other side
  does when it disagrees.

## 8. Money statements and authority semantics

When the issue is `money-path`, or touches spend authority, signing, budgets,
x402/MPP, or custody, read
[`docs/regulatory/casp-risk-guardrails.md`](../../../../docs/regulatory/casp-risk-guardrails.md)
and check the body against it. For an epic, run this block **per slice** when
any slice carries `money-path`, and report the epic-level block as applicable
only when the epic itself carries the label:

- who can spend, from which wallet, how much, on what, and when approval is
  required;
- whether the body implies Haven holds keys, that API credentials are sufficient
  to spend, or that off-chain policy is the real spend control;
- whether a user can still enumerate and revoke delegations and manage signers
  outside Haven;
- whether a `## Threat model` section exists when the remedy narrows who can
  sign, move, or authorize something, and whether it names the trusted actors,
  the invariant, and the accepted residual.

A money statement that is wrong, or an authority claim that contradicts the
guardrails, is `blocking` in any doc or issue body.

## 9. Design-system obligations

For `area:frontend`, compare the issue's `## Design system` section with
[`docs/product/design-system.md`](../../../../docs/product/design-system.md#patterns)
and the existing component usages:

- the matching existing Pattern is named, or the absence is explained;
- the components it will change are listed **with their other usages**;
- a proposed **new pattern** is labeled as one and carries its own
  design-system-first slice and owner approval;
- the copy obligations in
  [`docs/product/copy-guidelines.md`](../../../../docs/product/copy-guidelines.md)
  are reachable from the scope.

A missing Pattern, an incomplete caller list, or an unlabeled new pattern is
`should-fix`; a new pattern consumed by a product page without its own slice is
`blocking`.

## 10. Epic mechanics

For an epic, check the tracking issue and every attached sub-issue:

- **Attached sub-issues** — the real GitHub parent/sub-issue links exist, not
  only checklist prose. A slice tracked only as prose resolves to nothing for
  `ship-next epic=#<n>`.
- **Sequencing** — the build-order list in the body agrees with the sub-issue
  numbers and with every `Depends on` reference; a slice that presupposes code
  another slice creates is ordered after it.
- **Shared-file collisions** — two slices that write the same file are either
  sequenced or merged into one slice. Name the file.
- **Labels** — the tracking issue carries `epic`; slices do not carry
  `code-quality`; every slice carries its `area:*` labels and `money-path` when
  applicable.
- **`pending-review`** — every slice carries it from creation, and the epic's one
  verdict satisfies the review condition for every slice while the owner-question
  condition is judged per slice.
- **Documentation routing** — the docs whose `covers:` mapping the change
  implicates are named, and the issue says which of them it updates.
- **Promotion checklist** — one unticked box per operator step, each naming where
  it is done, plus one box for the epic's product verification. Every box must be
  able to reach a ticked state truthfully: a box that can never be true, or one
  already true on unchanged code, is a `should-fix`. A box only a promotion can
  satisfy is filed as its own `Next release` issue and the box rewritten to link
  it.

## 11. Prior verdicts and owner decisions

When the issue already carries a verdict, run the delta rules in
[§ Delta-aware passes](../SKILL.md#delta-aware-passes): recheck each claimed
correction, read every later owner decision, review the changed scope plus the
cross-slice invariants, and do not repeat a resolved finding.

An owner decision recorded in a comment but absent from the body is a
`should-fix`: a builder reads the body it picked up, not the thread it was
replaced in.
