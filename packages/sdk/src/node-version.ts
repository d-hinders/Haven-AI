/**
 * The Node.js floor Haven's published packages support (#1161).
 *
 * ## Why this lives in the SDK
 *
 * Three packages need to enforce the same floor — `connect` (at setup),
 * `signer` and `mcp` (at startup) — and `@haven_ai/sdk` is the only dependency
 * all three already share. A copy per package is how the floor drifted in the
 * first place: `engines` said `>=24` everywhere while connect's runtime manifest
 * enforced `20.0.0`, so a connect run on Node v23 passed the guard, installed
 * the signer, and signed a real payment. Two numbers for one fact is one number
 * too many.
 *
 * Each consumer still owns its own refusal — the error type, the exit code, the
 * wording of "what to do next" — because a library must never terminate its
 * host process. This module only answers *is this version supported* and *what
 * should we tell the user*.
 *
 * ## Why a floor is enforced at all
 *
 * `engines` is advisory: npm emits `EBADENGINE` and installs anyway unless the
 * user happens to have `engine-strict` set. For a normal library that is a
 * reasonable default. For the **signer** it is not — it holds the delegate key
 * and produces every payment signature, so a subtle runtime incompatibility
 * shows up as a wrong or missing signature on a money path. "It seemed to work"
 * is precisely the evidence that cannot be relied on there.
 */

/**
 * The minimum supported Node.js version, as `major.minor.patch`.
 *
 * MUST equal the `engines.node` floor declared by every published Haven
 * package. A guard test in each package asserts exactly that against its own
 * `package.json`, so the two cannot drift again silently.
 */
export const HAVEN_MINIMUM_NODE_VERSION = '24.0.0'

/** Parse `v24.1.0` / `24.1` / `24` into a comparable triple. */
function parseNodeVersion(value: string): [number, number, number] {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return [0, 0, 0]
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/**
 * Compare two Node versions. Negative when `left` is older.
 *
 * An unparseable version parses to `0.0.0` and therefore compares as older than
 * any real floor — fail-closed. A version string Haven cannot read is not
 * evidence of a supported runtime, and treating it as one would reopen exactly
 * the hole this module closes.
 */
export function compareNodeVersions(left: string, right: string): number {
  const leftParts = parseNodeVersion(left)
  const rightParts = parseNodeVersion(right)
  for (let i = 0; i < 3; i += 1) {
    if (leftParts[i] !== rightParts[i]) return leftParts[i] > rightParts[i] ? 1 : -1
  }
  return 0
}

export function isSupportedNodeVersion(
  nodeVersion: string = process.versions.node,
  minimumNodeVersion: string = HAVEN_MINIMUM_NODE_VERSION,
): boolean {
  return compareNodeVersions(nodeVersion, minimumNodeVersion) >= 0
}

export interface UnsupportedNodeVersionMessageOptions {
  /**
   * What is being refused, in the user's terms — "Haven setup", "The Haven
   * signer". Leads the message so the reader knows what just stopped.
   */
  subject: string
  nodeVersion?: string
  minimumNodeVersion?: string
  /** Appended verbatim as the closing line. Used for the re-run instruction. */
  retryHint?: string
}

/**
 * The refusal text.
 *
 * Names the detected version, the required version, and **how to fix it** — the
 * previous message stopped after the two version numbers, which tells a user
 * they are stuck without telling them how to get unstuck. The version-manager
 * lines are the fix for nearly everyone; the closing caveat is there because the
 * runtime that *spawns* the signer is frequently not the shell that was
 * upgraded, and a desktop app can keep launching the old Node long after
 * `node -v` in a terminal says otherwise.
 */
export function unsupportedNodeVersionMessage(
  options: UnsupportedNodeVersionMessageOptions,
): string {
  const nodeVersion = options.nodeVersion ?? process.versions.node
  const minimum = options.minimumNodeVersion ?? HAVEN_MINIMUM_NODE_VERSION
  const lines = [
    `${options.subject} requires Node.js >=${minimum}, but this is Node.js ${nodeVersion}.`,
    '',
    'Upgrade Node, then try again:',
    `  nvm install ${major(minimum)} && nvm use ${major(minimum)}      (nvm)`,
    `  fnm install ${major(minimum)} && fnm use ${major(minimum)}      (fnm)`,
    `  volta install node@${major(minimum)}                 (volta)`,
    `  or download Node ${major(minimum)} from https://nodejs.org`,
    '',
    'If you use a version manager, check that the agent runtime launching Haven picks ' +
      'up the same version — upgrading your shell does not always change what a desktop ' +
      'app spawns.',
  ]
  if (options.retryHint) lines.push('', options.retryHint)
  return lines.join('\n')
}

function major(version: string): string {
  return String(parseNodeVersion(version)[0])
}
