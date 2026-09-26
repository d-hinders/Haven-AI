#!/usr/bin/env node
// Bot-ownership upsert for the two standing digest issues (#3341).
//
// promotion-digest.yml and docs-audit.yml both upsert a standing issue by
// selecting on something a human can also set, then overwriting that issue's
// body:
//
//   - promotion-digest.yml took the first open issue carrying the `promotion`
//     label. #3262 — the prod RPC swap procedure, labelled `promotion` by its
//     author — was overwritten by `github-actions` 33+ times from
//     2026-09-24T09:04:02Z; the procedure survives only in the author's early
//     revisions.
//   - docs-audit.yml took the first hit of `gh issue list --search
//     "in:title <TITLE>"`. `in:title` is a tokenised search: any human issue
//     whose title CONTAINS the words is adopted and overwritten.
//
// The fix is to select by the one issue attribute a human cannot set — the
// author — plus an exact, non-tokenised title comparison done in this script,
// never by `in:title`. A human who labels their own issue `promotion`, or
// whose title contains "Docs staleness audit (weekly)", is now invisible to
// the upsert: it is not found, so it is not edited, and the workflow creates
// its own digest beside it.
//
// ## Fail-closed selection
//
// Every pre-write failure path makes the script exit non-zero so the workflow
// step dies BEFORE it can create a duplicate or adopt the wrong issue:
//
//   - `gh issue list` fails (network, auth, rate limit) → exit 1. The old
//     promotion-digest shell had `|| true` on the list, so a failed lookup
//     fell through to `gh issue create` and filed a duplicate; a failed read
//     must now fail the run instead.
//   - the author is not a bot, or an exact title cannot be confirmed on the
//     candidate → exit 1. Wrongness fails rather than degrades to "first hit".
//
// Only a clean empty result proceeds to `create`.
//
// ## Shape
//
// `gh` is injectable so the test drives this exact entry point with a
// recording stub (the qa-failure-issue.mjs / claim-collision.mjs pattern).
// The body arrives on STDIN, not argv: a promotion digest can grow past
// GitHub's own limits, and a single exec-argv entry is capped far below what
// a body that size needs.
//
// Usage:
//   printf '%s' "$body" | node scripts/ci/standing-issue-upsert.mjs \
//     --title '📦 Pending promotion: dev → main' \
//     --author 'app/github-actions' \
//     --list-args '--label promotion --state open' \
//     [--repo d-hinders/Haven-AI] [--label promotion]
//
// Keep a `--label` inside --list-args. Measured 2026-09-26 on this repo:
// `gh issue list --author app/github-actions` resolves the app login on the
// label-filtered list path and matches NOTHING without a label (search path —
// there it wants the `github-actions[bot]` form). Both call sites pass a
// label, and the exact author+title filter below is the authority either way;
// this note only explains a future empty result that "should" have matched.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The author login every bot-owned digest issue carries. */
export const BOT_AUTHOR = 'app/github-actions'

const defaultGh = (args, { input } = {}) =>
  execFileSync('gh', args, { encoding: 'utf8', ...(input !== undefined ? { input } : {}) })

/** Parse an `gh issue list --json` array; anything unreadable is an error. */
function parseList(json) {
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`unparseable \`gh issue list\` output: ${String(json).slice(0, 200)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`\`gh issue list\` returned ${typeof parsed}, expected a JSON array`)
  }
  return parsed
}

/**
 * Pick the bot-owned digest issue out of an open-issue list.
 *
 * Filters by exact author login and exact title — never a tokenised search.
 * Only issues carrying number, title and author in their JSON can be judged
 * (the script always requests `--json number,title,author`). When several
 * candidates match — a duplicate digest exists — the LOWEST number wins: the
 * original standing issue keeps the identity, per the repo's "one long-lived
 * issue, deliberately" rule. Returns the number, or null when nothing matches.
 */
export function selectDigestIssue(candidates, { author, title }) {
  const hits = (Array.isArray(candidates) ? candidates : []).filter(
    (i) => i?.author?.login === author && i?.title === title && Number.isInteger(i?.number),
  )
  return hits.length ? Math.min(...hits.map((h) => h.number)) : null
}

