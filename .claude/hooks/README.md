# Claude Code hooks — scripts committed, wiring is personal

These scripts are **committed**. The `settings.json` that would activate them is
**not**. That split is deliberate, not an oversight.

## What they do

`ship-next-guard.sh` warns — never blocks — when a pull request is opened
outside Haven's `/ship-next` route, and injects the three things CI does *not*
cover: review of the complete diff, the `covers:` doc-reviewer step, and
CODEOWNERS migration routing. It used to list a fourth (the acceptance gate),
dropped once [#1023](https://github.com/d-hinders/Haven-AI/issues/1023) made
that a CI required check. `ship-next-marker.sh` records that `/ship-next` is
genuinely driving so the guard stays quiet on a compliant PR. It writes one
**token per issue** ([#1028](https://github.com/d-hinders/Haven-AI/issues/1028));
the guard reads `Closes #N` off the pull request and clears that token. It used
to be a single flag the guard consumed, which warned on the 2nd PR of a session
that shipped several issues — a false positive on a *compliant* PR, i.e. the
nag-fatigue failure the guard exists to avoid.
`session-notice.sh` states the shipping *default* at the top of a session
(a default, not a mandate — [#1025](https://github.com/d-hinders/Haven-AI/issues/1025)).
`test-ship-next-guard.sh` is the self-test — 101 cases, including a mutation-verified
set for the token-matching rules (see the commit for #1028).

**Residual gap, deliberately noisy:** two consecutive *no-argument* invocations
(`/ship-next` with no issue) share one wildcard token, so the second such PR
warns. A spurious warning costs a moment; a spurious silence costs the guard.

**One-time transition cost.** Markers written before #1028 are zero-byte files.
The new guard treats an empty marker as *no tokens* and warns — correctly, since
"the file exists" was exactly the permission-by-existence flaw being removed.
A session already in flight when you pull this therefore gets one spurious
warning; new sessions are unaffected, and `session-notice.sh` now prunes empty
markers on startup. Observed on PR #1032, which is this change itself.

Background: [#1016](https://github.com/d-hinders/Haven-AI/issues/1016),
[#1018](https://github.com/d-hinders/Haven-AI/issues/1018),
[#1020](https://github.com/d-hinders/Haven-AI/issues/1020).

## Why the wiring is not committed

`.claude/settings.json` is the **team-wide** tier: committing hooks there turns
them on for everyone running Claude Code in this repo, on their own machines,
as soon as they pull. Two reasons that is premature:

1. **The marker is not yet proven across sessions.** If it fails, the guard
   warns on *every* PR including correctly-opened ones — the nag-fatigue outcome
   the guard exists to prevent, inflicted on people who never opted in.
2. **`sh`, `jq` and `awk` are assumed.** On Windows without Git Bash the hooks
   are *silently inert* — no warning, no error, no signal. A teammate could
   believe the guard is watching when it is not, which is worse than not having
   it.

Keeping the scripts committed means promoting later is re-adding the wiring, not
redoing the work.

## Turning them on for yourself

Add a `hooks` block to `.claude/settings.local.json` (gitignored, personal).
Resolve the path with `${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel
2>/dev/null || echo .)}` — `CLAUDE_PROJECT_DIR` is **not** always set, and
without the git fallback the guard is inert anywhere but the repo root.

Verify with a **positive control**, not by the absence of a warning: with no
marker present, a PR-shaped call must still warn. "No warning appeared" is
equally consistent with "the hooks never loaded", and that ambiguity is exactly
how a broken guard survives.

```sh
sh .claude/hooks/test-ship-next-guard.sh   # 101 passed, 0 failed
```

## Promotion criteria

Move the wiring into a committed `.claude/settings.json` once **both** hold:

- the marker has been observed silencing a compliant PR in a fresh session, and
- the `sh`/`jq`/`awk` assumption has been checked against the team's machines.

## `reviewer-marker.sh` + the reviewer gate in `ship-next-guard.sh`

**Blocking**, unlike everything else here. `ship-next-guard.sh` now enforces two
separate policies at the same trigger point (pull-request creation), and the
difference between them matters:

| | subject | force |
|---|---|---|
| ship-next warning | which *route* opened the PR | warns, never blocks (owner decision 2026-07-26) |
| reviewer gate | whether an independent review *happened* | **blocks** (owner decision 2026-08-21) |

`reviewer-marker.sh` records a pass when a `haven-reviewer` subagent is
actually launched; the gate blocks PR creation when no pass is recorded for the
current branch. **`haven-design-reviewer` does not clear it** — on
`area:frontend` it is a second pass, not a replacement (`AGENTS.md`), and
accepting it would let a pull request satisfy an unconditional rule while never
running `haven-reviewer` at all.

### Why blocking, when the sibling policy deliberately is not

The warning already named independent review as its item 1, ending "This warning
does not block. It is on you." It was walked past three times in one session,
each time with a different plausible-sounding reason. The owner's instruction
was unambiguous and repeated — "I want it to run on every PR, full stop" — so
the gate stops being advice.

This is the same argument `ship-next-marker.sh` makes about markers the model
must remember to write, applied one level up: a rule the model re-derives per
pull request is not a rule.

### Design notes

- **Keyed by branch, not commit.** A head-SHA key would demand a fresh pass
  after every touch-up and train people to route around the gate. Branch scope
  asks what the failure was actually about: did an independent pass ever look at
  this work? Reviewing at one commit and then pushing unreviewed *fixes* is a
  real gap this cannot see — the warning still names it, and it stays judgement.
- **Not consumed.** Unlike the ship-next token, a recorded pass survives the
  pull request. "Review happened for this branch" does not stop being true.
- **Fails open** on its own malfunction — missing `jq`, detached HEAD, or an
  existing **regular file** at the marker path that cannot be read. A guard that
  blocks all PR creation when its plumbing breaks gets removed, and then it
  guards nothing.
- **But "malfunction" is narrow, and that boundary is load-bearing.** Anything
  at the marker path that is not a readable regular file — a directory, a
  symlink loop, a dangling link — is treated as ABSENCE, and absence blocks.
  A version of this hook briefly failed open on all of them, reasoning that path
  malfunctions are symmetric. They are not: `reviewer-marker.sh` only ever
  appends to a regular file, so a directory at that name cannot come from a real
  pass. Since the path is deterministic and the session id is known to the
  calling agent, `mkdir -p "$TMPDIR/claude-reviewed-$SESSION_ID"` silenced the
  entire gate in one command — with three tests certifying it as intended. If
  you ever widen this condition, that is the case to think about first.
- **Bypass** by unsetting the hook — and say in the pull request that review was
  skipped and why. Do not do it silently.

Covered by `test-ship-next-guard.sh` (the reviewer-gate section at the end).

### Status: NOT wired, and the promotion criteria are not met

This gate ships as scripts only, like everything else here. It enforces nothing
until someone adds the wiring to their own `settings.local.json`, and the
**Promotion criteria** above — marker observed working in a fresh session, and
the `sh`/`jq`/`awk` assumption checked against the team's machines — are both
still open. They matter *more* for this hook than for the warning they were
written for: a warning that misfires is noise, but a blocking gate that misfires
stops every pull request for whoever wired it, and one that is silently inert
(Windows without Git Bash) tells them nothing while they believe they are
covered.

Do not read the rule as depending on this. The reviewer pass is unconditional
either way; the hook is what stops the rule being re-litigated per pull request
by whoever opts in.

### One assumption not yet verified live

`reviewer-marker.sh` keys on `tool_name` in `{Task, Agent}` with
`tool_input.subagent_type`. No other hook here encodes that shape, and it cannot
be exercised end to end without committed wiring. If the real field names differ,
the marker is never written — and because "no marker" means *block*, every pull
request would then block for whoever wired it. Verify with a positive control
before relying on it: run a reviewer subagent, then confirm a
`claude-reviewed-*` file appeared under `TMPDIR`.

### On "enforce outcomes, never tooling"

CLAUDE.md says exactly that, and deliberately builds no check for whether
`ship-next` was used. This gate is a narrow, deliberate exception, and worth
naming as one rather than letting the two statements quietly disagree.

The distinction it rests on: the gate asks whether an independent review
*happened*, never which workflow ran or which route opened the pull request.
Both remain free. The honest limit is that it observes a reviewer being
*launched*, not findings being *applied* — launch-and-ignore satisfies it. That
is a real gap, it is judgement, and no hook is going to close it. What the hook
removes is the step where the rule gets re-argued from scratch on each pull
request, which is the failure that actually happened.
