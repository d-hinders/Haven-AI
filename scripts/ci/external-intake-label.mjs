// Marks external intake (#4200 part A) — the decision behind
// `.github/workflows/external-intake-label.yml`. The definitions it applies
// live in `external-intake.mjs`; this file decides what to write and writes it.
//
// - `opened` (issue or pull request) by an external author: add `external`
//   (and `pending-review` on an issue — never on a pull request), prefix the
//   title with `[external] ` and post ONE comment saying how it is accepted.
// - `unlabeled` of `external` by a maintainer: strip the prefix, so it never
//   reaches a squash subject. A non-maintainer unlabel changes nothing here —
//   and accepts nothing in the gate either.
//
// The label is a marker for humans and queues. It is NOT the control: the gate
// and the agent refusal both decide from the author and the events, so a
// label this workflow failed to add leaves the item exactly as blocked.
//
// Input is the event file GitHub provides (`$GITHUB_EVENT_PATH`) — the title
// and body are public text, never interpolated into a shell. Every write goes
// through `gh api` with argv (no shell), on the issues endpoint, which serves
// pull requests too.

import { EXTERNAL_LABEL, TITLE_PREFIX, isExternalAuthor, maintainerActorResolver, withPrefix, withoutPrefix } from './external-intake.mjs'

/** The one comment posted on an external item. */
export function intakeComment({ kind, author }) {
  const what = kind === 'pr' ? 'pull request' : 'issue'
  return [
    `This ${what} was opened by @${author}, who is not one of Haven's maintainers, so it is marked \`${EXTERNAL_LABEL}\`.`,
    '',
    `Haven does not take outside contributions: it will not be built or merged until a maintainer accepts it by removing the \`${EXTERNAL_LABEL}\` label. ` +
      `Until then the required **External intake gate** check fails on ${kind === 'pr' ? 'it' : 'any pull request that closes it'}.`,
    '',
    'Posted by the external intake workflow (#4200).',
  ].join('\n')
}

/**
 * Pure decision.
 *
 * @param {object} o
 * @param {'issues'|'pull_request_target'} o.eventName
 * @param {string} o.action                 `opened` | `unlabeled` | anything else (ignored)
 * @param {{number:number, title:string, author:string, association:string, userType:string}} o.item
 * @param {string|null} [o.label]           the label an `unlabeled` event names
 * @param {boolean} [o.senderIsMaintainer]  resolved for an `unlabeled` event only
 * @returns {{actions:({type:'addLabels', labels:string[]}|{type:'setTitle', title:string}|{type:'comment', body:string})[], reason:string}}
 */
export function decide({ eventName, action, item, label = null, senderIsMaintainer = false }) {
  const kind = eventName === 'pull_request_target' ? 'pr' : 'issue'
  if (action === 'opened') {
    if (!isExternalAuthor({ association: item.association, userType: item.userType })) {
      return { actions: [], reason: `#${item.number} by ${item.author} (${item.association || 'NONE'}, ${item.userType || 'no type'}) is not external` }
    }
    const actions = [{ type: 'addLabels', labels: kind === 'issue' ? [EXTERNAL_LABEL, 'pending-review'] : [EXTERNAL_LABEL] }]
    const title = withPrefix(item.title)
    if (title !== item.title) actions.push({ type: 'setTitle', title })
    actions.push({ type: 'comment', body: intakeComment({ kind, author: item.author }) })
    return { actions, reason: `#${item.number} by ${item.author} (${item.association || 'NONE'}) is external — marked` }
  }
  if (action === 'unlabeled') {
    if (String(label ?? '').toLowerCase() !== EXTERNAL_LABEL) return { actions: [], reason: `unlabeled ${label ?? '(none)'}, not ${EXTERNAL_LABEL}` }
    if (!senderIsMaintainer) return { actions: [], reason: `#${item.number}: ${EXTERNAL_LABEL} removed by a non-maintainer — not an acceptance; title left as is` }
    const title = withoutPrefix(item.title)
    if (title === item.title) return { actions: [], reason: `#${item.number} accepted; title carries no ${JSON.stringify(TITLE_PREFIX)} prefix` }
    return { actions: [{ type: 'setTitle', title }], reason: `#${item.number} accepted — prefix stripped` }
  }
  return { actions: [], reason: `action ${action} is not handled` }
}

/** The fields `decide` needs, from the event file. */
export function fromEvent(eventName, ev) {
  const raw = eventName === 'pull_request_target' ? ev?.pull_request : ev?.issue
  return {
    action: String(ev?.action ?? ''),
    label: ev?.label?.name ?? null,
    sender: { login: ev?.sender?.login ?? '', type: ev?.sender?.type ?? '' },
    item: {
      number: Number(raw?.number),
      title: String(raw?.title ?? ''),
      author: raw?.user?.login ?? '',
      association: String(raw?.author_association ?? 'NONE'),
      userType: String(raw?.user?.type ?? ''),
    },
  }
}

/** Apply the actions through `gh api` (argv, no shell). Throws on the first failed write. */
export async function apply({ gh, repo, number, actions }) {
  for (const a of actions) {
    if (a.type === 'addLabels') {
      const args = ['api', '-X', 'POST', `repos/${repo}/issues/${number}/labels`]
      for (const l of a.labels) args.push('-f', `labels[]=${l}`)
      await gh(args)
    } else if (a.type === 'setTitle') {
      await gh(['api', '-X', 'PATCH', `repos/${repo}/issues/${number}`, '-f', `title=${a.title}`])
    } else if (a.type === 'comment') {
      await gh(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-F', 'body=@-'], { input: a.body })
    }
  }
}

export function ghRunner() {
  return async (args, { input } = {}) => {
    const { execFileSync } = await import('node:child_process')
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  }
}

// ---------------------------------------------------------------------------
// CLI — `node scripts/ci/external-intake-label.mjs --event "$GITHUB_EVENT_PATH" --event-name "$GITHUB_EVENT_NAME" [--apply]`
// Without --apply it prints the decision and writes nothing. Exit 0 = decided
// (and applied), 1 = a read or write failed, 2 = bad arguments.
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
  const eventName = arg('event-name')
  if (!eventPath || (eventName !== 'issues' && eventName !== 'pull_request_target')) {
    console.error('usage: external-intake-label.mjs --event <file> --event-name issues|pull_request_target [--apply]')
    process.exitCode = 2
    return
  }
  const repo = process.env.GITHUB_REPOSITORY ?? 'd-hinders/Haven-AI'
  try {
    const { action, label, sender, item } = fromEvent(eventName, JSON.parse(readFileSync(eventPath, 'utf8')))
    const gh = ghRunner()
    let senderIsMaintainer = false
    if (action === 'unlabeled' && String(label ?? '').toLowerCase() === EXTERNAL_LABEL) {
      senderIsMaintainer = await maintainerActorResolver({ gh, repo })(sender)
    }
    const { actions, reason } = decide({ eventName, action, item, label, senderIsMaintainer })
    console.log(`External intake: ${reason}.`)
    for (const a of actions) console.log(`- ${a.type}${a.labels ? ` ${a.labels.join(', ')}` : ''}${a.type === 'setTitle' ? ` → ${JSON.stringify(a.title)}` : ''}`)
    if (process.argv.includes('--apply') && actions.length) await apply({ gh, repo, number: item.number, actions })
    process.exitCode = 0
  } catch (e) {
    console.log(`❌ External intake: a read or write failed — re-run this job. (${e?.message ?? e})`)
    process.exitCode = 1
  }
})()
