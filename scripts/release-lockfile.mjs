/**
 * Deterministic lockfile update for a release bump (#1663).
 *
 * A version bump should move exactly the version lines — 6 workspace
 * `version` fields and 5 `@haven_ai/*` pins on the current tree — and nothing
 * else. `npm install` does not promise that: on three consecutive cuts
 * (0.1.26 → 0.1.28) the local npm also inserted `"dev": true` / `"peer": true`
 * metadata on unrelated entries, and each release hand-repaired the lockfile
 * at exactly the moment the repo is least able to absorb a hand-edit. A
 * release diff's whole safety argument is "nothing here is anything but a
 * version string"; churn in it is where a real change would hide.
 *
 * So the bump does not TAKE npm's lockfile. It replays the version
 * substitution onto the pre-bump lockfile structurally — parse, touch the
 * named fields, serialize — and then a separate check proves the final diff
 * holds only version lines, failing the release loudly otherwise.
 *
 * Structural rather than textual on purpose: a third-party dependency can sit
 * at the same version number the workspace is leaving (nothing stops a dep
 * from being 0.1.28), and a text-wide substitution would silently rewrite it.
 * The parse knows which `"version"` belongs to whom.
 *
 * Lives outside `release-bump.mjs` because that script runs `main()` at
 * import time — anything meant to be imported by a test cannot share a module
 * with it.
 */

/**
 * The lockfile `packages/<name>` entries whose version moves in lockstep with
 * a release. Mirrors VERSIONED_PACKAGES in release-bump.mjs: the five
 * published packages plus mcp-server (versioned for coherence with its
 * HOSTED_SERVER_VERSION constant, not npm-published).
 */
export const LOCKSTEP_LOCKFILE_PATHS = [
  'packages/sdk',
  'packages/signer',
  'packages/mcp',
  'packages/connect',
  'packages/cli',
  'packages/mcp-server',
]

const DEP_TYPES = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/**
 * Apply a release's version substitution to lockfile text, returning the new
 * text. Throws rather than guessing on anything unexpected — a release bump
 * is the one place where "probably fine" is the wrong default.
 */
export function bumpLockfileText(lockText, { currentVersion, newVersion }) {
  const lock = JSON.parse(lockText)

  // The serializer below writes JSON.stringify(…, 2). If the input was not
  // already in exactly that shape, writing it back would reformat the entire
  // file and bury the version lines in whitespace churn — the very failure
  // this module exists to prevent. npm has written this shape for every
  // lockfileVersion ≥ 2; refuse loudly if that ever stops being true.
  if (serialize(lock) !== lockText) {
    throw new Error(
      'package-lock.json does not round-trip through JSON.stringify(…, 2) — ' +
      'npm\'s serialization changed, and a structural rewrite would reformat ' +
      'the whole file. Fix bumpLockfileText before releasing.',
    )
  }

  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json has no "packages" map — lockfileVersion < 2 is not supported.')
  }

  for (const path of LOCKSTEP_LOCKFILE_PATHS) {
    const entry = lock.packages[path]
    if (!entry) {
      throw new Error(`Lockfile has no entry for ${path} — the workspace layout changed under this script.`)
    }
    if (entry.version !== currentVersion) {
      throw new Error(
        `Lockfile entry ${path} is at ${entry.version}, expected ${currentVersion} — ` +
        'the lockfile and package.json disagree about the current version.',
      )
    }
    entry.version = newVersion
  }

  for (const entry of Object.values(lock.packages)) {
    for (const depType of DEP_TYPES) {
      const deps = entry[depType]
      if (!deps) continue
      for (const [name, range] of Object.entries(deps)) {
        if (name.startsWith('@haven_ai/') && range === currentVersion) {
          deps[name] = newVersion
        }
      }
    }
  }

  return serialize(lock)
}

function serialize(lock) {
  return JSON.stringify(lock, null, 2) + '\n'
}

/**
 * A changed lockfile line a release bump is allowed to produce: a version
 * field, or an internal pin. Anything else in the diff is churn — or a real
 * change hiding where churn taught reviewers not to look.
 */
const ALLOWED_CHANGED_LINE = /^\s*("version"|"@haven_ai\/[a-z][\w.-]*"): ".+",?$/

/**
 * Compare lockfile text before and after a bump. Returns the changed lines
 * that a version bump is NOT allowed to produce — empty means the diff is
 * exactly what a release claims to be.
 *
 * When the versions are given, an allowed change is exact: the same key,
 * moving precisely currentVersion → newVersion. This is the last line of
 * defense against a bug in bumpLockfileText ITSELF, so it must be able to
 * tell "the 11 intended lines moved" from "an unrelated version was quietly
 * rewritten to something else" — a shape-only check cannot.
 *
 * A bump replaces lines in place, so any change in line COUNT is itself a
 * violation: an inserted `"dev": true` adds a line, and reporting the
 * insertion beats mis-pairing every line after it.
 */
export function lockfileDiffViolations(beforeText, afterText, versions) {
  const before = beforeText.split('\n')
  const after = afterText.split('\n')

  if (before.length !== after.length) {
    // Name the actual inserted/removed lines rather than just the counts —
    // "27 × "dev": true" is actionable, "49 vs 38 lines" is not. Version
    // lines are skipped here: an insertion shifts the pairing so legitimate
    // substitutions also show up as count deltas, and listing them next to
    // the real violation would bury it.
    const beforeCounts = countLines(before)
    const afterCounts = countLines(after)
    const violations = []
    for (const [line, count] of afterCounts) {
      if (ALLOWED_CHANGED_LINE.test(line)) continue
      const extra = count - (beforeCounts.get(line) ?? 0)
      for (let i = 0; i < extra; i++) violations.push(`+ ${line.trim()}`)
    }
    for (const [line, count] of beforeCounts) {
      if (ALLOWED_CHANGED_LINE.test(line)) continue
      const missing = count - (afterCounts.get(line) ?? 0)
      for (let i = 0; i < missing; i++) violations.push(`- ${line.trim()}`)
    }
    return violations.length > 0
      ? violations
      : [`line count changed ${before.length} → ${after.length} with only version-line churn — ` +
         'an insertion and a deletion of version lines is still not a plain bump']
  }

  const violations = []
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue
    if (isAllowedChange(before[i], after[i], versions)) continue
    violations.push(`line ${i + 1}: ${before[i].trim()} → ${after[i].trim()}`)
  }
  return violations
}

function isAllowedChange(beforeLine, afterLine, versions) {
  if (!ALLOWED_CHANGED_LINE.test(beforeLine) || !ALLOWED_CHANGED_LINE.test(afterLine)) return false
  if (!versions) return true
  const { currentVersion, newVersion } = versions
  // Exact: same key, and the value moves precisely current → new. Anything
  // else — a different key on the same line slot, a wrong old value, a wrong
  // new value — is a corruption wearing a version line's clothes.
  return (
    beforeLine === afterLine.split(newVersion).join(currentVersion) &&
    afterLine === beforeLine.split(currentVersion).join(newVersion) &&
    beforeLine.includes(currentVersion) &&
    afterLine.includes(newVersion)
  )
}

function countLines(lines) {
  const counts = new Map()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}
