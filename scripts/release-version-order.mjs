import { join } from 'node:path'

// Forward-only version rule for a release bump (#2580).
//
// Its own module, not a function inside release-bump.mjs, for the reason the
// sibling `release-snapshot-version.mjs` exists: `release-bump.mjs` calls
// `main()` at module scope with no CLI guard, so importing it RUNS a release.
// A rule that cannot be imported cannot be unit-tested, and the existing suite
// has to read that file as source text to say anything about it.

/**
 * Refuse a bump that does not move the version FORWARD (#2580).
 *
 * ## The defect this catches, one step before it can do damage
 *
 * `publish.yml`'s prod channel moves the `latest` dist-tag onto whatever it
 * publishes (#2536). It does not compare against the live `latest`, so
 * publishing a genuinely new version of an OLDER release line would drag
 * `latest` down to it — `latest` is 3.0.0, someone cuts a 2.x fix as
 * 2.5.1-alpha.0, and a bare `npm install` starts serving the older build.
 *
 * The check lives HERE rather than in the workflow because this is where a
 * human is already looking. It fails at the release PR, before anything
 * reaches npm, where the remedy is to type a different number — instead of
 * after publication, where the remedy is a manual dist-tag repair.
 *
 * ## Why `current` and not the published `latest`
 *
 * The issue proposed comparing against the live `latest`. This compares
 * against the repo's current version instead, deliberately:
 *
 *   - this script is OFFLINE, and a registry read would make a deterministic
 *     release tool fail on a flaky network or an air-gapped run;
 *   - Haven has one release line and `hotfix/*` branches from `main`, so the
 *     repo version IS the newest version, and the scenario above is caught
 *     without any network call.
 *
 * **What this does NOT catch, and the trigger is more ordinary than it first
 * looks.** Any state where `package.json` sits below the live `latest` defeats
 * the comparison. `haven-reviewer` supplied the realistic path on the #2580
 * pull request, and it needs no exotic branching:
 *
 *   3.0.9 -> 4.0.0 is released and published; `latest` is 4.0.0.
 *   A bug is found and the team REVERTS the merge — one `git revert`, an
 *   ordinary emergency move. `package.json` reads 3.0.9 again.
 *   The next hotfix bumps patch: 3.0.9 -> 3.0.10. Forward, locally. Allowed.
 *   Publishing it drags `latest` from 4.0.0 down to 3.0.10 — precisely the
 *   defect this rule exists to prevent.
 *
 * A first draft of this comment said the gap needed "a long-lived release
 * branch", which undersold it. The operational answer is in
 * `docs/contributing/branch-and-release-flow.md`: do not revert a published
 * release bump — cut a forward version that includes the revert. Detecting it
 * here would need the published `latest`, i.e. the network read rejected
 * above; comparing against git tags instead was considered and left for a
 * separate decision, since tags are absent in a shallow CI clone.
 *
 * ## Snapshots are exempt, and that is the half most likely to be got wrong
 *
 * A dev-channel snapshot is `0.0.0-dev.<ts>.<sha>`, which sorts BELOW every
 * real version by construction — that is the point of it (`0.0.0-` can never
 * be resolved by a `^0.1.x` range). Applying this check to a snapshot would
 * refuse every dev publish. The same conflation of "dangerous" with "the
 * ordinary dev path" was shipped and caught by execution in #2536's own
 * workflow guard; it is not repeated here, and the exemption has its own test.
 *
 * Pure, and exported, so it is testable without running a release.
 *
 * @returns {string|null} a message to die with, or null when the bump is fine.
 */
export function backwardsVersionViolation(current, next, { snapshot }, semver) {
  if (snapshot) return null

  if (semver.lt(next, current)) {
    return (
      `Refusing to bump BACKWARDS: ${current} -> ${next}.\n` +
      `  "${next}" is lower than the current version. Publishing it would move the ` +
      'npm `latest` dist-tag down onto it (#2536), so a bare `npm install` would start ' +
      'serving the older build.\n' +
      '  If you genuinely mean to release an older line, move `latest` by hand afterwards ' +
      'and say so in the release PR — this script will not do it for you (#2580).'
    )
  }

  if (semver.eq(next, current)) {
    return (
      `Refusing a no-op bump: ${current} -> ${next}.\n` +
      '  The version is unchanged, so npm would reject the publish as an existing version ' +
      'and the release would fail after the PR had already merged.'
    )
  }

  return null
}

/**
 * Resolve the workspace semver package (#2580).
 *
 * ## Why this lives here rather than staying a private helper in release-bump.mjs
 *
 * So a test can CALL it. `release-bump.mjs` runs `main()` at module scope, so
 * nothing can import its internals — which meant the only way to assert that
 * production gets the real comparator was to scan the file as text. Two
 * successive text scans were defeated by `haven-reviewer`, each by a stub that
 * satisfied the words while fabricating the comparator: first an inline object
 * literal with the path string parked in an unused variable, then an imported
 * sibling module with the path string parked in a comment. A text scan cannot
 * close that, because the thing it inspects is not the thing that runs.
 *
 * Exported here, the resolution can be executed and its RESULT compared for
 * identity against a separately imported `semver` — which no stub survives,
 * because identity is not a property of the source text.
 *
 * The honest limit: that assertion needs `node_modules`, and the only CI job
 * running this suite deliberately has none, so it is availability-gated. In the
 * dependency-free job the wiring is still only textually checked. And no test
 * binds an author who edits the tests — this guards against accidental drift,
 * which is the actual failure mode, not against a determined author.
 *
 * @param {string} root workspace root, so a test need not guess it.
 */
export async function resolveSemver(root) {
  const semverPath = join(root, 'node_modules', 'semver', 'index.js')
  return (await import(semverPath)).default
}
