/**
 * The npm dist-tag a release version publishes under — and the ONE place that
 * rule is written down on the JavaScript side (#2423, slice 3 of epic #2420).
 *
 * `.github/workflows/publish.yml` derives the `--tag` for `npm publish` from
 * the version with a shell `case`. `packages/sdk/src/connector-channel.ts`
 * bakes the same answer into the published packages so their "re-run the
 * connector" hints name the channel the user actually installed from. Two
 * consumers of one rule is exactly how the two drift, so:
 *
 *   - this module is the JS half, used by `scripts/release-bump.mjs` to write
 *     `HAVEN_CONNECTOR_CHANNEL` at bump time;
 *   - `scripts/release-bump.test.mjs` **executes** the workflow's own `case`
 *     block, in `bash`, over a version table and asserts it returns exactly
 *     what {@link channelForVersion} returns. Not a text comparison — the
 *     workflow's shell is run, so a rewritten-but-equivalent `case` passes and
 *     a rewritten-and-different one fails.
 *
 * The rule itself, in full:
 *
 *   | version                          | channel  |
 *   |----------------------------------|----------|
 *   | `0.1.34-alpha.0`                 | `alpha`  |
 *   | `0.0.0-dev.202609021200.abc1234` | `dev`    |
 *   | `0.2.0`                          | `latest` |
 *
 * Read as one sentence: a prerelease publishes under its own prerelease label,
 * a stable version publishes under `latest`. The `dev` snapshot channel of
 * #2421 needs no special case — `0.0.0-dev.<ts>.<sha>` already has `dev` as
 * its prerelease label, which is why that version shape was chosen.
 */

import { readFile } from 'node:fs/promises'

/**
 * The channel (npm dist-tag) `version` publishes under.
 *
 * Mirrors the shell in `publish.yml`:
 *   `tag="${version#*-}"; tag="${tag%%.*}"` for a prerelease, else `latest`.
 */
export function channelForVersion(version) {
  if (typeof version !== 'string' || version === '') {
    throw new Error(`channelForVersion: expected a version string, got ${JSON.stringify(version)}`)
  }
  const dash = version.indexOf('-')
  if (dash === -1) return 'latest'
  const afterDash = version.slice(dash + 1)
  const dot = afterDash.indexOf('.')
  return dot === -1 ? afterDash : afterDash.slice(0, dot)
}

/** Where the build-time constant lives, and the literal that carries it. */
export const CONNECTOR_CHANNEL_FILE = 'packages/sdk/src/connector-channel.ts'
export const CONNECTOR_CHANNEL_CONSTANT = 'HAVEN_CONNECTOR_CHANNEL'
const CHANNEL_PATTERN = /^(export const HAVEN_CONNECTOR_CHANNEL\s*=\s*)(['"]).*?\2/m

/**
 * Rewrite the constant in `source` to `channel`. Returns the new source, or
 * `null` when the declaration is not found — the caller decides how loudly to
 * fail, and the bump script fails hard, because a release that silently skips
 * this ships hints pointing at the wrong channel.
 */
export function rewriteConnectorChannel(source, channel) {
  const updated = source.replace(CHANNEL_PATTERN, `$1$2${channel}$2`)
  return updated === source && !CHANNEL_PATTERN.test(source) ? null : updated
}

/** Read the constant's current value out of `source`. */
export function readConnectorChannel(source) {
  const match = source.match(/^export const HAVEN_CONNECTOR_CHANNEL\s*=\s*(['"])(.+?)\1/m)
  return match ? match[2] : null
}

/**
 * Extract the dist-tag `case` block from `publish.yml` and wrap it in a
 * runnable shell function.
 *
 * Deliberately extraction-then-execution rather than a regex over the file: the
 * question is "does the workflow compute the same channel", and only running it
 * answers that. A text check answers "does this string appear", in the
 * reassuring direction.
 */
export async function publishWorkflowChannelScript(workflowPath) {
  const yaml = await readFile(workflowPath, 'utf8')
  // The block, verbatim from the workflow, from `case "$version" in` through
  // its matching `esac`. Indentation is preserved; shell does not care.
  const match = yaml.match(/^(\s*)case "\$version" in\n[\s\S]*?\n\1esac$/m)
  if (!match) {
    throw new Error(
      `Could not find the dist-tag \`case "$version" in\` block in ${workflowPath}. ` +
        'If publish.yml stopped deriving the tag from the version this way, this guard ' +
        'must be repointed rather than deleted — the rule it pins is still live in ' +
        `${CONNECTOR_CHANNEL_FILE}.`,
    )
  }
  return `set -eu\nversion="$1"\n${match[0]}\nprintf '%s' "$tag"\n`
}
