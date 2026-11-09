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
 * ## Three exported concerns, deliberately separate
 *
 *   releaseChangelog()          — produce the file text for a release.
 *   changelogHeadingViolations()— compare files on disk against a version,
 *                                 never against what a bump run computed.
 *   changelogPreambleViolations()— compare the text ABOVE the first `## `
 *                                 heading against the canonical template.
 *
 * The third exists because of #4756. Its first commit inserted four entries at
 * the first textual match of `## Unreleased` — which is inside the preamble
 * sentence "The bump rewrites the `## Unreleased` heading below into", not the
 * heading. `docs:check`, the strict coupling gate and the release tests were
 * all green on that commit, and CI never ran on it. A reviewer found it by
 * running `releaseChangelog()` by hand: the release section would have carried
 * no entry for the fix in any of the four packages. Nothing in the suite asked
 * where an entry sits relative to the heading, so nothing could notice.
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

/**
 * The shared half of every published package's CHANGELOG preamble: lines 2
 * through 15 of the file, byte-identical in all five at `49747fac3`. Line 16 is
 * the `## Unreleased` heading the preamble ends at — also identical across the
 * five, and asserted as such in `release-bump.test.mjs`, so "one shared text"
 * is checked rather than assumed.
 *
 * Line 1 is `# @haven_ai/<pkg>` and is built per package by the check below.
 * The preamble is the text BEFORE the first `## ` line, so it ends at the blank
 * line above `## Unreleased`; the heading itself is not part of it. That
 * definition is what makes the check apply to a file with no `## Unreleased`
 * heading at all — legal, since a package can go a release with no entry, and
 * `releaseChangelog()` returns null rather than inventing one.
 *
 * Held here as ONE literal rather than read from a file: a check that reads its
 * expectation from the thing it checks cannot fail. Editing the preamble is a
 * deliberate act, and it must edit this constant in the same commit — which is
 * the point, because the preamble is the text contributors are told to read
 * before adding an entry.
 */
export const CHANGELOG_PREAMBLE_LINES = [
  '',
  'Release headers are written by the release bump (`npm run release:bump`), never by',
  'hand — true since the changelog-heading gap, and stated here only because it was asserted for a long',
  'time while being false. The bump rewrites the `## Unreleased` heading below into',
  '`## <version> — <date>`; add entries under `## Unreleased` and leave the heading',
  'alone.',
  '',
  'Mark a bullet `**Update required**` when a client must update to keep paying.',
  'The bump then flags that release `action_required` in the public release data',
  '(`/releases`, `GET /discovery`, `/.well-known/haven.json`; #3305). It is not',
  '`**BREAKING**`, which means updating may break you, not that you must update.',
  'Write it exactly: "update required" in any other form (including "no update',
  'required") is refused — reword to "no update needed", or quote it in a code span.',
  '',
]

/** A line clipped for a violation message, so one long entry cannot flood it. */
function clip(line, max = 72) {
  if (line === undefined) return '(nothing)'
  return line.length <= max ? line : `${line.slice(0, max)}…`
}

/**
 * Packages whose CHANGELOG preamble is not the canonical template, or that
 * carry a subsection or an entry above the first `## ` heading.
 *
 * The preamble is the text before the first line that starts with `## `. Two
 * rules, and the second is not redundant with the first:
 *
 *   1. No `### ` subsection and no `- ` entry may appear in it. The template
 *      rule implies this, but a contributor who pasted an entry into the wrong
 *      place needs to be told what they did, not that line 5 differs.
 *   2. The preamble must equal `# @haven_ai/<pkg>` followed by
 *      `CHANGELOG_PREAMBLE_LINES`. This is the rule that catches an edit to the
 *      prose itself — the preamble is instructions, and instructions that drift
 *      from the mechanism are how #2933 shipped a file asserting behaviour the
 *      code did not have.
 *
 * The boundary is a prefix test on the same `## ` that `UNRELEASED_HEADING`
 * matches, not a second heading pattern: one heading regex in this module is
 * the point, and a second one would be free to disagree with the first.
 *
 * Iterates the files it is GIVEN, like `changelogHeadingViolations`, so the
 * caller owns the set and the two cannot disagree. A package absent from the
 * map is not reported: a missing changelog is a different concern.
 */
export function changelogPreambleViolations(files) {
  const violations = []
  for (const [name, source] of Object.entries(files)) {
    if (typeof source !== 'string') continue
    const where = `packages/${name}/CHANGELOG.md`
    const lines = source.split('\n')
    const headingIndex = lines.findIndex((line) => line.startsWith('## '))
    const preamble = headingIndex === -1 ? lines : lines.slice(0, headingIndex)

    const subsection = preamble.findIndex((line) => line.startsWith('### '))
    if (subsection !== -1) {
      violations.push(
        `${where}: "${clip(preamble[subsection])}" is a subsection inside the preamble — ` +
          'a subsection belongs under a "## " heading',
      )
    }

    const entry = preamble.findIndex((line) => line.startsWith('- '))
    if (entry !== -1) {
      violations.push(
        `${where}: "${clip(preamble[entry])}" is an entry inside the preamble — ` +
          'entries belong under a "## " heading',
      )
    }

    const expected = [`# @haven_ai/${name}`, ...CHANGELOG_PREAMBLE_LINES]
    const differs = expected.findIndex((line, i) => preamble[i] !== line)
    if (differs !== -1 || preamble.length !== expected.length) {
      const at = differs === -1 ? Math.min(preamble.length, expected.length) : differs
      violations.push(
        `${where}: the preamble differs from the canonical template at line ${at + 1} — ` +
          `found "${clip(preamble[at])}", expected "${clip(expected[at])}"`,
      )
    }
  }
  return violations
}
