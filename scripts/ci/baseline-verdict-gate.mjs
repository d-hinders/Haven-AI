#!/usr/bin/env node
// Baseline change gate (#3232) — a pull request that MODIFIES an existing
// visual baseline must say, for each modified PNG, why it moved, and must
// carry a design-review verdict that names it. Slice 1 of epic #3231; source:
// quality scan 2026-09-22 finding F1.
//
// ## The defect this closes
//
// Nothing read what a changed baseline carries. The regeneration workflow
// WRITES an audit trailer into its commit (`commitTrailer()` in
// scripts/ci/baseline-audit.mjs — "Regenerated with --update-snapshots=<mode>;
// baselines moved: …"), and no script reads it back; a manual baseline commit
// (e.g. #2471) carries no trailer at all. Measured on origin/dev @ fd7b1289:
// `git grep -l -E "baselines moved|Regenerated with" fd7b1289 -- . ':!docs'`
// finds only the writer and the workflow that places it — no reader. Since
// 2026-09-01, 24 of the 35 first-parent landings touching
// packages/frontend/e2e/__screenshots__/ modified an existing baseline, and
// only 13 of those 24 carried a design-review verdict in the PR body at merge
// (quality scan, hand-corrected). A baseline is a claim that a render is the
// expected state; today the claim arrives unsigned and unexplained.
//
// ## The rule
//
// For every PNG under packages/frontend/e2e/__screenshots__/ that the PR
// changed:
//
//   - MODIFIED (status `modified`) — the pre-existing pixels were re-stamped:
//     needs BOTH (a) a declared reason naming the file, and (b) a design-review
//     verdict line naming it, bound to a commit at or after the last commit
//     that touched the PNG (the #3222 shape: baselines re-committed AFTER the
//     review must not pass).
//   - ADDED / RENAMED (a new screen, or a path move that carries the pixels):
//     needs (a) only. There is no prior state for a design review to have
//     blessed; the rendered-evidence rules in the frontend playbook cover the
//     review itself.
//   - REMOVED — out of scope (#3232): deleting a baseline is a coverage
//     decision, not a re-blessing.
//
// ## The two lines (defined here once; documented in
// docs/contributing/ship-playbooks/frontend.md §4)
//
//   baseline-change: <names or *> -- <reason>
//   design-review verdict: <verdict> @ <sha> -- baselines: <names or *>
//
//   <names>   comma- or space-separated base names or repo paths of the
//             baselines the line covers, or `*` for a mass re-bless (a font or
//             Playwright bump moves all of them at once — the #1760-class
//             dispatch, declared rather than silent).
//   <reason>  why the pixels moved, at least 20 characters — a label is not a
//             reason. The same length the copy lint and the ratchets demand of
//             an inline marker, for the same reason: an empty or one-word
//             reason is the declaration checked off, not made.
//   <verdict> `passed` or `approved` (case-insensitive), as the WHOLE verdict
//             word before `@` — `not approved`, `unapproved` or
//             `passed-with-nits` are not passing, and a baseline named
//             `approved-mock.png` does not make its line one (#3301). A line
//             that says `skipped` or `n/a` does not verify a MODIFIED
//             baseline: a skipped design review is the absence of the review.
//   <sha>     the commit the verdict was given at. Verified, not just present:
//             the last commit that touched the PNG must be an ancestor of it
//             (or equal), and it an ancestor of the PR head — a verdict naming
//             a commit older than the baseline's re-commit does not count.
//
// When verdicts conflict (#3301), the newest one decides, per baseline:
//
//   - A line that NAMES a baseline outranks a `*` line for that baseline, in
//     both directions — a named `changes requested` beats a `*` pass, and a
//     named pass beats a `*` block.
//   - "Newest" is commit ancestry, never text order (the body is read first
//     even when it was edited last). A non-passing line vetoes a pass bound
//     at or before its own sha — a tie vetoes — and a pass clears an earlier
//     block only when the block's sha is a strict ancestor of the pass's.
//     Unrelated shas, unknown ancestry and an unbound (`@`-less) block all
//     fail closed: the block stands.
//   - A block bound before the baseline's last touch, or to a commit that is
//     not on the head, describes a different image and is ignored — the same
//     binding a pass has to meet.
//
// `--` and `—` both work as the separator; matching is on the BASE NAME, the
// same convention `parseExpected` in baseline-audit.mjs uses, for the same
// reason: the lines are typed by a human about files whose directory prefix
// carries no information (no duplicate base names exist across the 85 PNGs —
// visible in the report, which prints full paths).
//
// ## What is read, and the provenance limit
//
// Declarations come from the PR body and the PR's commit messages; verdicts
// from the PR body AND the PR's comments (#2816's verdict was posted as a
// comment — a verdict that exists only in the thread still exists). The author
// writes every line the gate reads, so the gate proves the TEXT exists, not
// who wrote it or that the review happened; it is a checklist the PR cannot
// leave blank, not an authentication of the review. The report and the
// playbook both say so — a green tick here is the author's signed declaration,
// reviewable like everything else in the PR.
//
// ## Where it runs, and why `pull_request_target`
//
// A separate workflow, on `pull_request_target: [opened, edited, synchronize,
// reopened, ready_for_review]`, NOT a step in ci.yml's frontend job:
//
//   - ci.yml's `pull_request` trigger has the default types — no `edited` — so
//     a verdict added to the body during review is never re-read, and adding
//     `edited` to ci.yml would re-run every CI job on every body edit. The
//     precedent is a separate workflow on the wide type list that reads the PR
//     through the API (docs.yml, pr-ownership-gate.yml).
//   - PRs into the DEFAULT branch only. A dev→main promotion shows every
//     modified baseline in its window, squash commits keep the trailer but not
//     the PR body, and a promotion PR therefore cannot carry per-file verdicts;
//     the gate passes with that stated as the reason rather than pretending to
//     have judged. Push events are not PRs; nothing to read.
//   - The judge must not be the code under judgement: on `pull_request_target`
//     the checkout is the DEFAULT branch, so the script that judges is dev's
//     copy, never the PR's — a PR cannot edit its way to a green tick (the
//     pr-ownership-gate.yml argument, verbatim). The PR's code is never
//     checked out or executed; the PR-derived inputs are text, read from the
//     API with a read-only token.
//
// `edited` matters more here than for the ownership gate: the declaration
// lines are exactly what an author adds mid-review after a reviewer asks why a
// baseline moved, and the re-run on `edited` is what turns that edit into a
// green tick without a push.
//
// ## Fail closed
//
// A check that cannot read the PR it must judge FAILS, with the read error in
// the log — the operator-verify close guard's and pr-ownership-gate's shared
// precedent. A green check that judged nothing is the worse outcome. Re-run
// the job after a transient error.
//
// ## Advisory until a ruleset change says otherwise
//
// Making this a REQUIRED context is a ruleset change, not a workflow change
// (the pr-ownership-gate's operator note applies unchanged); whether the
// *Design visual regression* surface becomes required on `dev` is the epic
// owner's decision (#3231), and this gate ships advisory so the rollout of
// open PRs that already modify baselines (e.g. #3222) is a red check to read,
// not a blocked merge to unwind. The failure message tells the author exactly
// what to paste.

