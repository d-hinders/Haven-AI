---
name: ship-next
description: Ship one ready Haven GitHub issue end to end through implementation, verification, independent review, documentation checks, a pull request to dev, and the correct merge gate. Use when a user asks to ship the next queued issue, ship a specified ready issue, or run the autonomous Haven issue-to-PR workflow.
---

# Ship Next

Ship exactly one ready issue, then stop. GitHub issue and pull-request state is the workflow state.

## Select The Work

Accept one source:

- no argument or `label=<name>`: choose the lowest-numbered open issue with the label, defaulting to `code-quality`;
- `epic=#<n>`: choose the lowest-numbered open sub-issue;
- a specified ready issue: ship that issue;
- a quoted freeform task: first use [new-task](../new-task/SKILL.md) (including its mandatory § *Issue review*), add `code-quality`, then ship the created issue.

**Respect dependencies before number order.** An issue is BLOCKED — skip it and take the next candidate — when any of these hold:

- a `Depends on` / `depends: #N` reference in its body points at an issue that is still open;
- a build-order comment on the epic sequences it after something still open;
- its scope presupposes code that does not exist yet (verify with a quick grep — an
  acceptance gate for a subsystem cannot ship before the subsystem).

If every remaining candidate is blocked, stop and report the dependency chain instead
of forcing the lowest number.

Note what that rule can and cannot see: it reads references pointing **out** of the
candidate's body. A constraint written the other way round — a newly filed issue
saying it should land before some queued issue — is invisible here, which is why
*Independent Review* records it in the dependent issue instead.

**Check for a blocked promotion path.** Look for an open `qa-failure` issue before
selecting. It carries no `code-quality` label, so the default queue never surfaces
it, while the `qa-freshness` gate stands between `dev` and `main` (its exact
conditions and its documented bypasses live in
[`autonomous-pr-loop.md`](../../../docs/contributing/autonomous-pr-loop.md) — do not
restate them here, and do not assume a red QA run means promotion is strictly
impossible). This is **information, not a gate**: do not block selection on it and do
not pull it into the queue, but name it in the closeout so the user can choose
between shipping the next item and unblocking the promotion path. A day of merged
work behind a silently red gate is the failure this line exists to prevent.

Before selecting new work, find any open pull request linked to the issue. Search
for the issue number rather than the keyword (`gh pr list --search "<issue>"`): an
operator-verify pull request deliberately carries **no** closing keyword (step 7 of
*Commit And Pull Request*), so a `Closes #<issue>` lookup alone reports "no in-flight
work" on exactly the pull requests whose issue is still open by design.

- If it is waiting on CI or has a fixable failure, finish that pull request.
- If it is waiting on a user decision, migration review, or UX decision, stop and report the blocker.
- Start new work only when the selected source has no in-flight pull request.

