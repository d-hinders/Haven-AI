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
genuinely driving so the guard stays quiet on a compliant PR — **it has a known
false-positive on a second PR in one session, see
[#1028](https://github.com/d-hinders/Haven-AI/issues/1028)**.
`session-notice.sh` states the shipping *default* at the top of a session
(a default, not a mandate — [#1025](https://github.com/d-hinders/Haven-AI/issues/1025)).
`test-ship-next-guard.sh` is the self-test — 58 cases.

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
sh .claude/hooks/test-ship-next-guard.sh   # 58 passed, 0 failed
```

## Promotion criteria

Move the wiring into a committed `.claude/settings.json` once **both** hold:

- the marker has been observed silencing a compliant PR in a fresh session, and
- the `sh`/`jq`/`awk` assumption has been checked against the team's machines.