export const BASELINE_DIR = 'packages/frontend/e2e/__screenshots__'

/** Minimum substantive reason, in non-whitespace characters. */
export const MIN_REASON_CHARS = 20

/** Verdict words that verify a modified baseline. Anything else does not. */
export const PASSING_VERDICTS = new Set(['passed', 'approved'])

/**
 * One line of the declaration format. Exported for the playbook's testability
 * and so the self-test and the report cannot restate the spelling.
 */
export const DECLARATION_RE = /^\s*(?:[-*]\s*)?baseline-change:\s*(.+)$/gim
export const VERDICT_RE = /^\s*(?:[-*]\s*)?design-review\s+verdict:\s*(.+)$/gim

const SHA_RE = /@\s*([0-9a-fA-F]{7,40})\b/
const SEPARATOR_RE = /\s+(?:--|—)\s+/
const LIST_SPLIT_RE = /[\s,]+/

/**
 * The base name a declaration is matched against (baseline-audit's
 * `baselineName`, restated here rather than imported so this gate keeps
 * zero imports from the writer it audits).
 */
export function baselineName(path) {
  return String(path).split('/').pop()
}

/**
 * Parse the `<names or *>` half of a line: a list of base names or paths, or
 * the `*` wildcard. Tolerates a full path or a missing `.png`, like
 * `parseExpected` does — typed by a human under mild irritation.
 */
