- **#2346 (CI guard scope fix)** — **no route, authority, custody or execution
  boundary moves; this is a CI script that can only ever fail a build.**
  `scripts/ci/operator-verify-close-guard.mjs` blocks a pull request that would
  close an issue held open for an operator step. #2337 widened it to read every
  emitter — body, title and every commit message. The `0.1.33-alpha.0`
  promotion was then the first `dev → main` pull request it met, and it blocked
  on a closing keyword aimed at #2268, carried by a commit that merged into
  `dev` days earlier.
  **Why that is a false positive, from the guard's own premise.** Its header
  states it scans "every place whose text can reach `dev`", because "when a
  pull request based on the default branch (`dev` here) merges, GitHub closes
  every issue it names". On a promotion that premise cannot hold: `dev` is the
  default branch, every commit on the promotion is ALREADY on `dev` — that is
  what a promotion is — so each keyword fired on the merge that put it there.
  #2268 was indeed closed by `dfe7d8ff`, and again via a quoted keyword in
  `7f7102ff`; both were caught and the issue reopened, at the time, on the pull
  requests that carried them. `main` is not the default branch, so the
  promotion could not repeat it. Since every promotion carries historical
  commits by construction, this was a standing block on ALL releases.
  **A footnote that is really the point.** The first version of THIS pull
  request tripped the very guard it fixes — a true positive. Its body and one
  commit message wrote the keyword literally while explaining the bug, and since
  the pull request targets `dev`, the merge would have closed #2268 a third
  time. The guard's own documentation warns about exactly this ("a code fence
  does NOT help"), and I walked into it anyway while writing the fix for it.
  Both were reworded to the sanctioned form — a closing keyword *aimed at* an
  issue, never the parseable text. Recorded because it is the strongest
  available evidence that the guard earns its place: it caught its own author.
  **A scope fix, not a silencing, and the distinction is load-bearing.** The
  guard still runs on every pull request and still reads every emitter. On a
  promotion — and only there — it drops the COMMIT source, whose keywords have
  already had their one effect. The body and title stay scanned, so a promotion
  body that closes a held-open issue is still a violation; a test pins that.
  Nothing about #2337's assertion-reading logic is touched.
  **The rule is keyed on head === default branch, not base !== default
  branch**, and those differ in exactly the case that matters: a
  `hotfix/* → main` branch is based on `main` and its commits have NOT reached
  `dev`; their keywords fire for the first time on the sync-back, so they are
  still scanned in full. The broader rule would have exempted them silently.
  **Four mutations, four kills — and TWO of the four were found by review after
  I had already reported the first pass as complete.** That is the honest
  headline, so the count is not read as diligence it did not have. Replacing the rule with `base !== defaultBranch` fails the
  hotfix test. Dropping the `Boolean(defaultBranch)` fail-closed conjunct
  initially failed NOTHING: the two unreadable-branch cases asserted
  `'dev' === undefined`, already false with or without the guard. Only an
  unreadable branch on BOTH sides distinguishes them — `undefined === undefined`
  is true, so without the conjunct a pull request whose refs could not be read
  would be silently exempted. The test now carries that third case and the
  mutation kills it. Recorded because a guard's own regression test passing
  vacuously is the failure this guard exists to prevent, one level up.
  Review then constructed a THIRD: dropping the `baseRefName !== defaultBranch`
  conjunct left all 35 tests green, because no case exercised head and base both
  equal to the default branch. It is reachable — `headRefName` is an unqualified
  branch name, so a fork branch coincidentally named `dev` targeting this repo's
  `dev` is exactly that shape, and under the mutant its commits would be dropped
  on a merge INTO the default branch, where keywords DO fire. The guard blinding
  itself on its own reason to exist. Now pinned.
  **The coverage gap I declared has been closed rather than left declared.**
  The first version of this shard said `readPullRequest` shells out to `gh` so
  its wiring could not be tested, and that a mutation blanking body and title on
  a promotion would pass the suite. True, and review pointed out this file
  already contains the answer: `commitsFromGraphQL` was extracted for precisely
  that reason. The assembly is now a pure exported `assemblePullRequest`, the
  two `gh` calls are the only impure part left, and that fourth mutation kills.
  Stating a limit is better than hiding one; closing it is better than stating
  it, and "no cheap way exists" would have been wrong here.
  **One boundary that remains, named rather than discovered later.** These are
  branch NAMES matched as strings — `gh pr view` returns `headRefName`
  unqualified — so a fork branch coincidentally named `dev` targeting `main`
  classifies as a promotion. Impact is bounded: merging into non-default `main`
  closes nothing whatever the commits say, and `dev-gate.yml` already trusts
  `head.ref` by string the same way, so this inherits a repository convention
  rather than introducing a weakness. Recorded because "narrow in three
  directions" must not quietly mean "narrow in the three I thought of".
  37 tests pass (was 29). Haven still custodies nothing, still holds no user
  key, still signs no settlement. Perimeter unchanged; a release gate that
  blocked every promotion on a closure that had already happened no longer
  does.
