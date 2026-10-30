#!/usr/bin/env node
// Draft the CASP shard's "Shipped delta" figures from `release:scope --json`.
//
// WHY THIS EXISTS (#4541, slice 2 of epic #4539). Every release re-types the same
// figures twice — once at the cut, once at the door — and the shard is a
// regulatory record, so a re-typed number is a number that can be wrong. On
// 0.12.0-alpha.0 a late merge forced a re-measure (`f8adbf63a`); the 0.11.0
// shard records 24 files at the cut and 26 at the door. `release-scope.mjs`
// already measures the scope; this script only turns its `--json` payload into
// the three lines a shard carries, so a scope change is a re-run rather than a
// re-type.
//
// WHAT IT OWNS, AND WHAT IT DOES NOT. It owns the NUMBERS: the file count, the
// `+/−` line counts, the per-package split and the excluded breakdown. The prose
// — what the release carries and why — stays hand-written and reviewed. It never
// rewrites a historical shard; past shards stay as written.
//
// THE RANGE IS STATED, NOT ASSUMED. Both past shards measured `origin/dev`
// BEFORE the release PR merged (0.11.0 at `7b2cca38`, 0.12.0 at `feda1617`); the
// door step runs after, with the bump's files in range. The shard's "N at the
// cut, M at the door" therefore needs TWO runs, so the script takes a run label
// (`--label=cut`, `--label=door`) and always prints the range it measured.
//
// EXIT CODES, inherited from `release-scope.mjs` and not re-decided here:
//   0  measured cleanly — the block is complete.
//   1  measured, but at least one source file could not be classified. The block
//      is printed and the run exits 1: the figures are usable but must not be
//      quoted as complete, so the warning travels with them.
//   2  refused, nothing measured. `release-scope`'s own message is relayed
//      verbatim on stderr and nothing is printed on stdout — a refusal must not
//      be mistakable for a measurement.
//
// THE MINUS SIGN IS U+2212. The shards use `−`, not ASCII `-`, and a shard is
// pasted from this output rather than retyped.

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const SCOPE_SCRIPT = join(REPO_ROOT, 'scripts', 'release-scope.mjs')

const MINUS = '\u2212'

// The three reason strings `release-scope.mjs` emits, rendered the way the past
// shards render them. Keyed on the exact string: a reason this map does not know
// is printed VERBATIM rather than dropped, so a fourth reason joining the
// classifier shows up in the block instead of vanishing from it.
const EXCLUDED_LABELS = new Map([
  ['not in a published package', 'outside a published package'],
  ['test file — not reachable from any bundle entry', 'unreachable test files'],
  ['in the package but outside the tarball', 'in a package but outside the tarball'],
])

class Refusal extends Error {}

function parseArgs(argv) {
  const opts = { base: undefined, head: undefined, label: undefined }
  for (const arg of argv) {
    if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length)
    else if (arg.startsWith('--head=')) opts.head = arg.slice('--head='.length)
    else if (arg.startsWith('--label=')) opts.label = arg.slice('--label='.length)
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Refusal(`unknown argument: ${arg}`)
  }
  return opts
}

const USAGE = `Usage: node scripts/ci/release-records.mjs [--label=<run>] [--base=<ref>] [--head=<ref>]

Prints the CASP shard's "Shipped delta" figures from \`release:scope --json\`,
labelled with the range it measured.

  --label=<run>   name this run in the output, e.g. cut or door. The shard's
                  "N at the cut, M at the door" needs two runs.
  --base=<ref>    passed through to release-scope (default: origin/main)
  --head=<ref>    passed through to release-scope (default: origin/dev)

Build first: release-scope reads the shipped set out of dist/ and refuses on an
unbuilt package. Exit 0 measured cleanly, 1 measured but incomplete (unresolved
source files), 2 refused with release-scope's own message.`

// The payload is the contract between the two scripts. If its shape drifts, say
// so and stop: printing a block of zeros would read exactly like "nothing
// shipped", which is the one answer a release author acts on by doing nothing.
function assertPayload(payload) {
  const fail = (what) => {
    throw new Refusal(
      `the release:scope --json payload has no ${what}. This script formats that payload; if its shape ` +
        `changed, update formatShippedDelta rather than printing zeros — an empty block reads identically ` +
        `to "nothing shipped".`,
    )
  }
  if (!payload || typeof payload !== 'object') fail('object at the top level')
  const { range, commits, shipped, excluded, unresolved } = payload
  if (
    !range ||
    typeof range.base !== 'string' ||
    typeof range.baseSha !== 'string' ||
    typeof range.head !== 'string' ||
    typeof range.headSha !== 'string'
  ) {
    fail('range { base, baseSha, head, headSha }')
  }
  if (!Array.isArray(commits)) fail('commits array')
  if (
    !shipped ||
    typeof shipped.count !== 'number' ||
    typeof shipped.added !== 'number' ||
    typeof shipped.removed !== 'number' ||
    !Array.isArray(shipped.files)
  ) {
    fail('shipped { count, added, removed, files }')
  }
  if (!shipped.inferred || typeof shipped.inferred.count !== 'number') fail('shipped.inferred { count, added, removed }')
  if (!Array.isArray(shipped.binary)) fail('shipped.binary array')
  if (!Array.isArray(excluded)) fail('excluded array')
  if (!Array.isArray(unresolved)) fail('unresolved array')
}