export function parseNameList(raw) {
  const parts = String(raw ?? '').split(LIST_SPLIT_RE).map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const part of parts) {
    if (part === '*') {
      out.push('*')
      continue
    }
    const base = part.split('/').pop()
    out.push(base.toLowerCase().endsWith('.png') ? base : `${base}.png`)
  }
  return [...new Set(out)]
}

/**
 * All `baseline-change:` declarations found in the given texts, parsed.
 *
 * @param {string[]} texts  the PR body, then commit messages, in order
 * @returns {{names:string[], reason:string, raw:string}[]}
 */
export function parseDeclarations(texts) {
  const out = []
  for (const text of texts ?? []) {
    if (!text) continue
    for (const m of String(text).matchAll(DECLARATION_RE)) {
      const body = m[1] ?? ''
      const sep = body.match(SEPARATOR_RE)
      if (!sep) continue // no `-- reason` half: not a declaration, reported as malformed
      const names = parseNameList(body.slice(0, sep.index))
      const reason = body.slice(sep.index + sep[0].length).trim()
      out.push({ names, reason, raw: m[0].trim() })
    }
  }
  return out
}

/**
 * All `design-review verdict:` lines found in the given texts, parsed.
 *
 * @param {string[]} texts  the PR body, then comment bodies, in order
 * @returns {{names:string[], sha:string|null, passing:boolean, raw:string}[]}
 */
export function parseVerdicts(texts) {
  const out = []
  for (const text of texts ?? []) {
    if (!text) continue
    for (const m of String(text).matchAll(VERDICT_RE)) {
      const body = m[1] ?? ''
      const shaMatch = body.match(SHA_RE)
      // The verdict word is the text before `@` — or, on a line with no sha,
      // before the `--` separator or the `baselines:` marker. Only that head is
      // read, and only as a whole: a substring match over the line let `not
      // approved`, and a baseline named `approved-mock.png`, verify (#3301).
      const sep = body.match(SEPARATOR_RE)
      const markerIdx = body.toLowerCase().indexOf('baselines:')
      const headEnd = shaMatch
        ? shaMatch.index
        : Math.min(sep ? sep.index : body.length, markerIdx === -1 ? body.length : markerIdx)
      const word = body.slice(0, headEnd).toLowerCase().replace(/^[^a-z/]+|[^a-z/]+$/g, '')
      const passing = PASSING_VERDICTS.has(word)
      // The names live after the `baselines:` marker when the line follows the
      // format; a line that only names files also counts — the word
      // "baselines:" is the convention, not the contract, and the failure
      // report quotes the line either way. Without the marker the names are
      // what follows the verdict head, so the verdict word is never read as a
      // baseline name.
      const listIdx = body.toLowerCase().lastIndexOf('baselines:')
      const listPart = listIdx === -1 ? body.slice(headEnd) : body.slice(listIdx + 'baselines:'.length)
      const names = parseNameList(listPart.replace(SHA_RE, ' ').replace(SEPARATOR_RE, ' '))
      out.push({ names, sha: shaMatch ? shaMatch[1] : null, passing, raw: m[0].trim() })
    }
  }
  return out
}

/**
 * Does any declaration cover this baseline? Pure.
 */
export function declaredFor(name, declarations) {
  return declarations.some((d) => d.names.includes('*') || d.names.includes(name))
}

/** Two shas name the same commit — one may be abbreviated. */
function sameSha(a, b) {
  const x = String(a).toLowerCase()
  const y = String(b).toLowerCase()
  return x.startsWith(y) || y.startsWith(x)
}

/**
 * Is this baseline verified: a PASSING verdict covers it, bound to a sha that
 * verifies, and no newer non-passing verdict vetoes that pass?
 *
 * The binding: `lastTouchSha` (the newest commit that touched the PNG, read
 * from the PR head) must be an ancestor of — or equal to — the verdict's sha,
 * and the verdict's sha an ancestor of — or equal to — the PR head. A verdict
 * naming a commit OLDER than the baseline's last touch describes a different
 * tree: the #3222 shape, where the review happened and the baselines were
 * re-committed after it.
 *
 * The veto (#3301): lines that NAME the baseline outrank `*` lines; within
 * the tier that applies, a pass stands only if every non-passing line is
 * provably older — its sha a strict ancestor of the pass's. A tie, unrelated
 * shas, unknown ancestry or an unbound block leave the block standing. A
 * block provably about a different image (before the last touch, or off the
 * head) is ignored, like an unbound pass.
 *
 * `isAncestor(a, b)` answers "is commit a an ancestor of (or equal to) b?" —
 * null when ancestry could not be determined, which fails closed.
 */