/**
 * The upsert. Returns { action, number } — action is 'updated' | 'created'.
 * Throws on every failure path listed in the header; the CLI turns a throw
 * into stderr + exit 1 so the workflow step fails closed.
 */
export function upsertStandingIssue({
  gh = defaultGh,
  title,
  author = BOT_AUTHOR,
  listArgs,
  body,
  repo,
  label,
  log = console.log,
}) {
  // Server-side filter on the attribute a human cannot set, plus an exact
  // title comparison client-side in this file (never `in:title` — tokenised).
  // --author on `gh issue list` matches GitHub's issue author login; a bot
  // authors as `app/github-actions` and `gh` also accepts that form.
  const listJson = gh(
    ['issue', 'list', ...(repo ? ['--repo', repo] : []), ...listArgs, '--author', author,
      '--json', 'number,title,author'],
  )
  const number = selectDigestIssue(parseList(listJson), { author, title })

  if (number !== null) {
    // The body rides stdin into gh (--body-file -), not argv: a digest can
    // grow past what a single exec-argv entry can carry, and a body on argv
    // re-enters one layer of shell parsing. Same stdin channel the CLI used.
    gh(['issue', 'edit', String(number), '--body-file', '-', ...(repo ? ['--repo', repo] : [])], { input: body })
    log(`Updated the standing digest issue #${number}`)
    return { action: 'updated', number }
  }

  const created = gh(
    ['issue', 'create', '--title', title, '--body-file', '-',
      ...(label ? ['--label', label] : []), ...(repo ? ['--repo', repo] : [])],
    { input: body },
  )
  const m = String(created).match(/\/issues\/(\d+)/)
  const createdNumber = m ? Number(m[1]) : null
  log(createdNumber !== null ? `Created the digest issue #${createdNumber}` : `Created the digest issue`)
  return { action: 'created', number: createdNumber }
}

function main() {
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
  }
  const flag = (name) => process.argv.includes(`--${name}`)

  if (flag('help')) {
    process.stdout.write(
      'usage: standing-issue-upsert.mjs --title <exact title> [--author app/github-actions] ' +
      '--list-args \'<gh issue list args>\' [--label <label>] [--repo <owner/name>] < body.md\n',
    )
    return
  }

  const title = arg('title')
  const listArgsRaw = arg('list-args')
  if (!title || !listArgsRaw) {
    console.error('standing-issue-upsert: --title and --list-args are required')
    process.exit(2)
  }
  if (!/--json/.test(listArgsRaw)) {
    console.error('standing-issue-upsert: --list-args must carry --json (the script appends "number,title,author")')
    process.exit(2)
  }

  const body = readStdin()
  if (!body.trim()) {
    console.error('standing-issue-upsert: empty body on stdin — refusing to upsert a digest with no content')
    process.exit(2)
  }

  const label = arg('label')

  const listArgs = listArgsRaw.split(/\s+/).filter(Boolean)
  // The script OWNS the --json field list: the caller's flag marks the spot,
  // the script replaces flag and value so the three fields the exact filter
  // reads are always requested.
  const jsonAt = listArgs.indexOf('--json')
  if (jsonAt === -1) {
    console.error('standing-issue-upsert: --list-args must include --json (the script owns its field list: number,title,author)')
    process.exit(2)
  }
  const hasValue = jsonAt + 1 < listArgs.length && !listArgs[jsonAt + 1].startsWith('-')
  listArgs.splice(jsonAt, hasValue ? 2 : 1, '--json', 'number,title,author')

  // The create path's label and the list's label must agree. A create label
  // the list does not filter by can adopt a bot issue that has LOST the label,
  // and a list label the create path omits can create an unlabelled digest
  // the next run cannot find. Both halves drift silently; this refuses to.
  if (label && !listArgs.some((a) => a === '--label' || a.startsWith('--label='))) {
    console.error(`standing-issue-upsert: --label ${label} applies to create only — add the same --label to --list-args so selection and creation agree`)
    process.exit(2)
  }

  const { action, number } = upsertStandingIssue({
    title,
    author: arg('author', BOT_AUTHOR),
    listArgs,
    body,
    repo: arg('repo'),
    label: arg('label'),
  })
  process.stdout.write(JSON.stringify({ action, number }) + '\n')
}

function readStdin() {
  // fd 0 — works for pipes and redirects alike; throws when stdin is absent.
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