// Group by a key, count, and order by count descending then key ascending — the
// order the past shards use, and stable enough to assert on.
function tally(items, key) {
  const counts = new Map()
  for (const item of items) {
    const k = key(item)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export function formatShippedDelta(payload, { label } = {}) {
  assertPayload(payload)
  const { range, commits, shipped, excluded, unresolved } = payload
  const base8 = range.baseSha.slice(0, 8)
  const head8 = range.headSha.slice(0, 8)
  const out = []

  const heading = label ? `Shipped delta — ${label}` : 'Shipped delta'
  out.push(`${heading} (range ${range.base} (${base8}) .. ${range.head} (${head8}))`)
  out.push(
    `${shipped.count} files, +${shipped.added}/${MINUS}${shipped.removed}, over ${commits.length} commits ` +
      `from \`${range.base}\` \`${base8}\``,
  )

  // The headline count INCLUDES deleted sources, whose lines are attributed
  // rather than measured — nothing in the head tree can confirm a deleted module
  // was bundled. Kept visible so a shard author can see how much of the delta
  // rests on that inference.
  if (shipped.inferred.count > 0) {
    out.push(
      `  of which attributed, not measured: ${shipped.inferred.count} deleted source file(s), ` +
        `+${shipped.inferred.added}/${MINUS}${shipped.inferred.removed}`,
    )
  }
  // Binary files are counted as files and never as lines; said out loud rather
  // than left for the reader to notice the arithmetic does not close.
  if (shipped.binary.length > 0) {
    out.push(`  ${shipped.binary.length} binary file(s) counted as files but not as lines`)
  }

  // Per package is DERIVED from shipped.files[].pkg, which is keyed by npm name.
  // The five published names are never written down here: a sixth package, or a
  // rename, must show up without an edit to this script.
  const perPackage = tally(shipped.files, (entry) => entry.pkg)
  if (perPackage.length === 0) {
    out.push('- Per package: (none — nothing in this range reaches a tarball)')
  } else {
    out.push(
      `- Per package: ${perPackage.map(([pkg, count]) => `\`${pkg}\` **${count}**`).join(', ')}, ` +
        `which sums to ${shipped.count}.`,
    )
  }

  // Exclusions are grouped by the classifier's own reason string, never dropped:
  // an exclusion nobody can see is indistinguishable from a file the instrument
  // failed to notice.
  const byReason = tally(excluded, (entry) => entry.reason)
  if (byReason.length === 0) {
    out.push('- Excluded: 0 files')
  } else {
    out.push(
      `- Excluded: ${excluded.length} files (` +
        `${byReason.map(([reason, count]) => `${count} ${EXCLUDED_LABELS.get(reason) ?? reason}`).join(', ')}).`,
    )
  }

  // Exit 1 travels with the block: the figures are measured but not complete, so
  // the warning is printed beside them rather than left in release-scope's own
  // output for the author to scroll back to.
  if (unresolved.length > 0) {
    out.push('')
    out.push(
      `UNRESOLVED: ${unresolved.length} source file(s) could not be classified — the delta above is measured ` +
        `but not complete. Do not quote it as complete.`,
    )
    for (const entry of unresolved) out.push(`  ${entry.file}`)
    out.push('  The three causes are in scripts/README.md § `release-scope.mjs`; only a stale build is a rebuild instruction.')
  }

  return out.join('\n')
}

export function exitCodeFor(payload) {
  assertPayload(payload)
  return payload.unresolved.length > 0 ? 1 : 0
}

// Run release-scope and hand back either its payload or its refusal. Exit 1 is a
// MEASUREMENT (the JSON is on stdout), not a failure of the instrument, so it is
// parsed like exit 0 and only the exit code differs.
function readScopePayload({ base, head }) {
  const args = [SCOPE_SCRIPT, '--json']
  if (base !== undefined) args.push(`--base=${base}`)
  if (head !== undefined) args.push(`--head=${head}`)

  try {
    // stderr is PIPED, not inherited: execFileSync's default sends the child's
    // stderr straight to ours, which would print a refusal twice once the catch
    // below relays it.
    const stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { payload: JSON.parse(stdout) }
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === 'string' && err.stdout.trim() !== '') {
      return { payload: JSON.parse(err.stdout) }
    }
    if (err.status === 2) {
      // Relay release-scope's own message verbatim: it names the cause and the
      // fix, and paraphrasing it here would be a second copy that can drift.
      return { refusal: typeof err.stderr === 'string' ? err.stderr : '' }
    }
    throw err
  }
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`release-records: ${err.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  if (opts.help) {
    console.log(USAGE)
    return
  }

  const result = readScopePayload(opts)
  if (result.refusal !== undefined) {
    process.stderr.write(result.refusal)
    process.exitCode = 2
    return
  }

  let text
  try {
    text = formatShippedDelta(result.payload, { label: opts.label })
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(`release-records: REFUSING TO REPORT — ${err.message}`)
      process.exitCode = 2
      return
    }
    throw err
  }

  console.log(text)
  process.exitCode = exitCodeFor(result.payload)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}

export { Refusal, MINUS }