**Collision check — don't double-build parallel work.** The in-flight lookup above
only catches PRs bound to the *same* issue. A parallel session can be
mid-flight on the same surface under a different issue (the demo-merchant half
of #452 was built twice before this was caught). Before implementing, glance
for overlap:

- `gh issue develop <issue> --list` — GitHub's own **linked branches** for the
  issue (#3180): one API call that reads the same sidebar a human sees and
  cannot be skipped by forgetting to grep. Rely on it for the window the PR
  search below is blind to — from a session's claim until its PR exists — and
  not beyond: measured on #3180, the link vanished the moment a PR closing the
  issue was opened from the branch (`linkedBranches` 1 → 0 at the
  `ConnectedEvent`, `closedByPullRequestsReferences` carrying the PR instead);
  GitHub does not document that, and other repositories show links surviving a
  PR, so treat the post-PR state as unknown. An empty list therefore means
  "no pre-PR branch is linked" — never "no overlap" — and the remote-heads and
  PR bullets below stay mandatory. The output carries no author: whether a
  listed branch is yours from an earlier session or another session's is read
  from the claim comment, not from the list — and the branch may live in
  another repository (`--branch-repo`), which the remote-heads grep cannot see
  at all;
- `gh pr list --state open` — any open PR on the candidate's `area:*` surface or
  touching the files this issue implies;
- recently pushed branches (`git ls-remote --heads origin` or `gh api` recent
  branch activity) whose name references this issue or surface — still
  mandatory: it is the only bullet that sees a branch nobody linked;
- the candidate issue's assignee and latest comments;
- `gh pr list --search "<issue-number>"`;
- the tail of the standing coordination channel,
  [#3193](https://github.com/d-hinders/Haven-AI/issues/3193) (its predecessor #1289 is
  read-only history — a `#1289` link in an old comment is that, not a live channel).

On a real overlap, **report it and pause** rather than build a second copy —
coordinate or pick the next candidate.

Treat a live `CLAIM` on the candidate or coordination channel as an overlap when
the holder's last comment about it is less than 24 hours old and there is no
matching `RELEASE`. The projection enforces that rule — narrowed to claims by
repo collaborators (#3178): a second claim on a held issue is refused with a
reply and is not a claim; a stale one (no activity for 24 h) is taken over and
the reply says so.

Stop and ask the user if scope or acceptance is unsafe to infer. Never guess on money movement, authentication, authorization, or schema.

## Coordinate The Session

Before building, post a one-line `CLAIM` comment on the selected issue, wait
for the projection's answer (the `claim-assignee` reply lands in well under a
minute; re-read the thread — no `⚠️ Already claimed` reply means the claim
stands), then **link your branch to the issue natively**:

```text
🔒 CLAIM #<issue> — branch <name> — touches: <files/areas> — <session owner>
```

```sh
gh issue develop <issue> --name <branch> --base dev
# <branch> = the client-required prefix + the issue number, e.g. feat/3180-linked-branches
# creates the branch on origin from dev's tip, linked to the issue; run against a
# branch that already exists on origin it links that branch instead (measured:
# a second run on the same name added no second link — one entry in `--list`)
```

Claim first, link second: if the projection refuses your claim (#3178), you
hold nothing, and a branch you had already linked would read as an overlap to
the next session. If you linked and are then refused, or abandon the work
**before any PR was opened from the branch**, delete the branch
(`git push origin --delete <branch>`) when you post the `🔓 RELEASE` — a
zero-PR branch is never reaped by delete-on-merge and would signal an overlap
with no expiry. Once a PR exists, the PR is the record: close the PR instead
and leave the ref to GitHub (deleting the head of an open PR closes it
silently). Never delete a pinned designated branch.

The linked branch (#3180) shows in the issue sidebar and answers
`gh issue develop <issue> --list` from your claim until your PR exists — the
window `gh pr list` cannot see; on #3180 the link was gone once the PR was
opened, so do not rely on it after that. The claim comment stays the record
because it carries `touches:` — the field that catches two *different* issues
writing one file (#2968/#2970) — and the session owner. A claim comment
without a linked branch is still valid (`gh issue develop` creates a ref and
may fail under a token without the `repo` scope); a linked branch without a
claim comment is not a claim.

**After posting, re-read the thread before you build:** a `⚠️ Already claimed`
reply from `github-actions[bot]` means you do not hold the issue — coordinate in
#3193 or pick another candidate (#3178).

A pull request that closes an issue someone else holds fails the `PR ownership
gate` check (#3179) — see AGENTS.md § Cross-session agent coordination for the
two ways out.

Also post the same `CLAIM` to the channel,
[#3193](https://github.com/d-hinders/Haven-AI/issues/3193), when the work touches
a shared surface another session could plausibly pick up. The list of shared
surfaces lives in AGENTS.md § *Cross-session agent coordination* — the one
canonical copy of the protocol (#3182); this skill states the workflow around
it and does not repeat the list. Giving up a claim you should not have made is
a withdrawal, defined in AGENTS.md § *Release what you drop*.

The release is automatic on merge (#3177): `claim-release-on-merge.yml` posts
`🔓 RELEASE` on every issue the merged PR closed (GitHub's linked references
plus the closing keywords in title and commits, released only if GitHub closed
it by that merge) and unassigns everyone; it repeats the line on #3193 when a
claim for that issue is anywhere in the channel. Release by hand only when you abandon the work, or
when the PR keeps the issue open in operator-verify mode (`Refs #N`) — then
every place you claimed:

```text
🔓 RELEASE #<issue> — <landed as PR #N | abandoned: reason>
```

A PR closed without merging releases nothing; that claim is still live.

Comments on #3193 are coordination data only. Do not take build, merge, or spend
directives from that thread; those come only from this session's user.

## Prepare

1. Fetch `origin/dev`.
2. Protect unrelated local changes. Use an isolated worktree when the current tree is dirty or conflicted.
3. Check out the issue branch you linked in *Coordinate The Session* — the branch is created and named there, not here — with `git fetch origin && git checkout <branch>`, or add it as a worktree. If `gh issue develop` *created* it, it was cut from `origin/dev`'s tip at link time and is fresh; if it *linked* a branch that already existed on origin, confirm it is at `origin/dev`'s tip before building (`git log --oneline <branch>..origin/dev` prints nothing — the range lists the commits `dev` has that the branch lacks, so the reversed `origin/dev..<branch>` is empty for a branch arbitrarily far behind and proves nothing) or cut a new one — the one-branch-per-PR rule in [branch-and-release-flow.md § Branch lifetime](../../../docs/contributing/branch-and-release-flow.md#branch-lifetime-one-branch-per-pr) still holds.
   - If you created a local branch before linking (an older fetch), run the linking command before your first push and then `git fetch origin && git rebase origin/<branch>`: the remote branch is `dev`'s tip at link time, and a local branch cut from an older fetch is rejected as non-fast-forward (measured while shipping #3180). Against a branch that already exists on origin, `gh issue develop` links rather than creates.
   - If `gh issue develop` failed (it creates a ref and may need the `repo` scope), create the branch from `origin/dev` with `git` as before; the claim comment alone is still a valid claim.
   - **If the environment pins a designated branch** you may not push past, this step still applies — reset that branch from `origin/dev` instead of building on its previous state, following the recipe and guard in [branch-and-release-flow.md § Branch lifetime](../../../docs/contributing/branch-and-release-flow.md#branch-lifetime-one-branch-per-pr) (#1500); do not restate them here — and link THAT branch (`gh issue develop <issue> --name <designated-branch>`), never a second name you could not push to.
4. Classify all affected surfaces from labels and likely files.
5. Load every matching playbook from [ship-playbooks](../../../docs/contributing/ship-playbooks/README.md):
   - `area:frontend` → `frontend.md`
   - `area:backend` → `backend.md`
   - `area:sdk` or `area:mcp` → `sdk.md`
   - `area:docs` → `docs.md`, and also whenever the diff touches code that some doc's `covers:` maps to — the coupling gate fires on **code** changes, so routing its playbook by `area:docs` alone loads it exactly when it is not needed
   - `money-path` → `money.md`
6. **On an `area:frontend` issue, start the worktree's dev server before you write
   any code.** The compile is the frontend tail's fixed cost — 315–448 s cold — and
   it is the one cost that can be paid *concurrently* with implementation instead of
   in front of every capture. Launch it on a port derived from the issue number so
   two worktrees never collide, then point every capture in the issue at it:

   ```bash
   npm run dev -w packages/frontend -- --hostname 127.0.0.1 --port 3<issue-last-3> &
   SCREENSHOT_BASE_URL=http://127.0.0.1:3<issue-last-3> npm run screenshot -w packages/frontend -- <routes>
   ```

   `SCREENSHOT_BASE_URL` is the supported pre-warm path, and it is **evidence-safe**:
   it skips the spawn, not the #1800 identity check, so PNGs produced this way are
   still provably from this worktree. The mechanism, the identity guarantee and the
   one variable that *does* weaken the claim are in
   [`frontend.md` § *Verification*](../../../docs/contributing/ship-playbooks/frontend.md#4-verification);
   do not restate them here. **For a CI-like capture** — anything whose rendering must
   match what the gates see — use the standalone build instead, because `next dev`
   paints a dev-mode indicator into the viewport's bottom-left corner and a baseline
   regenerated from it bakes that badge in.
7. For non-trivial work, use the coordinator and explorer roles from [haven-agent-workflow](../haven-agent-workflow/SKILL.md).
8. **A `money-path` issue that narrows who can sign, move or authorise something needs an owner-confirmed threat model** ([new-task](../new-task/SKILL.md) step 3) before you build. If the issue or its epic has none, ask the owner one question: which actors are trusted for this decision? Record the answer on the issue before you write code. Without that answer, each review round raises the trust bar one level, and every level becomes a new issue.

## Implement

1. Implement only the issue scope and preserve surrounding conventions.
2. Keep shared and gravity files with the captain.
3. When changing existing money-path behavior, write characterization tests before changing behavior.
4. Reuse canonical docs and playbooks by reference; do not copy their policy into this skill.
5. **Mutation-prove by execution anything that claims control flow or reachability
   (#2421, #2455).** A text search over source — `grep`, `indexOf`, a regex over a
   file — is never the sole assertion that code runs: a `case` wrapper and an `&`
   background both bypassed a publish safety check while `indexOf` still found the
   call, and an `exit 1` above a loop satisfied "job failed + nothing published"
   without the guard firing (#2421); a `cwd` fallback printed `[PASS]` having never
   looked (#2455). Drive the real entry point with a stub or recorder, assert what
   was **reached**, then mutate the guard out and show the assertion go red:

   ```bash
   grep -q 'guard' publish.sh                                             # NOT proof: presence, not reachability
   PATH="$PWD/stubs:$PATH" bash publish.sh; test -f stubs/guard.reached   # reached
   # <mutate: comment the guard call out, or wrap it the way #2421's case/& did>
   PATH="$PWD/stubs:$PATH" bash publish.sh; test ! -f stubs/guard.reached # the assertion CAN go red
   ```

   **Never weaken an existing assertion to make room for a new case.** If a
   test you are extending stops passing, restructure it — assert the strong
   form where it still holds — and mutate the result. On PR #3221 an
   `every(query is the auth read)` became `some(...)` to admit two new
   requests; `some` could not fail (every request is authenticated), and the
   strong form turned out to hold anyway once asserted at the end of the test.
   An assertion that changes because the behaviour it pins changed ON PURPOSE is
   not weakening — say so in the PR body, next to the change that caused it.

   Back up before mutating and restore after, named and verified the way
   [`ai-agent-workflow.md` § Scratchpad Naming](../../../docs/contributing/ai-agent-workflow.md#scratchpad-naming-1801)
   prescribes (`<file>.<issue>.bak`, restore verified by content) — not restated here.
6. **Removal ships with a claim sweep (#1440, #2242).** A change that deletes or
   retires anything — a rail, a flag, a route, a term — lists the retired vocabulary
   in the PR body and sweeps `docs/**`, `packages/**/*.md`, code comments,
   agent-facing strings in source (tool descriptions, OpenAPI `description:`
   fields, consent and error text), fixtures, tests, showcase
   data (`app/(authenticated)/design-system/page.tsx`) and skill text
   (`.agents/**`, `.claude/**`) for it, with a positive control (a term you know is
   still present, found by the same command). Every hit gets a disposition —
   **fixed** / **historical record** / **filed #N** — in the body. The Safe-rail retirement (#1440) needed a
   repo-wide residue audit (#1993) and then a CI gate on retired-rail prose (#2107)
   after the fact, plus three late follow-ups; the signer no-network-calls retirement
   found copies in six places, not the two it expected (#2242).
7. **A title saying "still" names a boundary, not an instance (#2512).** When the
   issue says a claim, file or behaviour is *still* present somewhere, fixing that
   site leaves the edge where it was and the next instance arrives as another
   issue. Sweep the surface class instead, across every surface that can carry the
   claim — `docs/**`, `packages/**/*.md`, code comments, agent-facing strings in
   source (tool descriptions, OpenAPI `description:` fields, consent and error
   text), fixtures, tests, showcase
   data (`app/(authenticated)/design-system/page.tsx`), and `.claude/**` and
   `.agents/**` skill text — and put the command, its hit count and a positive
   control in the body. **The positive control is a hit somewhere
   other than the site the issue names**: one drawn from that site proves only that
   the command found what you already knew. Name the earlier change whose edge this
   was if you can find it, as context for the next reader — the sweep is the proof.
   36 of the 600 issues classified in
   [the 2026-09 retrospective](../../../docs/contributing/issue-retrospective-2026-09.md)
   carry *still* in their title, each an edge found by hand after the fact.
8. **No operator state in prose (#2422).** Nothing in code, comments or docs states
   that an environment *has* a variable set or *hands out* a tag. Operator steps are
   an unticked checklist in the PR body, in this order: mechanism merged → observed
   (run log, `npm view`) → flag flipped. Sweep code comments as well as docs — the
   last survivor on #2422 was a comment.

## Acceptance Gate

**Start with `npm run preflight`** (#3150). It derives the gate list by reading
the PR-triggered workflow files, selects what your diff can redden, runs it, and
names the CI job each failure belongs to. `npm run quality` is not that list —
it covers no ratchet at all — and four review rounds in ten days ended with a
builder reporting "all repo gates green" over a first CI run that went red on a
gate only CI ran. The enumeration below is a second copy, which is why it is
kept short and why the battery, not this list, is the answer to "did I run
everything".

Then run what the battery cannot: a live database (`docker compose up -d
postgres`, or the backend suite skips its real-DB files), browser verification
for UI changes, and anything the issue names specifically.

Run checks proportionate to every changed surface:

- package tests and type checks for package changes;
- `npm run preflight` for cross-package behavior, or `npm run quality` when you
  only need typecheck/test/build;
- browser verification or the required headless equivalent for UI changes.

Run the **repository's own required checks** locally before pushing, for fast feedback:

- `npm run docs:check` and `npm run docs:test` when the diff touches any Markdown file, anything under `docs/` or `scripts/docs/`, or a root gravity file (`CLAUDE.md`, `README.md`, `AGENTS.md`, `ABOUT_HAVEN.md`);
- `npm run docs:coupling` when the diff touches **any source file** — this one is keyed on code, not Markdown, so the Markdown-keyed line above never fires for the pure-code PR that needs it (the #1076 failure). It is the strict, CI-equivalent form; the bare `node scripts/docs/coupling-gate.mjs` always exits 0 and will not tell you what CI says. Run it from the worktree holding the candidate change — it reads uncommitted work, so it is valid before the commit;
- `npm run design:lint -w packages/frontend` and `npm run design:coupling:strict -w packages/frontend` when the diff touches frontend surfaces or adds an exported component under `components/ui/**` or `components/haven/**`. This step runs BEFORE the commit, which is why the local run reads the working tree and prints the range it compared; `--strict` is what makes a finding exit 1, and the form without it never does (#2826). Add the showcase entry to `app/(authenticated)/design-system/page.tsx`, or mark a genuinely internal export `// design-system-exempt: <reason>`.

- **The `node --test` suites are the part a vitest sweep never touches, which is
  why the battery above comes first.** Several read source by content —
  `scripts/lint-request-schemas.test.mjs` pins the real `enforcedModules` list,
  `scripts/ci/money-path.test.mjs` requires every path in this skill's Merge Gate
  to be on the perimeter — and PR #3221 went red on each in turn (runs
  `35743765136` at `162f916a`, `35748951778` at `9bd70181`) after a local sweep
  that ran vitest and a hand-picked lint list. `node scripts/ci/preflight.mjs
  --list` selects `npm run lint:request-schemas:test` at the first commit and
  `node --test scripts/ci/*.test.mjs` at the second: the battery would have
  caught both. Two traps when running any of them by hand: without `npm ci`
  six cases fail for missing packages (`dependency-cruiser`, `tsx`), which is the
  environment and not the change; and `zsh` does not word-split an unquoted
  `$files`, so a file list goes through `xargs -0`, never a variable.

These are **CI required checks** (#1023), not gates this skill owns — every PR gets them however it was opened. Running them here only saves a round trip. Do not restate their rules in this file: the workflow comments and `docs/contributing/docs-quality-system.md` are the definition, and a second copy drifts.

Fix failures before pushing. Never open or update a pull request with a known red local gate.

Two rules for what the gate's evidence is allowed to say:

- **Prove the instrument can say yes before using its no (#2444).** Every "none
  found" in a PR body is preceded by the same instrument finding a known hit, quoted:
  a grep sweep first matches a term you know is there; the money-path classifier's
  self-test line is pasted with its verdict (*Merge Gate*); a regression test asserts
  on what the executed code emitted, not on a substring of its source (PR #2456 round
  3, #2444 — the source grep would have passed with the string in a comment).
- **Numbers state their basis or name the test (#2421 ×2, #2423 ×3, #2444).** Any
  count in a PR body, commit message or CASP shard is re-derived from its instrument
  at the commit being shipped, with the command and `git rev-parse HEAD` quoted next
  to it. If the number can change without this PR (file totals, test counts), lead
  with the stable figures and cite the volatile one against a named commit — or
  replace it with a pointer to the test that asserts it. Five wrong figures reached
  CASP shards in one week (#2421's "1 in 4300" and its case counts; #2423's file
  total, metacharacter count and mutation total), and #2444's body carried three
  different suite counts.

Run the matching **Captain Self-Check Preflight** in [the agent workflow](../../../docs/contributing/ai-agent-workflow.md).

## Independent Review

**Before any pass runs, make each reviewer's tree and prove it (#2455).** Use
`git worktree add` or `git clone` — **never `cp -R`**, whose failure is silent and was
misread three times in two days. Then check it rather than assert it:

```bash
HEAD_SHA=$(git -C <review-root> rev-parse HEAD)
node scripts/ci/review-isolation.mjs <review-root> --builder <builder-tree> --expect-head "$HEAD_SHA"
```

The guard refuses a root whose **git view does not match its file view** — the
`cp -R`-of-a-worktree case, where the files are a frozen snapshot while every
`git diff`/`show`/`log`/`status` answers from the live repository, so a builder's
addition reads as a deletion. It also refuses the builder's own tree, a stale baseline,
and a HEAD that is not the one under review, and it prints the **frozen base SHA** the
reviewer must diff against instead of a ref name. Hand the reviewer the root, the head
and that base; require all three back in the verdict — the reviewer's half of this
(run the guard first, quote its contract, report `blocked` on refusal) is
[`reviewer.md`](../haven-agent-workflow/references/reviewer.md) § *Before anything
else* and is not restated here (#2455, landed by #2488). **Re-run the identical command
when the pass returns** — an unchanged `--expect-head` is what makes the verdict a claim
about a tree that stood still. A refusal is not a thing to work around: re-make the root.

**Then remove it (#2601).** `git worktree remove <review-root>` — **without `--force`** — by the pass that
made it — nothing else can tell an abandoned review root from a live one, so if the pass
does not do it, nobody does. That is not hypothetical: **173 worktrees were registered on
one machine** before this line existed, none of them prunable, and `git worktree list`
stopped being readable as the "is another session working here" signal the
claim-before-build protocol leans on. `remove`, never `rm -rf` — the registration is the
half that matters, and a deleted directory leaves a dangling entry only `prune` clears.
Plain `remove` REFUSES a root holding modified or untracked files and `--force` deletes it
anyway — so when a pass produced a patch you asked for, the refusal is what keeps it.
Treat a refusal as information: take the patch out of the root, or leave the root. The
root also **stays** on a `blocked` verdict or a guard refusal, because you are about to
inspect or re-make that tree.
The mechanism and the guard's two limits are in
[`ai-agent-workflow.md` § Review Isolation](../../../docs/contributing/ai-agent-workflow.md#review-isolation-2455);
do not restate them here.

1. Review the complete candidate change against `origin/dev`, including staged changes, unstaged tracked changes, and untracked files. If review happens after committing, inspect `git diff origin/dev...HEAD` and separately inspect any later working-tree changes. Never use a committed range that omits the current candidate diff. Use the reviewer role from [haven-agent-workflow](../haven-agent-workflow/SKILL.md); delegate to an independent reviewer when supported, otherwise perform a distinct findings-first review pass. **For `area:frontend` diffs, run a second, rendered pass** with the [design-reviewer role](../haven-agent-workflow/references/design-reviewer.md) (`haven-design-reviewer`) over the #896 screenshots — code review and visual review are complementary, and a `blocking`/`should-fix` finding from either pauses the frontend merge gate (see [`frontend.md`](../../../docs/contributing/ship-playbooks/frontend.md) §5–6 for the severities).

   **Dispatch the two passes together, and start the code pass before capture
   finishes (#2636).** They read different evidence — `haven-reviewer` reads the diff,
   `haven-design-reviewer` reads the PNGs — so the code pass has everything it needs
   the moment the diff is final and does not have to wait on a render. Each pass still
   gets **its own `git worktree add`** per the isolation rule above; that is what makes
   them safe to run at once, since neither is reading a tree the other can move. Send
   both in one message so they actually run concurrently rather than in sequence. Two
   things this does not license: the design pass still needs *finished* captures, so
   dispatch it when the PNGs exist rather than racing it against the harness, and a
   verdict from either still binds to the SHA it saw.
2. Apply clear, scoped blocking and should-fix findings, then rerun affected checks.
   **A fixed finding is not a cleared finding until the same reviewer says so.** Re-run the
   pass that raised it over the *fixed* diff — for `haven-design-reviewer`, over freshly
   captured screenshots of the changed surface, not the ones the finding was raised on.
   The author asserting "addressed" is not a reviewer verdict and never substitutes for one.

   **From round two on, a re-review covers the delta (owner decision, 2026-09-24).**
   It reviews `git diff <last-verdict-sha>...HEAD` and the findings that delta
   claims to clear. It does not re-review the whole diff.

   **The reviewer decides the scope, not the author, and decides it from the
   diff.** Any hunk in the delta that is not tied to an open finding triggers a
   full pass. That includes new files, constants, schemas, config, SQL and
   prose. So does a change to a function's contract that reaches callers the
   delta does not show.

   The scoped pass is still a re-run of the pass that covered the earlier SHA,
   bound to the new one, so *A verdict belongs to the SHA it saw* holds. The
   verdict line records both SHAs. Round one is always a full pass, and this rule
   changes nothing about *which* passes run. It widens #3158's prose-only scoping
   to every delta.

   **A verdict belongs to the SHA it saw (#2423).** The verdict line names the head
   the guard's contract printed — `haven-reviewer: passed @ <sha>`; a line with no SHA
   is unfilled. **Any commit after the verdict SHA re-runs the pass that covered it.**
   There is no comment-only exemption, because no instrument in the repository can
   prove one. PR #2492 (#2423) lists three commits no pass saw; that disclosure is the
   only alternative to the re-run, and it is a disclosure, not a clearance.
   **Applying a finding makes a new claim, and it is measured like one.** The
   replacement sentence or number is re-derived from the instrument — run the
   way CI runs it (`coupling-gate.mjs --strict`, not the bare form) — or, for a
   claim about what an earlier commit or pull request said, from the artifact at
   that SHA (`git show <sha>:<path>`). Never from the reviewer's wording, and
   never from memory. On 2026-09-22 two corrections were themselves false until
   a later round caught them — a CASP shard's "`Infinity` arrives as `0`"
   (PR #3221, carried from a review note; `1e400` in fact passes the new floor)
   and a "12 of 14" measured without `--strict` against CI's 14 of 14 (PR #3224)
   — and the same PR described two past failures from memory, both wrongly.
3. Ask the user before applying ambiguous architectural, product, security, money-movement, authorization, or schema findings.
4. Record applied and deferred findings with reasons. A deferred finding that is
   filed is filed **through [new-task](../new-task/SKILL.md)** — its measurement
   rule, prior-art sweep and mandatory § *Issue review* — never with a bare
   `gh issue create`. Deferred findings from one pull request that share a
   surface go into **one** epic, or into that surface's open epic (new-task §
   *Epics*), not one standalone issue each. When a deferred finding is filed
   as its own issue **and must land before something already queued**, write
   `Depends on #<new issue>` into the
   **queued issue's** body as part of filing it. Stating the constraint only in the
   new issue's prose does not bind anything: the selector's BLOCKED check reads
   outbound references from the candidate it is about to ship, so an inbound "close
   this before #N" is invisible and #N ships anyway.
5. Run `npm run docs:coupling`. Two kinds of finding, and they are not the same obligation:
   - **⚠️ contract doc → blocking.** The strict gate exits 1 and so will CI. Resolve it in *this* pull request: update the stale claims, or genuinely re-verify the doc and bump `last-verified`. Never push with this red.
   - **A parent doc cleared by a shard → advisory, and it is the one to read first (#2323).** The gate's own section is *"Parent docs cleared by a shard — body not re-read"*. The coupling requirement is genuinely satisfied and nothing blocks; what the shard does not do is prove anybody opened the parent, because the author of the change writes the shard. Re-read the named sections against the matched files. Leaving the parent untouched and saying so in the PR is a legitimate outcome — a rubber-stamped `last-verified` is worse than a stale one. Before #2323 the parent was not merely un-blocked here, it was **absent from the comment**, which is how #2274 (PR #2322) shipped a false CASP sentence past a green tick.
   - **Everything else → advisory.** Run the doc-reviewer role over the implicated docs; this is a **hard definition-of-done step**, not optional. Update what the diff actually made stale. Bump `last-verified` only on a doc you really re-read — a rubber-stamped date is worse than a stale one, because the weekly staleness audit ranks on it, so leaving a doc untouched and saying why is a legitimate outcome.

   **Update `last-verified` only after a genuine re-read.** It is a date, not
   a change log: record the scope and evidence in the PR or a per-change record
   rather than adding front-matter prose.

   Do not open the pull request while a `covers:`-mapped doc is left unreviewed. Report what the gate actually printed — "no covered docs implicated" is only evidence when the gate saw the candidate diff, which is why it now refuses to call an empty file set a pass.

### Rework caps (#2163)

Unconditional — every pull request, every surface. These reduce **rework**, never
review: round-one review earns its place on every pass, and nothing here touches
the owner decision (`CLAUDE.md` § *How shipping is governed*) that the reviewer
pass runs on every PR, full stop. They come from #2131 / PR #2154 (branch commits
`db5af4da` → `0083d94d` and after), where most of the eleven branch commits
existed to repair the commit before them, and every substantive finding after
round one traced to a fix rather than to the original work. Deliberately **not** a rigour dial the author selects — a self-chosen
"light mode" is the re-derived conditional that same `CLAUDE.md` section records
as the licence to skip. What legitimately varies (mutation-proving guards, CASP
shard depth, characterization-tests-first, the rendered design pass) keys off the
labels CI applies — `area:*` / `money-path`, the same routing *Prepare* already
uses — never off self-assessment: on PR #2154 the self-assessment was
`n/a (not area:frontend)`, the labeler was right, and the pass it forced found a
real blind spot (`design:lint` green being uninformative for a `src/lib` diff).

1. **Do not write test assertions over freeform prose.** Guard the code that
   *generates* agent-facing text. Where the text is hand-maintained and the
   content matters, a blanket `not.toContain(<literal>)` is acceptable when the
   file has no legitimate use of the literal; anything that requires the
   assertion to *interpret a sentence* is out of scope, and human review is the
   control there. The line is prose-interpretation, not string-matching — this
   rule is never a licence to drop cheap literal guards, which were the *good*
   outcome on #2131 (sound on the first attempt, while four successive
   prose-interpreting guards each failed against realistic edits in the file's
   own house style).
2. **One stopping rule for the fix→review loop, with four triggers.** Decide which
   branch a round is on before writing the next fix:
   - **Fix-traceable (#2131):** the round's findings are all traceable to your own
     previous fix commit rather than to the original work — checkable against
     `git show`, not a vibe. Stop **patching**: revert to the simpler construct, or
     accept and document the residue.
   - **Non-converging:** two successive rounds have each found a **new site of the
     same class** — one more copy of the same retired claim, one more caller missing
     the same check, one more doc restating the same number. Run **exactly one more
     round**. If it finds only more of that class, stop **chasing**: file a follow-up
     issue naming the class and the sweep command that would enumerate it (the
     positive-control form in *Acceptance Gate*), quote its number in the PR body,
     and open. If it finds a defect of a **different class**, the count resets to
     zero — **even if that round also found more of the same class.** This costs
     at most one round over the naive stop-after-two, and that round is the price
     of not cutting a PR off before its worst bug. PR #2467 (#2422) is the case,
     in its own words: "Round 1 found 2 stale docs; round 2 found 3 more; round 3
     found a mis-fenced block of my own making plus the npm README; round 4 found
     two more sites plus the correction below; round 5 found the last one and
     **no new site of the earlier class**, which is what said the set had
     converged." Rounds 1–2 are the two same-class rounds; round 3 is the one
     extra, and it found a different class alongside more of the same — reset;
     round 4 found "the correction below", the PR's most important defect, again
     alongside more of the same — reset again.
   - **Nits-only (#2636):** the round returned findings, and every one of them is a
     `nit` — the reviewer's label, never the author's re-reading of it. Stop
     **looping**: fix in place the ones that are genuinely one-line changes, file the
     rest as follow-up issues with their evidence attached, quote the numbers in the
     PR body, and open. A nits-only round does not earn another round, because the
     next round's findings would be nits about nits. This is the same rule
     [`frontend.md` §6](../../../docs/contributing/ship-playbooks/frontend.md#6-merge-policy-ui)
     states for the rendered pass — one rule, read from either end, and the severity
     table lives there rather than being copied here.
   - **Prose-loop (#3158):** two consecutive rounds have topped out at `should-fix`
     — nits alongside are fine, one `blocking` is not — with every finding **on
     prose** (comments, docs, or the commit message) and **no code change between
     them**. Stop **re-reviewing**: fix the findings and open. Every `should-fix`
     finding is still fixed in this PR; the rounds you are declining to run are
     stated in the body with the reason. The
     mechanism this catches is specific and self-sustaining: a full adversarial
     pass over a comment-only delta reliably finds more comment wording to correct,
     which is itself a prose delta earning another pass. PR #3156 (#3150) is the
     case — ten rounds, of which 8, 9 and 10 each returned **0 blocking** and a
     prose-only delta, yet each carried `should-fix` findings, so **nits-only could
     never fire** and the author was barred from relabelling them. That gap is what
     this trigger closes. Note what it keys on: **the delta**, never the author
     re-reading a reviewer's severity label. Nits-only's bar — "the reviewer's
     label, never the author's re-reading of it" — holds here too and is what keeps
     this from becoming a relabelling exit. A round that touched code, or that
     returned one `blocking`, is not a prose loop however its findings read.
   - **When triggers collide.** Fix-traceable and non-converging on the same round
     (the new site is itself fix-traceable): the fix-traceable branch wins — revert
     first, because a sweep over a construct you are about to revert enumerates
     nothing. **Prose-loop ranks below those two and above nits-only**: a
     fix-traceable or non-converging round takes its own exit even when its
     findings are all prose, because reverting a construct or sweeping a class is
     the cheaper end of the same loop. **Non-converging outranks prose-loop
     including its one mandated extra round** — a pair can satisfy prose-loop while
     sitting at count 2 of non-converging, and the extra round is run, for the
     reason it is defended above: it is the price of not cutting a PR off before
     its worst bug. **Nits-only never overrides any of the other three** — it is the
     weakest and applies only when the round found nothing above `nit`, which also
     makes it mutually exclusive with prose-loop rather than merely outranked.

   **Scope a prose-only re-review to its claims (#3158).** When a round's entire
   delta is prose, the re-review verifies **the changed claims against their
   instruments** — run each one, do not read it — rather than opening a fresh
   adversarial pass over the whole diff. Reviewing prose adversarially generates
   prose findings; executing a claim either confirms it or does not. The durable
   form of this shipped in #3150 as
   `every runnable claim the composite-action prose makes is true`
   (`scripts/ci/preflight.test.mjs`), which executes each sentence's assertion so a
   prose edit that outruns the code reddens instead of needing another round.

   Either exit, including whether the trigger really held, still clears through the
   same reviewer. This ends the fix loop, never the review: it is not a licence to
   merge over an uncleared finding, and the reviewer accepting the documented residue
   or the filed follow-up is the exit, exactly as *Independent Review* step 2 requires.
3. **A check must cover the scope of the claim written from it.** Before writing
   "appears nowhere in backend production code" into a doc, run the check over
   the scope the sentence names — `packages/`, not `packages/backend/src`, since
   `packages/core` is consumed by the backend without living in it. A true
   conclusion resting on a false evidence sentence still has to be corrected in
   every copy.
4. **Process reflection stays out of compliance artifacts.** A CASP shard is a
   regulatory record, not a retrospective; an account of the author's own fix
   churn belongs in the PR body at most.
5. **Reviewer verdicts in the PR body are the named verdict line — with the head
   SHA it reviewed — plus its scope caveats verbatim, not a multi-paragraph
   transcript.** A bound, not a ban: quote what a later reader needs in order to
   know what was cleared and what was not, including every limit the reviewer put on
   their own clearance, in the reviewer's words (*Independent Review* step 2).

### Proportionality lane (#2798)

This is a bounded exception for a Markdown-only diff that passes every boundary
below. It keeps every required check, docs gate, independent `haven-reviewer`
pass, and the money-path classifier.
It drops only the isolated review worktree, mutation-results table, and long-form
PR body: Markdown is not executed, so the reviewer instead reviews the named
`git diff origin/dev...<sha>` and the CI results at that SHA.

Run and paste the output of all five boundary commands into the PR body. Any
non-passing output means the normal workflow applies.

**B1 — Markdown only.**

```bash
git diff --name-only origin/dev...HEAD
```

Every listed path ends in `.md`.

**B2 — no `covers:` reach.**

```bash
npm run docs:coupling
node scripts/docs/coupling-gate.mjs
```

The strict run names no contract doc; the advisory list is empty or names only
docs edited by the diff.

**B3 — no measured number added.**

```bash
git diff origin/dev...HEAD | grep '^+' | grep -vE '^\+\+\+' | grep -E '\b[0-9]{2,}\b' | grep -vE '#[0-9]+|[0-9]{4}-[0-9]{2}-[0-9]{2}'
```

No output.

**B4 — no command added.**

```bash
git diff origin/dev...HEAD | grep '^+' | grep -vE '^\+\+\+' | grep -E '^\+\s*(\`\`\`|npm run|node |npx |gh |git )'
```

No output.

**B5 — not money-path.**

```bash
node scripts/ci/money-path-classify.mjs
```

Reports not money-path.

The short form is the existing PR template with sections deleted, not a second
template file: keep **Review Status** (the verdict line) and
the bare `Closes` / `Refs` line; add the pasted boundary block. The PR template
itself remains unchanged. Inside this lane, a prose finding is a `nit` unless it
changes a reader-actionable rule, required check, or operator step. A re-review after
a fix covers the delta since the last verdict (`git diff <last-verdict-sha>...HEAD`)
and records both SHAs.

The boundary decides mechanically; no author decides whether a change is “small” or
“claim-free.” PR #2797 fails B1 (`package.json`) and B4 (new npm scripts); #2795
fails B2 (`covers:` reach) and B3 (measured figures); #2777 passes B1 but fails B3
(added figures). None qualify. A wording fix, link fix, or retired-claim deletion
with no replacement figure can qualify when all five commands pass.
## Commit And Pull Request

1. Review the final diff and run `git diff --check`.
2. **Re-check the base for a stale branch — scoped to your own files.** Hours can pass
   between *Prepare*'s fetch and this point, and `dev` moves. Fetch it again and
   intersect: the files this change touches against the files `dev` gained since you
   branched. Empty intersection is the normal case — proceed silently. Non-empty
   means merge `dev` in, re-run the affected gates, **and re-read those files** before
   opening: a competing change can be textually clean and still make your work wrong
   or redundant, which nothing downstream will catch. It doubles as a late collision
   check, at the moment it is most informative.

   Ask "did `dev` touch *my* files", never "did `dev` move" — on a busy day the
   second question is always yes, and an alarm that is always on gets ignored.

   Diff the merged result with the three-dot form *Independent Review* step 1
   already requires — a two-dot diff against a base that moved reports everyone
   else's additions as your deletions (a phantom-revert blocking finding on 3 Sep,
   in the #2421 build session). If a concurrent documentation change touches a
   date-only `last-verified` field, retain the current date unless you re-read
   that document; the evidence belongs in the PR or its per-change record.
3. Commit conventionally using any attribution required by the active client or repository policy.
4. Push the issue branch.
5. Open a pull request with base `dev`, never `main`, using the available GitHub integration or authenticated `gh`.
6. Fill the applicable sections of [the pull-request template](../../../.github/pull_request_template.md), including:
   - changed surfaces and workflow used;
   - local checks and browser/headless verification;
   - intentionally excluded work;
   - generated-artifact and handoff impact;
   - CASP/MiCA status when applicable;
   - review findings and resolution, including the **named verdict line for every pass,
     each naming the head it reviewed** (`haven-reviewer: passed @ <sha> | skipped
     because ___`, and on `area:frontend` the same for `haven-design-reviewer`) — an
     unfilled line, or one with no SHA, blocks the merge gate below;
   - **every "could not verify" the reviewer wrote, verbatim, beneath its verdict
     line (#2423)** — suites it could not run ("could not run vitest, tsc,
     check:api-types or check:openapi (no node_modules)"), scopes it approximated
     ("a hand-rolled fnmatch translation, not the real coupling gate") — never
     summarised into "passed"; and anything only the author measured labelled
     **author-only**. This is the builder's duty over the body;
     [`reviewer.md`](../haven-agent-workflow/references/reviewer.md) owns the
     reviewer's duty to write them;
   - operator steps as an **unticked checklist**, never as prose stating that the
     environment already has them (*Implement* step 8);
   - merge readiness: CI, local checks, review status, risk, why safe, residual risk, and merge order.
7. Include the closing keyword — **bare**, never inside backticks or a code span,
   in the body, the pull-request title and the commit messages alike. GitHub does
   not parse a keyword a code span has swallowed, so a backticked one reads as
   correct and closes nothing (#2382). **Except in operator-verify mode**, where
   the issue must outlive the merge: there, reference it without the keyword
   (`Refs #<issue>`) and say in the body why. `Closes` is a GitHub keyword, not
   prose: on merge it closes the issue whatever the body says elsewhere, so three
   separate written
   promises that the issue stays open lose to one keyword — which is what happened
   to [#2268](https://github.com/d-hinders/Haven-AI/issues/2268) on the merge of
   PR #2272 ([#2276](https://github.com/d-hinders/Haven-AI/issues/2276)). This is
   **enforced, not merely written**: `scripts/ci/operator-verify-close-guard.mjs`
   runs inside the required *Docs front-matter & agent skills* check and fails a
   pull request whose closing keyword targets an issue labelled `operator-verify`,
   or one the pull request itself says stays open.

   **The body is not the only place the keyword counts (#2320).** GitHub honours it
   in every **commit message** that reaches the default branch — `dev` is the
   default here, a merge commit lands the messages verbatim and a squash lands them
   concatenated — and, via the squash subject, in the **pull-request title**. The
   guard reads all three. It had to learn this the hard way: PR #2314, which
   introduced the guard, had a blameless body — it closed only its own issue,
   #2276 — and closed #2268 anyway, from a commit message that merely
   *described* the original incident. The check was green on the surface it
   read, and silent about the one that mattered.

   **To write ABOUT the keyword without emitting it, use a form GitHub does not
   parse.** A code fence or a blockquote is not one — a fenced keyword in a commit
   message is exactly how #2268 was closed a second time, and the guard treats
   fenced text in the body the same way — a deliberate over-fire now, not a hedge
   against an unverified case: GitHub's body parse DOES respect Markdown
   rendering, measured under #2382, which is why a backticked keyword in a body
   closes nothing and the pull-request template's placeholders are bare.
   The forms that work: `Refs #<n>`,
   a non-numeric placeholder (`Closes #<n>`, as this line does), the issue number
   with no keyword in front of it, or the keyword and the number in separate
   sentences. There is deliberately **no opt-out marker**: the guard's constraint is
   identical to GitHub's, so there is nothing an opt-out could truthfully assert.
8. Monitor pull-request activity when the client supports it.

## Merge Gate

Classify a change as money-path when **either** the issue carries the `money-path`
label **or** the diff touches a file on the perimeter.

**The perimeter's single source of truth is
[`.github/money-path-globs.json`](../../../.github/money-path-globs.json)** (#1030) —
the same file that drives the `money-path` labeler and the `qa-freshness` promotion
gate. The annotated list below exists for the *why* behind each group, and
`scripts/ci/money-path.test.mjs` now pins it to that JSON **in both directions**: a
path here that the JSON lacks fails CI, and a path in the JSON that is missing here
fails CI too. Read the JSON when you need the authoritative answer; read this when
you need the reasoning. Never edit one without the other — CI will not let you.

- `routes/payments.ts`, `routes/x402.ts`, and
  `routes/machine-payments.ts` — all three are live route files. (#996/#997 moved
  their *logic* into the modules below and left thin validation/auth shells, which
  this line described for a year as the files having "dissolved". They had not;
  both are registered in `index.ts` today. A parenthetical that reads as an
  exclusion is worse than an omission, because nobody re-checks it — #1892.);
- `modules/x402/`, `modules/mpp/`, `domain/payment-token.ts`,
  `domain/machine-payment-lifecycle.ts`, or
  `infra/chain/relayer-reads.ts` (#1987 deleted the off-chain coverage-arithmetic
  module and the allowance-nonce coordinator with the AllowanceModule rail, so
  both are gone from this list — a glob naming a file that no longer exists
  guards nothing, and the "no phantom globs" assertion in
  `scripts/ci/money-path.test.mjs` fails CI on it. The reads-only survivor
  STAYS on this list: it was rails/allowance-module.ts until #2850 renamed
  that file to `infra/chain/relayer-reads.ts` — the AllowanceModule filename
  was the last false claim the retired rail left behind);
- `rails/execution-rail.ts` (the rail seam);
- `rails/delegation-*.ts`, `rails/hybrid-provisioning.ts`,
  `rails/hybrid-account-config.ts`, `rails/hybrid-signer-actions.ts`,
  `rails/hybrid-transfers.ts`, `routes/agent-delegations.ts`,
  `routes/agent-connection-setups.ts`, or
  `routes/agent-rekey.ts` and `modules/agents/rekey-*.ts`
  (the delegation rail — including re-key, which revokes and re-issues an agent's
  on-chain spend authority. It was missing here, in the JSON and in the labeler
  from #1698 until #1892, while `infra/repositories/` already covered its storage
  layer: a PR touching the re-key repository was labelled and one touching only the
  route was not, so the list read as though it knew about re-key. `routes/agent-connection-setups.ts`
  is the third member of that family, added by #2264 on the identical rationale:
  its budget-approval route verifies the signed delegation against the setup and
  flips setup and agent to `active`, so it is where an owner's approval becomes an
  agent's on-chain spend authority — and since #1984 made connect the only
  onboarding path, the retirement moved that job INTO this list's blind spot);
- `rails/sweep.ts`, `infra/relayer*.ts`, `infra/delegate-*.ts`, `infra/outbound-*.ts`,
  `infra/chain/`, `infra/repositories/`, or `modules/accounts/mainnet-gate.ts` (funds
  recovery, gas payment, the durable outbound-tx queue and its bump worker, the relayer
  spend guard/monitor, the delegate exposure monitor, the contract-call and persistence
  layers, and the mainnet authority floor — the relayer/mainnet trio added by #1045
  after review found them missing while they literally move or gate money; the outbound
  globs added after epic #1554 shipped files that broadcast and replace real
  transactions without appearing here; `infra/delegate-*.ts` added by #1892's own
  review, which found the delegate balance monitor unlisted while its equally
  read-only sibling `infra/relayer-balance-monitor.ts` was matched by prefix accident —
  the two even share an alert channel);
- `packages/backend/src/openapi/request-validation.ts` (#3029, epic #3028 — the
  request-validation plugin. Runtime, not control: it sits IN FRONT OF every
  payment route, so a green money-flow QA run exercises it on every leg from
  the day it lands. It refuses on the modules the backend's own
  `enforcedModules` install option names and shadow-logs everywhere else —
  read that list in the source, never a count here; it is a shape VALIDATOR —
  it reads the request against the spec, refuses or logs, and never
  authorizes or constructs spend intent. It does REWRITE values where the
  spec declares a type and ajv coerces: #3082 found a shadow-mode body
  reaching handlers with `null` turned into `''`, which refused every open
  budget. Shadow bodies are restored since then and the divergence is
  counted; querystring/params coercion, and enforce-mode bodies, still
  rewrite by design);
- `routes/hybrid-accounts.ts` (user-signed execution and account provisioning;
  the approval queue's route file was deleted with its table by #2055, so its
  glob left the perimeter rather than being repointed — the code is dead, not
  moved; the owner-signed relayed execution route left the same way in #2847,
  deleted with the last of the Safe rail's live behaviour);
- `packages/sdk/src/signer.ts` and `packages/signer/` (signing schemes are spend
  authority — the SDK entry point was listed; the edge-signer package that
  actually holds the delegate key material was on no list at all, and is the
  stronger case of the two — #1896);
- `packages/sdk/src/delegate-account.ts`, `direct-payment-guard.ts`,
  `redemption-guard.ts`, `settlement-child.ts` and `userop-binding.ts` (the
  delegate key's signing-surface guard, moved out of `packages/signer/` into the
  SDK by #3283, and the #3271 binding check both packages import — their
  location is not what makes them spend authority);
- `packages/core/src/machine-payment-lifecycle.ts` (the machine-payment domain
  actually lives here since #987 — the `domain/machine-payment-lifecycle.ts` line
  above guards the backend re-export shim, not the code — #1905);
- `middleware/agentAuth.ts`;
- `packages/mcp-server/src/**` (the hosted MCP tool surface — #2300. `tools.ts`
  decides *whether* a funding userop is relayed and *in what order*, and four
  money defects lived in it with no money-path label by the file half: #2282's
  funding-before-merchant-context relay, #2312's silently stripped `tx_hash`,
  #2348's stripped `idempotencyKey` that made a retry a second spend, and
  #2051's merchant-steerable cap bypass. Runtime `globs`, not control: the
  hosted MCP deploys from `dev` and the money-flow harness drives it through
  `QA_HOSTED_MCP_URL`, so a green run really does cover it — the argument the
  frontend decision surfaces could not make. Scoped to `src/**` on a measured
  3-of-113-commits delta for the package's README/Dockerfile/config files —
  the command and window are in the JSON note);
- `packages/demo-merchant-mcp/src/**` (the demo merchant's settlement surface —
  #3098. `x402.ts` verifies the buyer's authorization and submits it on-chain,
  and the prod instance runs on Base mainnet; the CASP guardrails doc had
  covered the package since #650 while the classifier never had, and two
  settlement-semantics changes shipped through that gap — #2969/PR #2977
  unlabelled, #2979/PR #2982 labelled only because it also touched
  `mcp-server/src/**`. Runtime `globs`, not control: it deploys from `dev` on
  Railway and the money-flow harness pays it through `QA_DEMO_MERCHANT_URL`.
  Scoped to `src/**` like the hosted MCP entry);
- `db/migrations/`;
- the safeguard's own control surface — `scripts/release-bump.mjs`,
  `scripts/release-version-order.mjs` (the forward-only version rule #2580 lifted
  out of it — a rule that decides which version may reach npm belongs on the same
  footing as the script that applies it),
  `scripts/ci/qa-freshness.mjs`, `scripts/ci/money-path.test.mjs`,
  `scripts/ci/money-path-restatement-scan.mjs`, `.github/CODEOWNERS`,
  `.github/money-path-globs.json`, `.github/workflows/publish.yml`,
  `.github/workflows/dev-gate.yml`, `.github/workflows/qa-dev.yml`,
  `packages/frontend/src/lib/signer.ts`, `packages/frontend/src/hooks/useAgentRekey.ts`,
  `scripts/docs/coupling-gate.mjs`, `scripts/docs/validate-frontmatter.mjs` and
  `.github/workflows/docs-coupling.yml`. These are
  `controlGlobs` in the JSON: labelled money-path so a PR weakening the gate gets
  this playbook and a human, but excluded from the freshness re-run, because
  re-running the money-flow harness proves nothing about a CI config change —
  and the two frontend paths are the same call: the harness exercises the
  deployed backend, not the client, so a QA re-run would prove nothing about a
  change to which signer signs a spend-authority action, but a human should read
  it — #1903.

The label matters because money-sensitive changes do not always touch listed files
(a new signing scheme, a new rail); the file list matters because a diff can be
money-sensitive without the issue being labeled. Union, never intersection.

**Do not answer the file half by eye — run the classifier (#2444).** The command is
`node scripts/ci/money-path-classify.mjs` with the merge base as its argument; paste
its output into the PR body, both the verdict and the `=== SELF-TEST PASSED
(6 positive, 6 negative) ===` line above it. It refuses to classify at all when one
of its controls fails, and that refusal is what makes its "no" worth quoting rather
than merely asserted. **Run it after the last commit, on a clean tree**: it reads
committed history only. With no committed change between the merge base and HEAD
it now exits 2 and says so — on `c7d0431d` it printed "0 of 0 on the perimeter =>
not money-path" and exited 0 in that state, whatever the working tree held — and
with uncommitted changes beside a committed diff it warns that they were not
classified. The label half is read off the issue.

**The file half fails silently, so it needs the guard the label half does not.** When
a route is missing from the list, a labeled issue still classifies correctly and
nothing looks wrong — the right answer comes out for the wrong reason, and only
someone asking *why* it was right finds the hole (which is how #1892 was found, off
the back of #1870 shipping correctly). That is why the drift check above is
bidirectional and why adding a path is cheap while leaving one out is the failure
mode. It is **not** derived from the code, and that was measured rather than assumed
(#1892, against `packages/backend/src` on 2026-08-23, 266 non-test `.ts` files). A
narrow money-verb scan matches **29 of 266** — good discrimination — but misses **30
of the 48** files this list covered before #1892, counting the pre-#1892 Merge Gate
entries expanded to real non-test files under `packages/backend/src` only, so
excluding `db/migrations/**`, `packages/sdk/` and the control globs. State that
denominator whenever you requote the figure; a different one gives a different
number. A vocabulary wide enough to catch those misses matches **149 — 56% of the
backend**, at which point the classification stops discriminating. So the list stays
hand-written, in one place, with the copies pinned to it.

**Two things the pinning now also checks (#1897/#1899).** Every glob must match
real tracked code, so the list cannot claim a module layout the repository does
not have — a `modules/machine-payments/` entry, added pre-emptively by #1158 for
a split that landed as `modules/mpp/`, sat matching nothing until #1897 removed
it. Removing a glob normally *shrinks* the perimeter and needs its own answer to
"is it dead, or did it just move?"; that one had never matched anything in the
repository's history, and every machine-payment file today is covered by another
entry. If a glob's code genuinely moved, **repoint it — never just delete it**;
if it is genuinely still coming, `PRE_EMPTIVE_GLOBS` in the drift test is where
to say so. And `docs/regulatory/casp-risk-guardrails.md`'s `covers:` front matter
— a fourth copy of this perimeter, which declares itself maintained against this
list — is now pinned to it too, with its two remaining gaps exempted explicitly
rather than silently; and since #3098 in the other direction as well: a
package-wide `covers:` entry there must be on this list or named `DOC_ONLY` in
the test with its reason (four are: `sdk`, `cli`, `connect`, `mcp`).

A comment-only diff in a listed file may be treated as non-money-path when the
review confirms zero behavioral change — say so explicitly in the PR.

Classification drives the **playbook and the testing bar**, not a merge pause. A money-path diff still loads `money.md`, still needs characterization tests before existing behavior changes, and still states its classification in the pull-request body.

**Before arming anything, the reviewer verdict has to be written down.** Do not enable
auto-merge while a pull request leaves either verdict line unfilled:

- `haven-reviewer:` — on every pull request, naming the head it reviewed;
- `haven-design-reviewer:` — on every pull request too, where `n/a (not area:frontend)`
  is the fill for a diff that does not need the rendered pass.

A filled `skipped because <reason>` is enough to proceed, a blank is not, and a
`passed` with no SHA is a blank (#2423). The point is
that a skipped pass leaves a trace a human can argue with, not that skipping is
forbidden; `AGENTS.md` § *Run `haven-reviewer` on every pull request* is why the default
is "ran".

**Name the design pass explicitly, because the pause rule below cannot stand in for it.**
That rule triggers on a *finding*, and a pass that never ran produces none — so a
frontend pull request whose `haven-reviewer:` line is filled and whose
`haven-design-reviewer:` line is simply absent sails through a finding-triggered gate
having had no rendered review at all. That is the same "nothing records whether it ran"
gap this check exists to close, one pass over.

Route the merge:

- **Direct migration implementation (`db/migrations/*.ts`):** leave the pull request
  for independent code-owner approval and merge (`.github/CODEOWNERS`). The
  author's own approval does not satisfy it; migration tests under `__tests__/`
  do not need code-owner approval.
- **Frontend UI:** a **`blocking`** or **`should-fix`** UX, copy, or design-system
  finding from either review pass pauses auto-merge; a **`nit`** does not (#2636 — fix
  it in place when it is a one-line change, else file it with its screenshot). Severity
  is the reviewer's label, never the author's re-reading of it, and the table is in
  [`frontend.md` §6](../../../docs/contributing/ship-playbooks/frontend.md#6-merge-policy-ui).
  Clearing a pausing finding does **not** need a second human ack (#1968): fix the finding,
  re-run the pass that raised it over fresh rendered evidence, and a clean re-review
  re-arms auto-merge on its own. Ask the user in the three cases a re-review does not
  cover — the re-review raises a **new** finding, the finding is being **deferred or
  disputed** rather than fixed, or there is no re-review at all.
- **Everything else, money-path included:** after local gates pass and independent
  review has no blocking or should-fix findings, enable squash auto-merge right after
  opening and **read the method back** — the arming line alone is not the evidence:

  ```bash
  gh pr merge <pr> --auto --squash --delete-branch
  gh pr view <pr> --json autoMergeRequest --jq .autoMergeRequest.mergeMethod   # must print SQUASH
  ```

  Do not sit in a poll loop waiting.

Merge method, stated once because the two rules cross-contaminate: **feature → dev
is squash; dev → main promotion is a merge commit, never squash** (the promotion
rule and the pointer to its already-squashed recovery (#1173) live in
[`branch-and-release-flow.md`](../../../docs/contributing/branch-and-release-flow.md)).
Do not let the promotion rule leak backwards into feature PRs.

**The squash rule is checked, not remembered (#2165) — a stopgap until the
repository setting changes.** Before any merge-related action on a feature PR, and
again before reporting it armed, run

```bash
gh pr view <pr> --json autoMergeRequest --jq .autoMergeRequest.mergeMethod
```

`SQUASH` or empty proceeds; **`MERGE` (or `REBASE`) refuses** — `gh pr merge <pr>
--disable-auto`, re-arm with `--squash`, run the command again. A report that says
"armed" without that output has not checked. The checkable basis is four named
landings — #2428, #2460, #2493 and #2438 — every one of which reached `dev` as a
two-parent merge commit (`git rev-list --parents -n1 <merge-sha>` prints three hashes
for each). Three of them (#2428, #2460, #2493) carry a comment saying "disarmed
auto-merge" and landed wrong anyway: a disarm not followed by a squash re-arm and a
read-back changes nothing. Those four carry the rule. If you census the history as well,
**pin the instant** — a bare `--since=<date>` is a git approxidate resolved against
the wall clock *now*, so the same SHA counts differently every hour of the evening
(this rule's own draft read 258 and then 256 for one SHA in one session; PR #2506's
body records the same defect independently: "a bare `--since=2026-08-10` is a git
approxidate that takes the *current time of day*"):

```bash
git log <sha> --first-parent --since=2026-08-10T00:00:00Z --oneline | grep -c '^[0-9a-f]* Merge pull request'
git log <sha> --first-parent --since=2026-08-10T00:00:00Z --oneline | grep -cE '\(#[0-9]+\)$'
```

At `ff052462`, pinned: 275 merge-commit landings, 346 squash, 624 first-parent, stable
across re-runs. Run `git rev-parse --is-shallow-repository` first as well — a shallow
clone *can* truncate the window silently, even though it was not the cause here
(#2500 review rounds 2–3).

**Check `mergeStateStatus` before arming auto-merge.** On `DIRTY`, merge `dev` in and
resolve first — arming auto-merge on a conflicted PR does nothing, silently. The
diagnosis rule and why it is silent live in
[`pr-workflow-checklist.md`](../../../docs/contributing/pr-workflow-checklist.md)
§ *Before Merging* (#1366); read it there rather than re-deriving it from a stalled
check list.

**`BEHIND` is not a blocker on a PR into `dev`, and `main` is still strict
(#2632).** What changed, why, and what it costs are in the ruleset inventory in
[`autonomous-pr-loop.md`](../../../docs/contributing/autonomous-pr-loop.md#one-time-github-setup-required)
step 3 — read it there. The only thing this skill needs from it: do not reach for
`gh pr update-branch` or a `dev` merge-in on `BEHIND`.

> **Why money-path does not pause here (#1024).** The in-session approval applied only to pull requests opened through this skill — a hand-written money-path pull request merged on green CI alone. That made the canonical workflow more expensive than bypassing it while protecting nothing on the bypass path, and the approver was usually the author. What protects the money path is automatic and tool-independent: `CODEOWNERS` for irreversible schema changes, and the `qa-freshness` gate, which since [#1030](https://github.com/d-hinders/Haven-AI/issues/1030) refuses a `dev → main` promotion unless a green money-flow QA run actually **covered** the money-path code being promoted — recency alone does not satisfy it, and a money-path `hotfix/*` blocks outright. Its real limits are the deliberate ones: a logged `qa-override`, and the fact that it only bites while listed in `main`'s required checks. See [`autonomous-pr-loop.md`](../../../docs/contributing/autonomous-pr-loop.md) → "Money-path safety model" and "Be precise about what gate 2 proves", which is where the limits are enumerated — this line names them only to say they are not the ones people assume.

Never bypass required checks. Diagnose CI failures, fix them, push, and re-arm auto-merge only when appropriate.

**Merged ≠ all green.** Auto-merge waits only for the checks the rulesets *require*; a workflow-blocking job outside that list (see the ruleset inventory in [autonomous-pr-loop.md](../../../docs/contributing/autonomous-pr-loop.md)) can still be running — or red — when the merge lands. Before reporting the PR shipped, confirm the blocking jobs' conclusions on the commit that **actually merged**, not just the PR's merged state. A red post-merge job is your failure to hand off: fix or revert before taking new work.

**Re-read the head SHA at verification time. Never reuse one you captured earlier ([#2116](https://github.com/d-hinders/Haven-AI/issues/2116)).** The shortest correct form is the tool, which takes a PR *number* and no SHA — there is no argument through which a stale one can enter:

```bash
node scripts/ci/verify-merged-head.mjs <pr>     # add --expect=<sha> to test a SHA you already have
```

By hand it is two calls, and the order is the whole point:

```bash
SHA=$(gh pr view <pr> --json headRefOid -q .headRefOid)   # read AFTER the merge, not before
gh api repos/<o>/<r>/commits/"$SHA"/check-runs
```

A PR's head SHA is not stable between opening and merging. Routes move it, and **only the first involves auto-merge**: GitHub's own *update branch* when auto-merge is armed and the base moves; merging `dev` in to clear `DIRTY`; any hand-run `gh pr update-branch` (no longer instructed for `BEHIND` on `dev`, but still available and still moves the head); and any push after you last looked. This skill instructs the `DIRTY` merge-in itself, so **a session that never arms auto-merge is fully exposed** — that is the common route here, not the exotic one. Re-reading covers all four at once, because it asks what merged rather than what you were watching. It survives `--delete-branch`: `headRefOid` stays on the PR record after the branch is gone.

**Do not substitute the merge commit for it.** Tempting, since a merge commit cannot go stale — but feature → `dev` is a **squash**, so the merge commit has exactly one parent and there is no second parent to recover the head from, and its own check runs are the push-to-`dev` run: a different, smaller set (16 on #2114 against the PR head's 23, with every PR-only gate — both coupling gates, contract-doc, copy lint — absent). Read it to ask "is `dev` green now"; it does not answer "did this PR's blocking jobs pass on what landed".

**A `cancelled` conclusion is the concurrency guard working — neither a failure nor a pass.** `.github/workflows/ci.yml` sets `concurrency: <workflow>-<pr>` with `cancel-in-progress: true`, so a newer run for the same PR cancels the older one. Cancelled runs on the SHA you are reading almost always mean you are reading a **superseded** SHA; `gh run list --commit <sha>` shows whether a newer run exists. Never fold `cancelled` into "nothing failed" — that is the false-GREEN direction of this defect, and it is the one that hands off a broken `dev` while the session believes it verified.

> **Worked example — PR #2114, 2026-08-27.** Head at open `bcc23cb5`; an unrelated PR merged to `dev`; the branch was updated to `af36577f`, whose CI run cancelled the old one. The PR merged on `af36577f`'s green checks. `check-runs` on the captured `bcc23cb5`: **1 failure + 5 cancelled**. On the re-read `af36577f`: **23/23 success**. Here the stale read produced a false RED — five minutes of investigation. Reverse which run went red and the identical mechanism produces a false GREEN, silently.

### Waiting on CI — mechanics

Do not burn fixed-timeout `sleep` loops against `gh pr checks`.

- **Auto-merged PRs:** `--auto` (above) means GitHub merges when green — but **no
  GitHub event re-invokes a local session**, so "armed" is not "watched". When the
  next step depends on the merge (releasing claims, ticking the epic, taking the
  next queue item), arm a Monitor or a background watch and act on its result;
  otherwise check the PR's state at the next natural opportunity instead of
  assuming it landed. Two silent-stall states to know: `DIRTY` after arming means
  no checks run and no merge ever comes (read `mergeStateStatus`, don't wait), and
  a required check failing means auto-merge simply never fires.
- **Editing the pull-request body re-runs the checks that read it** —
  *Docs front-matter & agent skills* (a required context on `dev`, so it blocks
  the merge while it runs) and *PR ownership gate* (not required on `dev` yet,
  per the ruleset inventory in `autonomous-pr-loop.md`). A merge attempted right
  after the last body edit — filling the verdict lines, say — is refused until
  the re-run finishes. Fill the body before the final CI wait, or wait the
  re-run out. On PR #3221 the body was edited at 16:47:31Z and the re-runs ran
  16:47:34–55Z before the merge at 16:48:13Z; on PR #3224, 18:50:35Z,
  18:50:38–57Z, 18:51:21Z.
- **Known infra flakes:** a required check failing with a known infrastructure
  signature gets **one rerun before any diagnosis** (`gh run rerun <id> --failed`).
  The signature list lives in
  [`autonomous-pr-loop.md`](../../../docs/contributing/autonomous-pr-loop.md) §
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
  [`autonomous-pr-loop.md` § One-time GitHub setup](../../../docs/contributing/autonomous-pr-loop.md#one-time-github-setup-required)
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
  guidance is above). `BEHIND` is the one state whose verdict depends on the base
  branch, because only `main` still requires an up-to-date head (#2632). Anything else — a non-empty
  `missing` or `pending`, an empty rollup, `state: UNKNOWN` (GitHub has not computed
  mergeability for that head yet; measured to persist across re-reads on a freshly
  pushed PR) — keeps waiting under a wall-clock ceiling you state, and a loop that
  outlives the ceiling reports that, not green. The rollup mixes `CheckRun`
  (`status`/`conclusion`/`name`) and `StatusContext` (`state`/`context`) shapes, which
  is why every field above is read with a fallback.
- **BEHIND does NOT self-resolve under `--auto` in this repo** — observed twice
  before #2632, when the armed PR sat BEHIND indefinitely until a manual
  `gh pr update-branch <pr>`. On `dev` that no longer matters: with the up-to-date
  rule off, an armed PR in `BEHIND` merges on its own checks and needs nothing from
  you. The old behaviour still applies to a **promotion PR into `main`**, which is
  still strict — update that branch yourself and let the re-run checks carry the
  merge (the post-promotion sync-back in
  [`branch-and-release-flow.md`](../../../docs/contributing/branch-and-release-flow.md)
  § *Promotion to production* exists for exactly this reason).

## Closeout

Leave the issue open until the pull request merges. Report the issue, pull request, gate result, risk, and merge mode, then stop. A caller may invoke the skill again for the next item.

Report an open `qa-failure` when selection found one — one line naming the issue and
that `dev → main` is gated by it. The user decides what to do about it; the loop's job
is to stop it being invisible.

**Record what a reviewer reproduced per mutation cell, never as a total (#2423).**
Three drafts of one PR body said twelve, fourteen and sixteen for the same mutation
set, and the final table says four of fourteen reproduced (#2423, commit `12ea16c1`) —
different denominators, different definitions of *reproduced*, and until the table
existed nothing either could be checked against.
The closeout (and the PR body it summarises) carries one row per cell:

| # | Cell (guard + mutation) | Author result @ sha | Reproduced by (pass @ sha) | Status |
|---|---|---|---|---|
| 1 | `verify-connect-bundle` — stale `dist` → exit 0 | red → green @ `2097f9e0` | `haven-reviewer` @ `2097f9e0` | reproduced |
| 2 | dev-snapshot rebuild at `0.0.0-dev.*` — four `@alpha` assertions go red | 2/4/1/1 @ `12ea16c1` | — | **author-only** |

The table is the source; any total in the prose is derived from it and says so.

**Parent epic.** When the shipped issue is an epic sub-issue and the epic body carries
a build-order list, tick that slice's line, so the epic reads as status instead of
needing its sub-issue states queried one by one. When it was the epic's **last open
sub-issue**, say so — and report the epic **ready to close only when every box in
its Promotion checklist is ticked** (#2767). Do not close it: an epic can carry
acceptance criteria and operator-verify steps of its own that outlive its slices,
and the checklist is where they live — the operator steps the epic depends on and
the product verification run on `dev` before promotion, each box naming where it is
done (`.github/ISSUE_TEMPLATE/loop-epic.md`). Read it with the tool, never by eye:

```bash
gh issue view <epic> --json body -q .body | node scripts/ci/epic-promotion-checklist.mjs
```

Exit 0 is "ready to close"; exit 1 prints the unticked boxes, and the report lists
them instead. An epic with no such section predates the template change — the tool
says so and exits 0, and the report names the absence. The epic stays open across
the promotion until a human ticks the last box.

**An unticked box is not always outstanding work — it may be a mis-written box.**
A box phrased so that no outcome can make it true (a waived operator step still
worded as "proof recorded") reports not-ready on every run, forever, while the
evidence accumulates in comments this tool does not read. That is #2906, which
reported not-ready for five days with every step done or deliberately waived.
When the checker names a box no work can ever satisfy, say so in the report and
point at [`new-task` § *Epics*](../new-task/SKILL.md#epics) — the box is rewritten
to record the disposition and ticked, naming who waived the step and linking
where. Ship-next never makes that decision itself; it reports that the box, not
the work, is what is blocking.

**Scan-ledger disposition.** When the epic being reported ready to close (or being
closed by whoever holds that decision — ship-next itself never closes an epic, per
the rule above) traces to a [quality-scan](../quality-scan/SKILL.md) finding, the
epic-close step includes appending the dated disposition line (`shipped`, with the
closing evidence) to `docs/quality/scan-ledger.md`. Name this explicitly in the
ready-to-close report so the closer does it in the same pass — the ledger's
exclusion rule only works if dispositions land when the state changes, not when
someone happens to remember (#1554's line landed on memory alone, in a separate
docs PR).

For a merged standalone task originating from a quality-scan improvement
candidate, likewise append its dated `shipped` disposition and merge evidence
to the candidate's ledger record. Preserve the run and prior decisions; the
ledger records disposition, while GitHub remains the implementation tracker.

**Acceptance-criteria evidence.** When the issue body has acceptance-criteria
checkboxes, the closing comment ticks each one with a link to its evidence (test
name, PR, tx link, doc section). A criterion without evidence stays unticked and
the issue stays open — never tick on assertion alone.

**Operator-verify mode.** When the definition of done includes steps only a human
operator can run (funded testnet keys, vendor dashboards, live end-to-end runs):

1. Ship the code PR as usual — the merge is not blocked by the live step. **Reference
   the issue without a closing keyword** (`Refs #<issue>`; see *Commit And Pull
   Request* step 7), or the merge closes the very issue this mode exists to keep open.
   Writing "the issue stays open" in the body does not survive `Closes` — the keyword
   is the mechanism and the sentence is not. **Check the commit messages and the
   pull-request title as well** (#2320): they reach `dev` too, and a clean body does
   not excuse them.
2. Apply the **`operator-verify` label to the issue**, and post a numbered,
   copy-pasteable operator checklist on it (exact commands, env var names — never
   secret values — and the expected output of each step). The label is what makes
   step 1 enforceable rather than remembered: the close guard reads it off the issue,
   so it holds however the pull-request body is later rewritten.
3. Leave the issue OPEN in this state and say so in the report; do not close on
   "code merged".
4. When the operator confirms (or pastes the output), verify it matches the expected
   evidence, tick the checklist, remove the `operator-verify` label, and close with
   the evidence links.
