/**
 * The dev-channel snapshot version shape (#2421, epic #2420).
 *
 * One home for `0.0.0-dev.<YYYYMMDDHHMM>.<shortsha>`, because two consumers
 * have to agree about it and they run in different places:
 *
 *   - `.github/workflows/publish.yml` PRODUCES the version on a push to `dev`
 *     (`node scripts/release-snapshot-version.mjs`), then feeds it to
 *     `release-bump.mjs` in the throwaway CI tree;
 *   - `release-bump.mjs` VALIDATES it, in both directions: `--snapshot`
 *     refuses anything that is not this shape, and a run WITHOUT `--snapshot`
 *     refuses anything that is. That second half is what keeps a snapshot
 *     version out of a committed release branch, and therefore off the
 *     `main` → `alpha`/`latest` path entirely.
 *
 * Why `0.0.0-`: it sorts below every real version, so no `^0.1.x` range can
 * resolve to a snapshot by accident and nobody has to reason about whether
 * `dev` or `alpha` wins as a prerelease identifier. The Changesets snapshot
 * convention, and an explicit non-negotiable in #2420.
 *
 * This module is deliberately pure and side-effect free apart from the CLI at
 * the bottom, so `release-bump.test.mjs` can import it. `release-bump.mjs`
 * runs `main()` at import time and cannot be imported by a test — the same
 * reason `release-lockfile.mjs` and `release-manifest-doc.mjs` exist.
 */

import { pathToFileURL } from 'node:url'

/** Every snapshot version begins with this, and nothing else may. */
export const SNAPSHOT_PREFIX = '0.0.0-dev.'

/**
 * The full shape. `<YYYYMMDDHHMM>` is exactly 12 digits (UTC); `<shortsha>` is
 * 7–40 lowercase hex characters, the range `git rev-parse --short` can emit as
 * a repository grows.
 */
export const SNAPSHOT_VERSION_RE = /^0\.0\.0-dev\.(\d{12})\.([0-9a-f]{7,40})$/

/** Does this version claim to be a snapshot at all (prefix only)? */
export function looksLikeSnapshotVersion(version) {
  return typeof version === 'string' && version.startsWith(SNAPSHOT_PREFIX)
}

/** Is this version a well-formed snapshot? */
export function isSnapshotVersion(version) {
  return typeof version === 'string' && SNAPSHOT_VERSION_RE.test(version)
}

/**
 * Build `0.0.0-dev.<timestamp>.<sha>`, refusing anything that would not be a
 * valid semver version. Throws rather than returning a bad string: the caller
 * is a publish workflow, and a version it cannot parse must stop the job.
 */
export function formatSnapshotVersion({ timestamp, sha }) {
  if (!/^\d{12}$/.test(String(timestamp ?? ''))) {
    throw new Error(`snapshot timestamp must be exactly 12 digits (YYYYMMDDHHMM), got "${timestamp}"`)
  }
  const short = String(sha ?? '').toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(short)) {
    throw new Error(`snapshot sha must be 7-40 hex characters, got "${sha}"`)
  }
  // Semver forbids a leading zero in a NUMERIC prerelease identifier, so an
  // all-digit short sha beginning with 0 (e.g. `0123456`) would produce a
  // version semver rejects — and `release-bump.mjs` would die on it after the
  // build, which is a confusing place to learn this. Roughly 1 commit in 4300
  // (1/16 × (10/16)^7). Fail here instead, with the fix: re-run the workflow
  // on a later commit. Deliberately NOT worked around by lengthening or
  // rewriting the sha — the version must name the commit it was built from,
  // and #2420 fixes the shape.
  if (/^0\d*$/.test(short) && /^\d+$/.test(short)) {
    throw new Error(
      `short sha "${short}" is all digits with a leading zero, which semver rejects as a ` +
        'numeric prerelease identifier. Nothing is wrong with the commit; re-run this ' +
        'workflow on a later one.',
    )
  }
  const version = `${SNAPSHOT_PREFIX}${timestamp}.${short}`
  if (!isSnapshotVersion(version)) {
    throw new Error(`computed snapshot version "${version}" does not match ${SNAPSHOT_VERSION_RE}`)
  }
  return version
}

/**
 * The bidirectional mode check. Returns an error string, or `null` when the
 * version and the mode agree.
 *
 * Both directions matter and they protect different things:
 *   - snapshot mode + a real version → CI would publish a REAL version under
 *     the `dev` tag from an unreviewed `dev` commit;
 *   - normal mode + a snapshot version → a `0.0.0-dev.*` could be committed on
 *     a release branch, promoted, and published under `alpha`/`latest`.
 */
export function snapshotModeViolation(version, { snapshot }) {
  if (snapshot) {
    if (isSnapshotVersion(version)) return null
    return (
      `--snapshot requires a ${SNAPSHOT_PREFIX}<YYYYMMDDHHMM>.<shortsha> version, got "${version}". ` +
      'Snapshot versions are computed by scripts/release-snapshot-version.mjs, not written by hand.'
    )
  }
  if (looksLikeSnapshotVersion(version)) {
    return (
      `"${version}" is a dev-channel snapshot version. A snapshot is built and published only by ` +
      '.github/workflows/publish.yml on a push to `dev`, in a throwaway tree, with --snapshot. ' +
      'It must never be committed to a release branch: it would ride the dev -> main promotion ' +
      'and reach the alpha/latest channel (#2420). Pick a real version.'
    )
  }
  return null
}

// ── CLI ───────────────────────────────────────────────────────────────────────
//
// `node scripts/release-snapshot-version.mjs [<shortsha>] [<timestamp>]`
// prints the version and nothing else, so publish.yml can capture it directly.
// Both arguments default from the environment (GITHUB_SHA / now) so the
// workflow does not have to restate the format.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = (process.argv[2] || process.env.GITHUB_SHA || '').slice(0, 7)
  const timestamp = process.argv[3] || new Date().toISOString().replace(/\D/g, '').slice(0, 12)
  try {
    process.stdout.write(formatSnapshotVersion({ timestamp, sha }) + '\n')
  } catch (err) {
    process.stderr.write(`\n✗ ${err.message}\n\n`)
    process.exit(1)
  }
}
