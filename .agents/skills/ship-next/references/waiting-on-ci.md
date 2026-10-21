# Waiting on CI — mechanics

Loaded by [`ship-next`](../SKILL.md) § *Merge Gate* before any wait on a PR's
checks or its auto-merge.

Do not burn fixed-timeout `sleep` loops against `gh pr checks`.

- **Auto-merged PRs:** `--auto` ([*Merge Gate*](../SKILL.md#merge-gate)) means GitHub merges when green — but **no
  GitHub event re-invokes a local session**, so "armed" is not "watched". When the
  next step depends on the merge (releasing claims, ticking the epic, taking the
  next queue item), arm a Monitor or a background watch and act on its result;
  otherwise check the PR's state at the next natural opportunity instead of
  assuming it landed. Two silent-stall states to know: `DIRTY` after arming means
  no checks run and no merge ever comes (read `mergeStateStatus`, don't wait), and
  a required check failing means auto-merge simply never fires.
- **Editing the pull-request body re-runs the checks that read it** —
  *Docs front-matter & agent skills* (a required context on `dev`, so it blocks
  the merge while it runs), *PR ownership gate* and *External intake gate*
  (neither required on `dev` yet, per the ruleset inventory in
  `autonomous-pr-loop.md`). A merge attempted right
  after the last body edit — filling the verdict lines, say — is refused until
  the re-run finishes. Fill the body before the final CI wait, or wait the
  re-run out. On PR #3221 the body was edited at 16:47:31Z and the re-runs ran
  16:47:34–55Z before the merge at 16:48:13Z; on PR #3224, 18:50:35Z,
  18:50:38–57Z, 18:51:21Z.
- **Known infra flakes:** a required check failing with a known infrastructure
  signature gets **one rerun before any diagnosis** (`gh run rerun <id> --failed`).
  The signature list lives in
  [`autonomous-pr-loop.md`](../../../../docs/contributing/autonomous-pr-loop.md) §
  *Known CI flake signatures* — check the failing job's log against it first; a
  second failure after the rerun is a real failure.
- **When a wait is genuinely needed** (holding a UI PR on a review finding, or
  confirming a specific run), poll the condition below, or arm a Monitor on it if the
  client supports one. Not `gh pr checks <pr> --watch --fail-fast`: it resolves on
  the checks that *exist*, so it returns before the ones that have not been created
  yet, which is the same hole as an empty rollup.
- **A wait loop's terminal condition is the ruleset's named list, not a count, and
  cannot be satisfied by an empty rollup.** Before the first run is created,
  `statusCheckRollup` is empty, and an empty list satisfies both "nothing in
  progress" and "nothing failed". A count is the wrong floor too: on PR #2503, 6 of
  the required contexts concluded `SUCCESS` and 9 `SKIPPED` (surface-gated behind *Detect changed
  surfaces*), so a predicate that accepts only `SUCCESS` never reaches the full set. The
  expected set is the ruleset's, read live and documented in
  [`autonomous-pr-loop.md` § One-time GitHub setup](../../../../docs/contributing/autonomous-pr-loop.md#one-time-github-setup-required)
  step 3 (a context listed there but absent from the rule is a pending operator
  step, #2321):

  **Read `$REQ` from the PR's OWN base branch**, which is what `BASE` below is for.
  Hardcoding `dev` on a promotion PR silently drops the four contexts required on
  `main` alone (`gate`, `qa-freshness`, Design visual regression, Frontend browser
  smoke), so the loop reports green on a set it never checked:

  ```bash
  BASE=$(gh pr view <pr> --json baseRefName -q .baseRefName)
  REQ=$(gh api repos/<o>/<r>/rules/branches/"$BASE" --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]')
  gh pr view <pr> --json mergeStateStatus,statusCheckRollup | jq --argjson req "$REQ" '
    (.statusCheckRollup | map({name: (.name // .context), c: ((.conclusion // .state // "PENDING") | ascii_upcase)})) as $r
    | { state: .mergeStateStatus,
        missing: [ $req[] | select(. as $n | $r | map(.name) | index($n) | not) ],
        failed:  [ $r[] | select(.name as $n | $req | index($n)) | select(.c | IN("FAILURE","ERROR","CANCELLED","TIMED_OUT")) | .name ],
        pending: [ $r[] | select(.name as $n | $req | index($n)) | select(.c | IN("SUCCESS","SKIPPED","NEUTRAL","FAILURE","ERROR","CANCELLED","TIMED_OUT") | not) | .name ],
        nonrequired_failed: [ $r[] | select(.name as $n | $req | index($n) | not) | select(.c | IN("FAILURE","ERROR")) | .name ] }'
  ```

  The loop ends **only** on one of three outcomes, tested in this order: **red** —
  `failed` non-empty (a **required** context with a failing conclusion; `CANCELLED`
  means read `gh run list --commit <sha>` for the superseding run before believing
  it); **green** — `missing`, `failed` and `pending` all empty **and**
  `state ∈ {CLEAN, UNSTABLE}`, plus `BEHIND` on a PR **based on `dev`** —
  `UNSTABLE` *is* green here: every required context
  is satisfied and something non-required failed (#2503 merged clean with `Vercel`
  = `FAILURE`; name `nonrequired_failed` in the report, never stop on it); or
  **stuck** — the three lists empty and `state ∈ {BLOCKED, DIRTY}`, plus `BEHIND`
  on a PR **based on `main`**, which is a review requirement, a conflict or a
  stale promotion head, not CI: stop waiting and act on the state (`DIRTY`
  guidance is in [*Merge Gate*](../SKILL.md#merge-gate)). `BEHIND` is the one state whose verdict depends on the base
  branch, because only `main` still requires an up-to-date head (#2632). Anything else — a non-empty
  `missing` or `pending`, an empty rollup, `state: UNKNOWN` (GitHub has not computed
  mergeability for that head yet; measured to persist across re-reads on a freshly
  pushed PR) — keeps waiting under a wall-clock ceiling you state, and a loop that
  outlives the ceiling reports that, not green. The rollup mixes `CheckRun`
  (`status`/`conclusion`/`name`) and `StatusContext` (`state`/`context`) shapes, which
  is why every field above is read with a fallback.
- **A promotion PR into `main` merges `BEHIND`.** `main` is still strict, and you
  cannot update the PR: its head is `dev`, which refuses direct pushes. It merges
  behind, with no sync-back, from the ordinary **Merge pull request** (merge
  commit) button in the web UI, which any of the three maintainers may press
  ([`branch-and-release-flow.md`](../../../../docs/contributing/branch-and-release-flow.md)
  § *Promotion to production* records both rules). BEHIND is expected on it, not a
  defect to clear — say so, never run `gh pr update-branch` on it.
