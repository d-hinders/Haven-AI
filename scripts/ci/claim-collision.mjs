// Answers a `🔒 CLAIM #N` that lands on an issue somebody else already holds,
// instead of silently adding a second assignee (#3178).
//
// ## The incident this closes
//
// #3005, 2026-09-15: a session posted `🔒 CLAIM #3005` 76 minutes after another
// session had claimed the same issue with the same branch name. Its checker
// "grepped remote branches and open PRs but not the claim comments". The
// information was in the thread; nobody read it — and the projection
// (`claim-assignee.yml`) added the second assignee without a word, so the
// field itself said "two owners" where the protocol says "pick something else".
//
// ## The rule, as AGENTS.md § Cross-session agent coordination states it
//
// A live claim — the holder's last comment about it less than 24 hours ago, no
// `🔓 RELEASE` since — means: pick something else, or coordinate in #1289
// first. This module makes the projection enforce that rule at the moment a
// second claim arrives, with staleness measured as the section below defines
// it, and the three outcomes the issue asked for:
//
//   refuse    another session holds a LIVE claim (a claim comment, assigned or
//             not) → not recorded, reply says who, how old, when they were last
//             active on it if they have commented since, and where to
//             coordinate.
//   takeover  another session's claim is STALE (no activity about the issue
//             for 24 h, unreleased) → they are unassigned, the claimant
//             assigned, and the reply says so.
//   accept    nobody else holds it, or the other holder released it, or the
//             claimant is re-claiming their own issue (branch rename) → assign
//             silently, as before. An assignee with NO claim comment at all
//             (assigned by hand for tracking, or before the projection existed)
//             is also "accept": the claimant is ADDED beside them, which is
//             today's behaviour, because a tracking assignee is not a claim.
//
// ## Holders are CLAIMANTS, not the assignee field
//
// A holder is any collaborator, and any person, other than the claimant who
// posted a claim of this issue — assigned or not. The assignee field is only a projection and is wrong in
// exactly the two cases that matter here: two claims seconds apart (the
// workflow runs without a concurrency group, so both runs would read an empty
// field and both would accept), and an author GitHub refuses to assign (the
// old shell said so itself: "the author is not assignable on this repo"), whose
// claim would otherwise never be seen by anyone. The comments are already in
// hand, so the check reads them. Only a COLLABORATOR's comment, and only a
// PERSON's, can make a holder: #1289 is public, and a drive-by `🔒 CLAIM #N`
// there — or a bot quoting the format — must not be able to get every real
// claim of #N refused. The REST comment carries `author_association` and
// `user.type`; the same OWNER/MEMBER/COLLABORATOR set the workflow's own
// trigger gate uses is applied to holders, and `Bot` authors are dropped.
// Assignees need no such check — GitHub only assigns users it would let the
// gate through. Residual: `author_association` is computed when GitHub renders
// the comment, not frozen at posting time, so a FORMER collaborator's old claim
// stops counting once they leave — the under-blocking direction, accepted.
//
// ## A dead heat is resolved by age, not by who ran first
//
// Two claims seconds apart each see the other's comment (both runs read the
// thread ~20 s after their trigger). Without a tie-break both would be refused
// and nobody assigned — and each reply would name the LATER claimant as the
// holder. So the incoming claim's own timestamp is passed in, and a holder
// whose HOLD BEGAN after the incoming claim does not block it: the older hold
// wins, the newer run is the one refused. A hold begins at the holder's FIRST
// claim in force (their first claim after their last RELEASE), so their own
// re-claim or channel copy does not make them "newer" — measured on the
// #3015 shape, a session routinely holds two claim timestamps. Equal
// timestamps (same second) fall to the lexically smaller login, so the two
// runs still agree.
//
// ## Staleness is measured from the holder's last ACTIVITY, not the claim
//
// A four-day review round is normal here (#3170, #3172). The age that decides
// live-or-stale is the holder's newest comment about the issue — the claim
// itself, or any later comment by them on the issue's thread, or any later
// comment by them on the channel that names the issue — so an owner who is
// visibly working is never taken over on a timestamp alone. A holder whose
// timestamps cannot be read is treated as LIVE (refuse), the direction that
// cannot mislead.
//
// ## The reply must not parse as a marker
//
// The reply is posted by `github-actions[bot]`, which never triggers this
// workflow again (GITHUB_TOKEN comments do not fire `issue_comment`), and its
// text is shaped so the parser in `claim-assignee.mjs` reads nothing from it
// either: it opens with ⚠️ / ℹ️, never with the padlock, never with `#N`, and
// the word RELEASE appears only after the number is out of the leading run.
// Pinned by test.
//
// ## Why the whole channel is read
//
// Most claims are posted on #1289 ABOUT the issue, so "does @X hold a live
// claim on #N" cannot be answered from the issue thread alone. The channel is
// read in full (~14 REST pages today) because staleness needs the old claim,
// not just the recent ones.

