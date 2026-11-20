/**
 * The paywall proxy image's tag rule (#5007), as a script rather than a shell
 * block inside the workflow, so the refusal is testable.
 *
 * ## The rule
 *
 * The repository's publishing invariant is that dev-branch code reaches only a
 * `dev` channel (`publish.yml:37`, `:264-265`). The image follows it:
 *
 *   push to `dev`  → `dev-<short-sha>` and moves `dev`
 *   push to `main` → `pilot-<short-sha>` and moves `pilot`
 *   never          → `latest`, because a `latest` reads as a general release,
 *                    which decisions (b) and (c) on #5005 say this is not
 *
 * ## Where the guard sits, and what it is not
 *
 * `packages: write` lets any run of the workflow push any tag, so the rule that
 * `dev` never moves `pilot` cannot rest on the token. It rests on two things:
 *
 *   1. STRUCTURE — the `pilot` push lives in its own job gated
 *      `if: github.ref == 'refs/heads/main'`, and every job carries
 *      `if: github.repository == 'd-hinders/Haven-AI'`.
 *   2. THIS REFUSAL — `assertTagAllowed` refuses a channel/tag pair that the
 *      rule does not allow, exactly as `publish.yml`'s `assert_publish_allowed`
 *      refuses a bad channel/tag pair before every `npm publish`.
 *
 * It is a script check, not a credential boundary. A run of the workflow that
 * skipped this script could still push any tag the token permits; what the
 * script buys is that the ordinary path cannot compute a wrong tag, and that a
 * test fails if someone widens the rule.
 *
 * Usage:
 *   node scripts/ci/paywall-proxy-image-tags.mjs --ref refs/heads/dev --sha <sha>
 *
 * Prints one tag per line, the immutable one first.
 */

/** The registry path the workflow pushes to. */
export const IMAGE = 'ghcr.io/d-hinders/haven-paywall-proxy'

/** The branch that moves each channel. `main` is the `dev → main` promotion. */
export const CHANNEL_BRANCHES = Object.freeze({ dev: 'refs/heads/dev', main: 'refs/heads/main' })

/** The moving tag each channel owns. */
export const CHANNEL_TAGS = Object.freeze({ dev: 'dev', main: 'pilot' })

/** A tag that would read as a general release. Refused on every channel. */
export const FORBIDDEN_TAGS = Object.freeze(['latest'])

/** The length of the short SHA in a tag. */
export const SHORT_SHA_LENGTH = 7

/** A tag the rule does not allow. */
export class TagRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'TagRefusal'
  }
}

/**
 * Refuse a channel/tag pair the rule does not allow. Called for every tag
 * `imageTags` computes, so there is no path to a pushed tag that goes around it.
 *
 * Both directions are real, and they are not symmetry for its own sake:
 *   dev  + a `pilot` tag → an unpromoted dev commit lands on the channel pilot
 *                          merchants install from
 *   main + a `dev` tag   → a promoted commit is published as a snapshot, and
 *                          the `dev` channel moves backwards
 */
export function assertTagAllowed(channel, tag) {
  if (channel !== 'dev' && channel !== 'main') {
    throw new TagRefusal(`unknown channel '${channel}': only 'dev' and 'main' publish an image`)
  }
  if (FORBIDDEN_TAGS.includes(tag) || FORBIDDEN_TAGS.some((forbidden) => tag.startsWith(`${forbidden}-`))) {
    throw new TagRefusal(
      `refusing to publish tag '${tag}': a 'latest' tag would read as a general release, and this image is a pilot build`,
    )
  }
  const own = CHANNEL_TAGS[channel]
  if (tag !== own && !tag.startsWith(`${own}-`)) {
    throw new TagRefusal(
      `refusing to publish tag '${tag}' on the '${channel}' channel: the only tags that channel may carry are '${own}' and '${own}-<short-sha>'`,
    )
  }
}

/** The channel a ref publishes on, or a refusal. */
export function channelForRef(ref) {
  for (const [channel, branch] of Object.entries(CHANNEL_BRANCHES)) {
    if (ref === branch) return channel
  }
  throw new TagRefusal(
    `refusing to publish from ref '${ref}': only '${CHANNEL_BRANCHES.dev}' (dev) and '${CHANNEL_BRANCHES.main}' (pilot) publish an image`,
  )
}

/** The short SHA a tag carries: the first seven hex characters of the commit. */
export function shortSha(sha) {
  const trimmed = String(sha).trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) {
    throw new TagRefusal(`refusing to tag with '${sha}': a commit SHA is 7 to 40 hex characters`)
  }
  return trimmed.slice(0, SHORT_SHA_LENGTH)
}

/**
 * The tags a push publishes, the immutable one first. Every tag is checked
 * against the rule before it is returned.
 */
export function imageTags(ref, sha) {
  const channel = channelForRef(ref)
  const short = shortSha(sha)
  const tags = [`${CHANNEL_TAGS[channel]}-${short}`, CHANNEL_TAGS[channel]]
  for (const tag of tags) assertTagAllowed(channel, tag)
  return tags
}

/** `--ref` and `--sha` from argv, or a refusal naming what is missing. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--ref' || arg === '--sha') {
      const value = argv[i + 1]
      if (value === undefined) throw new TagRefusal(`${arg} needs a value`)
      out[arg.slice(2)] = value
      i += 1
    } else {
      throw new TagRefusal(`unknown argument '${arg}': usage is --ref <ref> --sha <sha>`)
    }
  }
  if (out.ref === undefined) throw new TagRefusal('--ref is required')
  if (out.sha === undefined) throw new TagRefusal('--sha is required')
  return out
}

// True only when this file is the process's entry point, so importing it (the
// test beside it) never runs the CLI. Both paths are resolved before they are
// compared: Node resolves symlinks for a module's own URL and not for
// `process.argv[1]`, so an unresolved comparison is false through any symlink,
// and the script would exit 0 without running (#4776).
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  try {
    const { ref, sha } = parseArgs(process.argv.slice(2))
    for (const tag of imageTags(ref, sha)) console.log(tag)
  } catch (err) {
    if (err instanceof TagRefusal) {
      console.error(`GUARD: ${err.message}`)
      process.exit(1)
    }
    throw err
  }
}