export function verifiedFor(name, verdicts, { lastTouchSha, headSha, isAncestor }) {
  if (!lastTouchSha || !headSha) return false // unbindable: nothing can verify
  const bound = (v) => {
    if (!v.sha) return false
    const touchOk = isAncestor(lastTouchSha, v.sha)
    const headOk = isAncestor(v.sha, headSha)
    return touchOk === true && headOk === true
  }
  // A block is ignored only when its sha provably describes another image; an
  // unbound or unknown one stands (fail closed).
  const blockApplies = (v) =>
    !v.sha || (isAncestor(lastTouchSha, v.sha) !== false && isAncestor(v.sha, headSha) !== false)
  const relevant = (v) => (v.passing ? bound(v) : blockApplies(v))
  const named = verdicts.filter((v) => v.names.includes(name) && relevant(v))
  const tier = named.length > 0
    ? named
    : verdicts.filter((v) => v.names.includes('*') && relevant(v))
  const blocks = tier.filter((v) => !v.passing)
  const clears = (pass, block) =>
    Boolean(block.sha) && !sameSha(block.sha, pass.sha) && isAncestor(block.sha, pass.sha) === true
  return tier.some((v) => v.passing && blocks.every((b) => clears(v, b)))
}

/**
 * The pure verdict. Dependency-free; every branch is unit-tested and the four
 * acceptance branches are mutation-proven.
 *
 * @param {object} o
 * @param {{number:number, base?:string|null, defaultBranch?:string|null, draft?:boolean, headSha?:string|null}} o.pr
 * @param {{path:string, status:string}[]} o.files  GitHub pulls/files entries
 *        (status ∈ added|removed|modified|renamed|changed|unchanged)
 * @param {string[]} o.declarationTexts  PR body, then commit messages
 * @param {string[]} o.verdictTexts      PR body, then comment bodies
 * @param {Object<string,string|null>} [o.lastTouch]  path -> newest touching commit sha on the PR head (null = unknown)
 * @param {(a:string,b:string)=>boolean|null} o.isAncestor
 * @returns {{verdict:'pass'|'fail', reason:string, report:string, pngs:{modified:string[],added:string[]}, missing:{path:string, needsVerdict:boolean, declared:boolean, verified:boolean}[]}}
 */
