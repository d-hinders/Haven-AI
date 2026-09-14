/**
 * Package CHANGELOG release headings — write, re-seed and verify
 *
 * Each published package's `CHANGELOG.md` accumulates entries under an
 * `## Unreleased` heading. A release turns that into `## <version> — <date>`
 * and opens a fresh `## Unreleased` above it for the next cycle.
 *
 * ## What actually went wrong, stated precisely
 *
 * The five CHANGELOGs were created by #2933 on 2026-09-13 carrying the line
 * "Release headers are written by the release bump (`npm run release:bump`),
 * never by hand" — while `release-bump.mjs` did not touch them. A file
 * asserting behaviour the code does not have, and instructing the next reader
 * not to fix it.
 *
 * **No release shipped a stale heading.** The next release after the files
 * appeared (0.2.0-alpha.0, 2026-09-14) hand-stamped the heading and
 * hand-corrected the prose in the same commit, so the false assertion stood for
 * about one day and zero releases. An earlier version of this comment claimed
 * "the recorded instance is the 0.1.37-alpha.0 release commit, where all five
 * read `## Unreleased`" — that is false and review caught it: the files were
 * created ten hours AFTER that release and did not exist at it. The defect was
 * real; the impact story was inferred rather than checked, which is the exact
 * habit the release skill's *Read State Directly* section exists to stop.
 *
 * ## Two exported concerns, deliberately separate
 *
 *   releaseChangelog()          — produce the file text for a release.
 *   changelogHeadingViolations()— compare files on disk against a version,
 *                                 never against what a bump run computed.
 *
 * The split is the safety argument `release-manifest-doc.mjs` states at greater
 * length: a script that writes a value and then verifies its own write has
 * built a guard that cannot fail. `changelogHeadingViolations` never sees the
 * version a bump computed — it reads the files and the released version and
 * compares them, so it reports drift with no release in sight. It is called
 * from `release-bump.mjs` after the write AND from `release-bump.test.mjs`
 * against the real repository files, which is what makes it a guard rather
 * than a formality.
 *
 * No CHANGELOG reaches a tarball — every published package's `files` field is
 * `dist` + `README.md` (+ `examples` on the sdk) — so this is a repository
 * record concern, not a published-artifact one. Worth keeping right anyway:
 * the changelog is what a consumer reads on GitHub to learn what a version
 * changed.
 */

/**
 * The published packages whose CHANGELOG carries a release heading.
 *
 * ONE list. `release-bump.mjs` imports it rather than iterating its own
 * `PUBLISHED_PACKAGES`, because two lists that must agree and are not pinned
 * together is how a sixth published package gets a heading written and no
 * verification — the shape `.github/money-path-globs.json` argues against in
 * its own header.
 */
export const CHANGELOG_PACKAGES = ['sdk', 'signer', 'mcp', 'connect', 'cli']

/** Matches the `## Unreleased` heading, with or without trailing decoration. */
const UNRELEASED_HEADING = /^## Unreleased[^\n]*$/m

/** True when the text still carries an `## Unreleased` heading. */
export function hasUnreleasedHeading(source) {
  return UNRELEASED_HEADING.test(source)
}

/**
 * The file text for a release: `## Unreleased` becomes `## <version> — <date>`,
 * and a fresh `## Unreleased` is opened above it.
 *
 * The re-seed is not a convenience — without it the mechanism works exactly
 * once. The bump would consume the sentinel, the next release would find
 * nothing to rewrite, and the header prose telling contributors to "add entries
 * under `## Unreleased`" would point at a heading that no longer exists while
 * `CLAUDE.md` forbids restoring it by hand. Review caught that; the first
 * version of this module had no re-seed.
 *
 * Returns null when there is no `## Unreleased` heading. That is NOT an error:
 * a package can go a release with no entry, and inventing a heading over an
 * empty section would put a release header on nothing. The caller is expected
 * to say which of the two happened rather than let them look alike.
 *
 * Only the FIRST occurrence is rewritten — a file that somehow carries two
 * would otherwise have its history rewritten along with its top entry. The
 * replacement is a FUNCTION, so a `$&` or `$1` in a version or date is inserted
 * literally rather than interpreted as a replacement pattern.
 */
export function releaseChangelog(source, version, isoDate) {
  if (!UNRELEASED_HEADING.test(source)) return null
  return source.replace(UNRELEASED_HEADING, () => `## Unreleased\n\n## ${version} — ${isoDate}`)
}

/**
 * Packages whose CHANGELOG has no heading for `version` — the drift this
 * module exists to report.
 *
 * Iterates the files it is GIVEN rather than a list of its own, so the caller
 * owns the set and the two cannot disagree. A package absent from the map is
 * not reported: a missing changelog is a different concern from a missing
 * heading.
 *
 * The check is "does a heading for this version exist", not "is `## Unreleased`
 * absent" — `## Unreleased` is *expected* to be present after a release, freshly
 * re-seeded above the new heading.
 */
export function changelogHeadingViolations(files, version) {
  const violations = []
  for (const [name, source] of Object.entries(files)) {
    if (typeof source !== 'string') continue
    if (source.includes(`## ${version} — `)) continue
    violations.push(
      `packages/${name}/CHANGELOG.md has no "## ${version} — <date>" heading`,
    )
  }
  return violations
}
