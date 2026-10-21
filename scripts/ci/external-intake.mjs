// The external-intake definitions (#4200): who is a maintainer, what is
// external, what accepts it. Both halves import this file — the labelling
// workflow (`external-intake-label.mjs`, part A) and the required check
// (`external-intake-gate.mjs`, part C) — so the rule has one home in code; the
// agent-facing copy is AGENTS.md § Cross-session agent coordination.
//
// ## The incident
//
// Issue #4107 was a vendor pitch (`author_association: NONE`, no labels). A
// partner pipeline claimed it about six hours after it was filed, built it and
// self-merged it as PR #4148 (`Closes #4107`) with no review; PR #4195 reverted
// it. `pending-review` could not have stopped it: only `new-task` applies that
// label, and an issue filed from outside never passes through `new-task`.
//
// ## The definitions (the issue's, binding — none of them is label-only)
//
// - Maintainer author: `author_association` in `TRUSTED_ASSOCIATIONS`
//   (claim-collision.mjs — imported, not copied).
// - Bot: `user.type === 'Bot'`. A Bot is never external on its own account:
//   `github-actions[bot]` issues read `CONTRIBUTOR` (measured on 3654, 3645,
//   2769, 666), which is not in the trusted set.
// - External: an issue or PR whose author is neither.
// - Accepted: the item's events hold an `unlabeled` event for `external` whose
//   actor is a maintainer. The label's ABSENCE accepts nothing: an item filed
//   while this workflow was down, or whose label a bot removed, is still
//   blocked. Read from the events API, never from an event payload.
// - Blocked: external and not accepted.
//
// One narrowing beyond the issue's text: a LATER maintainer `labeled:
// external` event revokes an earlier acceptance — re-adding the label is the
// natural way to take an acceptance back, and it can only ever block more.
//
// ## Who counts as a maintainer ACTOR
//
// An event actor carries no `author_association`, so the actor of an unlabel
// is resolved through the collaborator-permission API instead: a `User` whose
// legacy `permission` is `admin` or `write` (`maintain` folds into `write`
// there). Measured 2026-10-21: d-hinders `admin`, PhilipEriksson and
// AntonioSaaranen `write`, the #4107 author `read`; `github-actions` is not a
// user (404). A Bot actor is never a maintainer, whatever installed it.
//
// Reads FAIL CLOSED: a permission or events read that errors throws, and both
// callers turn that into a visible failure, never a silent acceptance.

import { TRUSTED_ASSOCIATIONS } from './claim-collision.mjs'

export const EXTERNAL_LABEL = 'external'
export const TITLE_PREFIX = '[external] '
/** Legacy `permission` values (collaborator-permission API) that make an actor a maintainer. */
export const MAINTAINER_PERMISSIONS = new Set(['admin', 'write'])

export function isMaintainerAssociation(association) {
  return TRUSTED_ASSOCIATIONS.has(String(association ?? '').toUpperCase())
}

export function isBotType(userType) {
  return String(userType ?? '') === 'Bot'
}

/** External = neither a maintainer nor a Bot. A missing association is `NONE`. */
export function isExternalAuthor({ association, userType }) {
  return !isBotType(userType) && !isMaintainerAssociation(association)
}

/**
 * The acceptance read off an item's events (oldest first, as the API returns
 * them). `isMaintainerActor(actor)` answers for one `{login, type}`; only the
 * `external` label's events by maintainers are consulted, so a bot's or an
 * outsider's (un)labelling neither accepts nor revokes.
 *
 * @returns {{accepted:boolean, by:string|null, at:string|null}}
 */
export function acceptanceFrom(events, isMaintainerActor) {
  let state = { accepted: false, by: null, at: null }
  for (const e of events ?? []) {
    if (e?.event !== 'unlabeled' && e?.event !== 'labeled') continue
    if (String(e?.label?.name ?? '').toLowerCase() !== EXTERNAL_LABEL) continue
    if (!e?.actor || !isMaintainerActor(e.actor)) continue
    state = e.event === 'unlabeled' ? { accepted: true, by: e.actor.login, at: e.created_at ?? null } : { accepted: false, by: null, at: null }
  }
  return state
}

/** The pinned refusal line every agent prints (#4200 part B; AGENTS.md carries the same string). */
export function refusalLine(number, login) {
  return `Not building #${number}: external author ${login}, not accepted by a maintainer (a maintainer accepts it by removing the \`external\` label).`
}

/** Prefix a title once. */
export function withPrefix(title) {
  const t = String(title ?? '')
  return t.startsWith(TITLE_PREFIX) ? t : `${TITLE_PREFIX}${t}`
}

/** Strip every leading `[external] ` (a double prefix must not survive into a squash subject). */
export function withoutPrefix(title) {
  let t = String(title ?? '')
  while (t.startsWith(TITLE_PREFIX)) t = t.slice(TITLE_PREFIX.length)
  return t
}

function parseJsonStrict(text, what) {
  const t = String(text ?? '').trim()
  if (t === '') throw new Error(`${what}: gh returned no output`)
  return JSON.parse(t)
}

/**
 * A memoised maintainer-actor resolver over the collaborator-permission API.
 * Bots are answered without a read. A failed read throws (fail closed).
 */
export function maintainerActorResolver({ gh, repo }) {
  const cache = new Map()
  const resolve = async (actor) => {
    if (!actor?.login || isBotType(actor.type)) return false
    const key = String(actor.login).toLowerCase()
    if (!cache.has(key)) {
      const perm = parseJsonStrict(await gh(['api', `repos/${repo}/collaborators/${actor.login}/permission`]), `permission of ${actor.login}`)
      cache.set(key, MAINTAINER_PERMISSIONS.has(String(perm?.permission ?? '')))
    }
    return cache.get(key)
  }
  return resolve
}

/**
 * Read one issue or PR's standing live: author, association, type, state and —
 * only for an external author — its acceptance from the events API.
 *
 * @returns {Promise<{number:number, author:string, association:string, userType:string, state:string, isPullRequest:boolean, external:boolean, accepted:boolean, acceptedBy:string|null, blocked:boolean}>}
 */
export async function readStanding({ gh, repo, number, isMaintainerActor = maintainerActorResolver({ gh, repo }) }) {
  const item = parseJsonStrict(await gh(['api', `repos/${repo}/issues/${number}`]), `#${number}`)
  const author = item?.user?.login ?? ''
  const association = String(item?.author_association ?? 'NONE')
  const userType = String(item?.user?.type ?? '')
  const external = isExternalAuthor({ association, userType })
  let acceptance = { accepted: false, by: null }
  if (external) {
    const pages = parseJsonStrict(await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/events?per_page=100`]), `events of #${number}`) ?? []
    const events = pages.flat()
    // Resolve every relevant actor first (async), then judge synchronously.
    const verdicts = new Map()
    for (const e of events) {
      if ((e?.event === 'unlabeled' || e?.event === 'labeled') && String(e?.label?.name ?? '').toLowerCase() === EXTERNAL_LABEL && e?.actor?.login) {
        const k = String(e.actor.login).toLowerCase()
        if (!verdicts.has(k)) verdicts.set(k, await isMaintainerActor(e.actor))
      }
    }
    acceptance = acceptanceFrom(events, (a) => verdicts.get(String(a.login).toLowerCase()) === true)
  }
  return {
    number,
    author,
    association,
    userType,
    state: String(item?.state ?? 'unknown'),
    isPullRequest: Boolean(item?.pull_request),
    external,
    accepted: acceptance.accepted,
    acceptedBy: acceptance.by,
    blocked: external && !acceptance.accepted,
  }
}