export function evaluate({ pr, files, declarationTexts, verdictTexts, lastTouch = {}, isAncestor }) {
  const inScope = (pr.defaultBranch && pr.base !== pr.defaultBranch)
    ? null
    : (files ?? []).filter((f) => f?.path?.startsWith(`${BASELINE_DIR}/`) && f.path.endsWith('.png'))

  const pngs = { modified: [], added: [] }
  for (const f of inScope ?? []) {
    if (f.status === 'removed') continue
    if (f.status === 'added' || f.status === 'renamed') pngs.added.push(f.path)
    else pngs.modified.push(f.path) // 'modified', plus defensive 'changed'/'unchanged'
  }

  if (pr.draft === true) {
    return { verdict: 'pass', reason: 'draft pull request — not a merge candidate; re-checked on ready_for_review', pngs, missing: [], report: '' }
  }
  if (inScope === null) {
    return {
      verdict: 'pass',
      reason: `merges into ${pr.base}, not the default branch — a promotion PR cannot carry per-file verdicts (squash commits keep the trailer but not the body); baselines here are judged on the dev PRs that made them`,
      pngs, missing: [], report: '',
    }
  }
  const pngCount = pngs.modified.length + pngs.added.length

  const declarations = parseDeclarations(declarationTexts)
  const verdicts = parseVerdicts(verdictTexts)
  const declaredForName = (name) =>
    declarations.some((d) => (d.names.includes('*') || d.names.includes(name)) && d.reason.length >= MIN_REASON_CHARS)
  const missing = []
  for (const path of pngs.modified) {
    const name = baselineName(path)
    const declared = declaredForName(name)
    const verified = verifiedFor(name, verdicts, {
      lastTouchSha: lastTouch[path] ?? null,
      headSha: pr.headSha ?? null,
      isAncestor,
    })
    if (!declared || !verified) missing.push({ path, needsVerdict: true, declared, verified })
  }
  for (const path of pngs.added) {
    const name = baselineName(path)
    const declared = declaredForName(name)
    if (!declared) missing.push({ path, needsVerdict: false, declared, verified: false })
  }

  const counts = `read ${pngCount} changed baseline PNG(s): ${pngs.modified.length} modified, ${pngs.added.length} added`
  if (missing.length === 0) {
    const report = [
      `✅ Baseline change gate (#3232): ${counts} — every modified baseline carries a declared reason and a verified design-review verdict.`,
      ``,
      `> This gate checks that the declaration lines EXIST, not who wrote them: the author`,
      `> writes both lines, so a green tick here is the author's signed declaration, not proof`,
      `> a design review ran. Provenance is review's job.`,
    ].join('\n')
    return { verdict: 'pass', reason: counts + ' — all declared and verified', pngs, missing, report }
  }

  const lines = [
    `❌ Baseline change gate (#3232): ${counts}; ${missing.length} of them fail the gate.`,
    ``,
    `A PR that MODIFIES an existing visual baseline must say, for each modified PNG, why it`,
    `moved, and carry a design-review verdict that names it. ADDED baselines (a new screen)`,
    `need the declaration only; deleted baselines are out of scope. Add these lines to the`,
    `PR body (verdicts may instead live in a PR comment):`,
    ``,
    '```',
    `baseline-change: <file.png[, more.png...] | *> -- <why the pixels moved, >= ${MIN_REASON_CHARS} chars>`,
    `design-review verdict: passed @ <sha> -- baselines: <file.png[, more.png...] | *>`,
    '```',
    ``,
    `The verdict's <sha> must name a commit at or after the last commit that touched each`,
    `PNG (a review given before the baseline was re-committed does not verify it). For a`,
    `mass re-bless — a font or Playwright bump that moves every baseline — declare \`*\`.`,
    `A non-passing verdict (\`changes requested\`) at or after a pass vetoes it, and a line`,
    `naming a file outranks a \`*\` line for that file: re-review the fixed PNG and post a`,
    `new \`passed\` at a later sha rather than deleting the earlier block.`,
    ``,
    `Per file:`,
    ``,
    ...missing.map((m) => `- \`${m.path}\` — ${!m.declared ? 'NO declared reason' : 'declared'}; ${m.needsVerdict && !m.verified ? (m.declared ? 'NO verified verdict' : 'no verified verdict') : 'verdict ok'}${m.needsVerdict && !m.verified && (lastTouch[m.path] == null || pr.headSha == null) ? ' (sha binding could not be read — fail closed)' : ''}`),
    ``,
    `> Provenance: the author writes both lines, so this gate checks that the text exists,`,
    `> not who wrote it. The design review itself is §5 of the frontend playbook.`,
    ``,
    `The gate runs on pull requests into the default branch, re-reads the body on every`,
    `edit, and is advisory until a ruleset makes it required (#3232, epic #3231).`,
  ]
  return {
    verdict: 'fail',
    reason: `${missing.length} changed baseline(s) lack a declared reason or a verified design-review verdict`,
    pngs,
    missing,
    report: lines.join('\n'),
  }
}

/**
 * Read everything `evaluate` needs from the GitHub API through `gh`, the way
 * pr-ownership-gate.mjs does. Throws on a failed PR read (fail closed at the
 * CLI boundary); per-file reads that fail mark that file's sha unknown, which
 * fails its verification.
 */
