/**
 * Supported Runtime Manifest table — write and verify (#1790)
 *
 * `docs/operations/mcp-runtime-compatibility.md` carries a table whose stated
 * job is to mirror the version literals in the source. It was re-pinned BY HAND
 * on every release, next to a script that already knew the number, already wrote
 * it into the source, and already verified the built bundle against it.
 *
 * Two exported concerns, deliberately separate:
 *
 *   rewriteManifestTable()   — produce the doc text with the rows re-pinned.
 *   manifestTableViolations()— compare a doc's rows against the SOURCE FILES.
 *
 * The separation is the whole safety argument. A script that writes a value and
 * then verifies its own write is a guard that cannot fail. `manifestTableViolations`
 * never sees the version the bump computed: it reads each row's own source of
 * truth and compares. That makes it meaningful in two situations the writer is
 * absent from — a hand-edited doc, and a doc that drifted because someone
 * changed a constant without re-pinning the table — which is why it also runs in
 * CI on every pull request, not only during a release.
 *
 * Each row is checked against ITS OWN source, not against one shared "new
 * version" string. They happen to be equal after a release, but checking them
 * as one value would silently accept a doc that agrees with itself and with
 * nothing else.
 */

/** The four rows this module owns, and where each one's truth lives. */
export const MANIFEST_ROWS = [
  {
    row: '@haven_ai/connect',
    file: 'packages/connect/src/runtime.ts',
    // export const CONNECTOR_VERSION = '...'
    pattern: /^export const CONNECTOR_VERSION\s*=\s*(['"])(.+?)\1/m,
    describe: 'CONNECTOR_VERSION',
  },
  {
    row: '@haven_ai/mcp',
    file: 'packages/mcp/src/server.ts',
    pattern: /^export const MCP_VERSION\s*=\s*(['"])(.+?)\1/m,
    describe: 'MCP_VERSION',
  },
  {
    row: '@haven_ai/sdk',
    file: 'packages/connect/src/runtime-manifest.ts',
    pattern: /\bsdkVersion:\s*(['"])(.+?)\1/,
    describe: 'sdkVersion',
  },
  {
    row: '@haven_ai/signer',
    file: 'packages/connect/src/runtime-manifest.ts',
    pattern: /\bsignerVersion:\s*(['"])(.+?)\1/,
    describe: 'signerVersion',
  },
]

/**
 * Extract one row's version literal from its source file's text.
 * Returns null when the constant is not found — a renamed or moved constant
 * must READ as a failure, never as "nothing to compare".
 */
export function sourceVersion(rowSpec, sourceText) {
  const match = sourceText.match(rowSpec.pattern)
  return match ? match[2] : null
}

/** Locate the `| `@haven_ai/x` | `version` |` row for a component. */
function rowPattern(component) {
  const escaped = component.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
    // The table writes the package name in backticks.
  return new RegExp(`^(\\|\\s*\`${escaped}\`\\s*\\|\\s*)\`([^\`]*)\`(\\s*\\|)\\s*$`, 'm')
}

/**
 * Read the versions the DOC currently claims, as { row: version }.
 * A row this module owns but cannot find in the doc maps to null.
 */
export function documentedVersions(docText) {
  const found = {}
  for (const spec of MANIFEST_ROWS) {
    const match = docText.match(rowPattern(spec.row))
    found[spec.row] = match ? match[2] : null
  }
  return found
}

/**
 * Re-pin every owned row to `newVersion`.
 *
 * Throws rather than silently no-oping when a row is missing: a table that
 * stopped matching is exactly the case where a quiet skip would let a release
 * ship a stale doc, which is the defect this module exists to remove.
 */
export function rewriteManifestTable(docText, newVersion) {
  let out = docText
  const missing = []
  for (const spec of MANIFEST_ROWS) {
    const pattern = rowPattern(spec.row)
    if (!pattern.test(out)) {
      missing.push(spec.row)
      continue
    }
    out = out.replace(pattern, `$1\`${newVersion}\`$3`)
  }
  if (missing.length > 0) {
    throw new Error(
      `Supported Runtime Manifest table has no row for: ${missing.join(', ')}. ` +
      'The table shape changed — re-pin it by hand this once and fix ' +
      'scripts/release-manifest-doc.mjs, rather than letting the release ship a stale table.',
    )
  }
  return out
}

/**
 * Compare the doc's rows against the source files.
 *
 * `sources` is { '<repo-relative path>': '<file text>' } — the caller reads
 * from disk, so this stays pure and testable, and so the release path can point
 * it at the files it just wrote WITHOUT passing in the version it wrote.
 *
 * Returns an array of human-readable violations; empty means the table agrees
 * with every source of truth.
 */
export function manifestTableViolations(docText, sources) {
  const violations = []
  const documented = documentedVersions(docText)

  for (const spec of MANIFEST_ROWS) {
    const sourceText = sources[spec.file]
    if (sourceText === undefined) {
      violations.push(`${spec.file} was not provided — cannot verify the ${spec.row} row`)
      continue
    }
    const truth = sourceVersion(spec, sourceText)
    if (truth === null) {
      violations.push(
        `${spec.describe} not found in ${spec.file} — the ${spec.row} row cannot be verified ` +
        '(a renamed constant must fail, not pass quietly)',
      )
      continue
    }
    const claimed = documented[spec.row]
    if (claimed === null) {
      violations.push(
        `the Supported Runtime Manifest table has no \`${spec.row}\` row, but ${spec.describe} ` +
        `in ${spec.file} is '${truth}'`,
      )
      continue
    }
    if (claimed !== truth) {
      violations.push(
        `${spec.row}: table says '${claimed}' but ${spec.describe} in ${spec.file} is '${truth}'`,
      )
    }
  }

  return violations
}