import { parse } from './claim-assignee.mjs'

export const CHANNEL_ISSUE = 1289
/** AGENTS.md: "An unreleased claim blocks the other session for a day." */
export const LIVE_CLAIM_MS = 24 * 60 * 60_000
/** The same set `claim-assignee.yml`'s trigger gate admits. */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** GitHub logins are case-insensitive; every comparison here goes through this. */
export function sameLogin(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
}

/**
 * `branch feat/x` / `branch \`feat/x\`` out of a claim line, if present. The
 * token must contain a `/` — every branch this repo names has a prefix
 * (`feat/`, `fix/`, `chore/`, `claude/`), and without it "no branch named"
 * would yield "named".
 */
export function branchOf(body) {
  const m = String(body ?? '').match(/\bbranch\s*[`"']?([^\s`"'—–,)]*\/[^\s`"'—–,)]+)/i)
  return m ? m[1] : null
}

/**
 * Does this body mention `#issue` as activity — on a line that is neither a
 * quote nor inside a code fence, the same lines `parse()` reads? A quoted
 * status rollup or a fenced example must not keep a claim alive.
 */
export function mentionsIssue(body, issue) {
  const re = new RegExp(`(^|[^\\w/])#${issue}\\b`)
  let inFence = false
  for (const line of String(body ?? '').split('\n')) {
    if (/^\s*(?:\`\`\`|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || /^\s*>/.test(line)) continue
    if (re.test(line)) return true
  }
  return false
}

/** Human age: "76 min ago", "3 h ago", "3 d ago". */
export function ageText(fromIso, nowMs) {
  const ms = nowMs - Date.parse(fromIso)
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const min = Math.round(ms / 60_000)
  if (min < 90) return `${min} min ago`
  const h = Math.round(ms / 3_600_000)
  if (h < 48) return `${h} h ago`
  return `${Math.round(ms / 86_400_000)} d ago`
}

/**
 * For one holder: the newest claim of `issue` they posted, the FIRST claim of
 * their current hold (the earliest claim after their last RELEASE — a re-claim
 * or a channel copy does not restart a hold), whether they released it since,
 * and their last ACTIVITY about the issue after that claim (a later comment by
 * them on the issue's own thread, or a later comment by them on the channel
 * naming `#issue`). `comments` are
 * {author, body, createdAt, onIssue}, sorted here by time; ties keep input
 * order (issue comments first, then channel), which only matters for a claim
 * and a release stamped in the same second — harmless either way.
 */
export function holderClaim({ holder, issue, comments, channelIssue = CHANNEL_ISSUE }) {
  let claim = null
  let firstClaim = null
  let releasedAfter = false
  let lastActivityAt = null
  const mine = comments
    .filter((c) => sameLogin(c.author, holder))
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  for (const c of mine) {
    // Only the holder's OWN lines are parsed here, so the merge-time bot
    // release (#3177) is not seen — it does not need to be: that workflow
    // unassigns everyone itself, and a closed issue is skipped before this.
    const r = parse({ body: c.body, onIssue: c.onIssue ?? null, channelIssue })
    if (r.claim.includes(issue)) {
      claim = c
      if (!firstClaim || releasedAfter) firstClaim = c // a release ended the previous hold
      releasedAfter = false
      lastActivityAt = c.createdAt
    } else if (claim) {
      if (r.release.includes(issue)) releasedAfter = true
      if (c.onIssue === issue || mentionsIssue(c.body, issue)) lastActivityAt = c.createdAt
    }
  }
  return { claim, firstClaim, releasedAfter, lastActivityAt }
}

/**
 * Who, other than `claimant`, holds `issue` — and is their claim live or stale?
 * Shared by the collision reply (#3178) and the PR ownership gate (#3179), so
 * the two enforce ONE holder rule: a holder is a collaborator and a person
 * who posted a claim of the issue (assigned or not), or a current assignee;
 * a claim is live while the holder's last comment about the issue is < 24 h
 * old and no RELEASE by them followed it; a holder whose hold began (first
 * claim in force) after `claimedAt` does not count against it (older hold
 * wins).
 *
 * @returns {{others: string[], live: {holder:string, claim:object, ageMs:number, lastActivityAt:string|null}[], stale: object[]}}
 */
export function liveHolders({ issue, claimant, assignees, comments, claimedAt = null, nowMs = Date.now(), channelIssue = CHANNEL_ISSUE }) {
  // Candidates: every collaborator (person, not bot) who posted a claim of this
  // issue, plus whoever the field currently names — minus the claimant.
  const claimants = new Map() // lower-cased login → login as written
  for (const c of comments ?? []) {
    if (!c?.author || sameLogin(c.author, claimant)) continue
    // A holder must be a collaborator and a person: a drive-by claim on the
    // public channel, or a bot quoting the format, cannot get real claims
    // refused. (Assignees below need no check — GitHub only assigns users it
    // would let the gate through.)
    if (!TRUSTED_ASSOCIATIONS.has(String(c.authorAssociation ?? '').toUpperCase())) continue
    if (String(c.authorType ?? 'User') === 'Bot') continue
    if (parse({ body: c.body, onIssue: c.onIssue ?? null, channelIssue }).claim.includes(issue)) claimants.set(c.author.toLowerCase(), c.author)
  }
  const seen = new Set()
  const others = []
  for (const a of [...(assignees ?? []), ...claimants.values()]) {
    if (!a || sameLogin(a, claimant) || seen.has(a.toLowerCase())) continue
    seen.add(a.toLowerCase())
    others.push(a)
  }

  const live = []
  const stale = []
  for (const holder of others) {
    const { claim, firstClaim, releasedAfter, lastActivityAt } = holderClaim({ holder, issue, comments, channelIssue })
    if (!claim || releasedAfter) continue // tracking assignee, or released: not a claim in force
    // Dead heat: a holder whose hold BEGAN after the incoming claim does not
    // block it — the older hold wins (measured from the holder's FIRST claim in
    // force, so their own re-claim or channel copy does not make them
    // "newer"). Same second → smaller login wins.
    const mineMs = Date.parse(claimedAt ?? '')
    const theirsMs = Date.parse((firstClaim ?? claim).createdAt ?? '')
    if (Number.isFinite(mineMs) && Number.isFinite(theirsMs)) {
      if (theirsMs > mineMs) continue
      if (theirsMs === mineMs && String(holder).toLowerCase() > String(claimant).toLowerCase()) continue
    }
    const ageMs = nowMs - Date.parse(lastActivityAt ?? claim.createdAt)
    // Unreadable timestamps count as LIVE: refusing is the direction that
    // cannot mislead; a takeover on an unknown age would.
    if (!Number.isFinite(ageMs) || ageMs < LIVE_CLAIM_MS) live.push({ holder, claim, firstClaim, ageMs, lastActivityAt })
    else stale.push({ holder, claim, firstClaim, ageMs, lastActivityAt })
  }
  return { others, live, stale }
}

/**
 * Decide what a `🔒 CLAIM #issue` by `claimant` does.
 *
 * @param {object} o
 * @param {number} o.issue
 * @param {string} o.claimant
 * @param {string} o.state           the issue's state as GitHub reports it
 * @param {string[]} o.assignees     current assignees (a projection — holders
 *        are found from the comments, the field only adds candidates)
 * @param {{author:string, body:string, createdAt:string, onIssue?:number, authorAssociation?:string}[]} o.comments
 *        the issue's comments plus the channel's, tagged with where each was
 *        posted and with GitHub's `author_association` for the author
 * @param {number} o.postedOn        the issue the incoming claim was posted on
 * @param {string|null} [o.claimedAt] the incoming claim comment's created_at —
 *        a holder whose hold began after this does not block (older hold wins)
 * @param {number} [o.nowMs]
 * @param {number} [o.channelIssue]
 * @returns {{action:'skip'|'accept'|'refuse'|'takeover', assign?:string, unassign?:string[], reply?:{issue:number, body:string}, reason:string}}
 */
export function decideClaim({ issue, claimant, state, assignees, comments, postedOn, claimedAt = null, nowMs = Date.now(), channelIssue = CHANNEL_ISSUE }) {
  if (String(state).toLowerCase() !== 'open') return { action: 'skip', issue, reason: `issue is ${state}` }
  const { others, live, stale } = liveHolders({ issue, claimant, assignees, comments, claimedAt, nowMs, channelIssue })
  if (others.length === 0) return { action: 'accept', issue, assign: claimant, reason: 'nobody else holds it' }

  if (live.length > 0) {
    const lines = live.map(({ holder, claim, firstClaim, lastActivityAt }) => {
      const since = firstClaim ?? claim // the hold's start, not the newest re-claim
      const branch = branchOf(claim.body)
      const where = since.onIssue === channelIssue ? `on #${channelIssue}` : 'on this issue'
      // Activity is worth a clause only when it is later than the NEWEST
      // claim; a channel mirror of the claim is not new activity.
      const active = lastActivityAt && lastActivityAt !== claim.createdAt ? `, last active on it ${ageText(lastActivityAt, nowMs)}` : ''
      return `@${holder} claimed it ${ageText(since.createdAt, nowMs)} ${where}${branch ? ` (branch \`${branch}\`)` : ''}${active} and has not released it.`
    })
    const body = [
      `⚠️ Already claimed: issue ${issue} is held by ${live.map((l) => `@${l.holder}`).join(' and ')}. ${lines.join(' ')}`,
      `Per AGENTS.md § Cross-session agent coordination a live claim (< 24 h, no RELEASE since) means: pick something else, or coordinate in #${channelIssue} first. **This claim by @${claimant} was not recorded** — the assignee field is unchanged. (Posted by the claim projection, #3178.)`,
    ].join('\n\n')
    return { action: 'refuse', issue, reply: { issue: postedOn, body }, reason: `live claim by ${live.map((l) => l.holder).join(', ')}` }
  }

  if (stale.length > 0) {
    const lines = stale.map(({ holder, claim, firstClaim, lastActivityAt }) => `@${holder}'s claim was ${ageText((firstClaim ?? claim).createdAt, nowMs)}, their last comment about it ${ageText(lastActivityAt ?? claim.createdAt, nowMs)}, with no RELEASE since`)
    const body = [
      `ℹ️ Taken over: issue ${issue} — ${lines.join('; ')}. A claim with no activity for 24 h and no release is stale under AGENTS.md § Cross-session agent coordination, so it was reassigned to @${claimant}.`,
      `${stale.map((s) => `@${s.holder}`).join(' ')}: if you are still on this, say so here and re-claim; the reassignment is a projection, not a judgement. (Posted by the claim projection, #3178.)`,
    ].join('\n\n')
    return {
      action: 'takeover',
      issue,
      assign: claimant,
      unassign: stale.map((s) => s.holder),
      reply: { issue: postedOn, body },
      reason: `stale claim by ${stale.map((s) => s.holder).join(', ')}`,
    }
  }

  return { action: 'accept', issue, assign: claimant, reason: 'nobody else holds a claim in force' }
}

// ---------------------------------------------------------------------------
// Fetch and apply — `gh` injected, as in release-on-merge.mjs.
// ---------------------------------------------------------------------------

export function ghRunner() {
  return async (args, { input } = {}) => {
    const { execFileSync } = await import('node:child_process')
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  }
}

function parseJsonStrict(text, what) {
  const t = String(text ?? '').trim()
  if (t === '') throw new Error(`${what}: gh returned no output`)
  return JSON.parse(t)
}

async function readComments({ gh, repo, issue }) {
  const pages = parseJsonStrict(await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments?per_page=100`]), `comments of #${issue}`) ?? []
  const out = []
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const c of Array.isArray(page) ? page : []) {
      out.push({ author: c.user?.login ?? '', body: String(c.body ?? ''), createdAt: c.created_at, onIssue: issue, authorAssociation: c.author_association ?? 'NONE', authorType: c.user?.type ?? 'User', htmlUrl: c.html_url ?? null })
    }
  }
  return out
}

/** State, assignees, and the comments of the issue AND the channel. */
export async function fetchClaimState({ gh, repo, issue, channelIssue = CHANNEL_ISSUE }) {
  const meta = parseJsonStrict(await gh(['api', `repos/${repo}/issues/${issue}`]), `issue #${issue}`)
  const state = meta?.state ?? 'unknown'
  const assignees = (meta?.assignees ?? []).map((a) => a.login)
  if (String(state).toLowerCase() !== 'open') return { state, assignees, comments: [] }
  const comments = [...(await readComments({ gh, repo, issue }))]
  if (issue !== channelIssue) comments.push(...(await readComments({ gh, repo, issue: channelIssue })))
  return { state, assignees, comments }
}

/** Apply a decision; every write independent, refusals logged, never thrown. */
export async function applyClaim(decision, { gh, repo, issue, log = console.log }) {
  const done = []
  for (const login of decision.unassign ?? []) {
    try {
      await gh(['issue', 'edit', String(issue), '--repo', repo, '--remove-assignee', login])
      log(`  unassigned #${issue} from @${login} (stale claim taken over)`)
      done.push({ kind: 'unassign', login })
    } catch (e) {
      log(`  could not unassign @${login} from #${issue} (skipped): ${e?.message ?? e}`)
    }
  }
  if (decision.assign) {
    try {
      await gh(['issue', 'edit', String(issue), '--repo', repo, '--add-assignee', decision.assign])
      log(`  assigned #${issue} to @${decision.assign}`)
      done.push({ kind: 'assign', login: decision.assign })
    } catch (e) {
      log(`  could not assign #${issue} to @${decision.assign} (skipped): ${e?.message ?? e}`)
    }
  }
  if (decision.reply) {
    try {
      await gh(['issue', 'comment', String(decision.reply.issue), '--repo', repo, '-F', '-'], { input: decision.reply.body })
      log(`  replied on #${decision.reply.issue} (${decision.action})`)
      done.push({ kind: 'reply', issue: decision.reply.issue })
    } catch (e) {
      log(`  could not reply on #${decision.reply.issue} (skipped): ${e?.message ?? e}`)
    }
  }
  return done
}

// ---------------------------------------------------------------------------
// CLI — one claim number per invocation, called from claim-assignee.yml.
//
//   node scripts/ci/claim-collision.mjs --issue N --claimant LOGIN --posted-on M [--claimed-at ISO] [--apply]
//
// Exit 0 always once the arguments parse; a failed read logs and does nothing.
// The process ends by itself — never `process.exit(0)` after a stdout write:
// on a pipe the write is asynchronous and exit() drops it, which is how the
// first dry run of this CLI printed nothing at all.
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

if (isMain) {
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
  }
  const has = (name) => process.argv.includes(`--${name}`)
  const issue = Number(arg('issue'))
  const claimant = arg('claimant') ?? ''
  const postedOn = Number(arg('posted-on') ?? issue)
  const claimedAt = arg('claimed-at')
  if (!Number.isInteger(issue) || issue <= 0 || !/^[A-Za-z0-9-]+(\[bot\])?$/.test(claimant)) {
    console.error('usage: claim-collision.mjs --issue N --claimant LOGIN [--posted-on M] [--claimed-at ISO] [--apply]')
    process.exit(2)
  }
  const repo = process.env.GITHUB_REPOSITORY ?? 'd-hinders/Haven-AI'
  try {
    const gh = ghRunner()
    const { state, assignees, comments } = await fetchClaimState({ gh, repo, issue })
    const decision = decideClaim({ issue, claimant, state, assignees, comments, postedOn, claimedAt })
    process.stdout.write(`${JSON.stringify(decision)}\n`)
    if (has('apply') && decision.action !== 'skip') await applyClaim(decision, { gh, repo, issue })
    else if (decision.action === 'skip') console.log(`  skip claim #${issue} — ${decision.reason}`)
  } catch (e) {
    console.log(`could not read #${issue} or the channel — claim not projected (the comment is still the record): ${e?.message ?? e}`)
  }
  process.exitCode = 0
}