export async function collect({ gh, repo, prNumber }) {
  // `gh` (ghRunner) is async and never rejects — execFileSync errors propagate
  // as a rejection, which the CLI boundary fails closed on.
  const run = async (args) => JSON.parse(await gh(['api', ...args, '--jq', '.'], { input: null }))
  const files = []
  for (let page = 1; ; page += 1) {
    const chunk = await run([`repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`])
    files.push(...chunk)
    if (!Array.isArray(chunk) || chunk.length < 100) break
  }
  const prJson = await run([`repos/${repo}/pulls/${prNumber}`])
  const comments = []
  for (let page = 1; ; page += 1) {
    const chunk = await run([`repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`])
    comments.push(...(chunk ?? []).map((c) => c.body ?? ''))
    if (!Array.isArray(chunk) || chunk.length < 100) break
  }
  const commits = []
  for (let page = 1; ; page += 1) {
    const chunk = await run([`repos/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`])
    commits.push(...(chunk ?? []).map((c) => c.commit?.message ?? ''))
    if (!Array.isArray(chunk) || chunk.length < 100) break
  }
  const changedPngs = files.filter((f) => f?.path?.startsWith(`${BASELINE_DIR}/`) && f.path.endsWith('.png') && f.status !== 'removed')
  const lastTouch = {}
  for (const f of changedPngs) {
    try {
      const hits = await run([`repos/${repo}/commits?path=${encodeURIComponent(f.path)}&sha=${prJson.head.sha}&per_page=1`])
      lastTouch[f.path] = hits?.[0]?.sha ?? null
    } catch {
      lastTouch[f.path] = null
    }
  }
  // Resolve the commit-graph questions the verdict needs BEFORE the pure
  // `evaluate` runs, so `evaluate` stays synchronous and dependency-free: for
  // each last-touch sha × verdict sha, each verdict sha × head sha, and each
  // ordered pair of verdict shas (which of two conflicting verdicts is newer,
  // #3301), is a an ancestor of (or equal to) b? Unknown pairs read as null —
  // fail closed.
  // Equal shas are trivially ancestors and are short-circuited in the reader,
  // so a self-compare the API refuses cannot sink a valid verdict.
  const verdictShas = [...new Set(parseVerdicts([prJson.body ?? '', ...comments]).map((v) => v.sha).filter(Boolean))]
  const touchShas = [...new Set(changedPngs.map((f) => lastTouch[f.path]).filter(Boolean))]
  const headSha = prJson.head?.sha ?? null
  const ancestry = new Map()
  const probe = async (a, b) => {
    if (a === b) return true
    const key = `${a}|${b}`
    if (!ancestry.has(key)) {
      try {
        const cmp = await run([`repos/${repo}/compare/${a}...${b}`])
        ancestry.set(key, cmp?.status === 'ahead' || cmp?.status === 'identical')
      } catch {
        ancestry.set(key, null)
      }
    }
    return ancestry.get(key)
  }
  for (const t of touchShas) for (const s of verdictShas) await probe(t, s)
  for (const s of verdictShas) if (headSha) await probe(s, headSha)
  for (const a of verdictShas) for (const b of verdictShas) if (a !== b) await probe(a, b)
  const isAncestor = (a, b) => {
    if (a === b) return true
    const v = ancestry.get(`${a}|${b}`)
    return v === undefined ? null : v
  }
  return {
    pr: {
      number: prNumber,
      base: prJson.base?.ref ?? null,
      defaultBranch: prJson.base?.repo?.default_branch ?? null,
      draft: prJson.draft === true,
      headSha: prJson.head?.sha ?? null,
    },
    files: files.map((f) => ({ path: f.path, status: f.status })),
    declarationTexts: [prJson.body ?? '', ...commits],
    verdictTexts: [prJson.body ?? '', ...comments],
    lastTouch,
    isAncestor,
  }
}

export function ghRunner() {
  return async (args, { input } = {}) => {
    const { execFileSync } = await import('node:child_process')
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  }
}

// ---------------------------------------------------------------------------
// CLI — `node scripts/ci/baseline-verdict-gate.mjs --event "$GITHUB_EVENT_PATH"`
// Exit 0 = pass, 1 = fail (or could not read: fail closed), 2 = bad arguments.
// The report goes to stdout so the job log and the step summary can carry it.
// The process ends by itself (never `process.exit` after a stdout write).
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) await (async () => {
  const { readFileSync } = await import('node:fs')
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
  }
  const eventPath = arg('event')
  if (!eventPath) {
    console.error('usage: baseline-verdict-gate.mjs --event <file>')
    process.exitCode = 2
    return
  }
  const repo = process.env.GITHUB_REPOSITORY ?? 'd-hinders/Haven-AI'
  try {
    const ev = JSON.parse(readFileSync(eventPath, 'utf8'))
    const prNumber = Number(ev?.pull_request?.number ?? ev?.number)
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error('event payload carries no pull request number')
    const collected = await collect({ gh: ghRunner(), repo, prNumber })
    const result = evaluate(collected)
    if (result.verdict === 'pass') {
      console.log(result.report || `✅ Baseline change gate: ${result.reason}.`)
      process.exitCode = 0
    } else {
      console.log(result.report)
      process.exitCode = 1
    }
  } catch (e) {
    console.log(`❌ Baseline change gate: could not read this pull request's changed baselines, body, comments or commits — the gate fails closed. Re-run this job. (${e?.message ?? e})`)
    process.exitCode = 1
  }
})()
