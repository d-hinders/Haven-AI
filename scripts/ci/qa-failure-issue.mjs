#!/usr/bin/env node
// The ONE standing `qa-failure` issue (#2767).
//
// Until #2767, `.github/workflows/qa-dev.yml` opened a new issue titled
// `qa-dev money-flow failed (<date>)` whenever NO `qa-failure` issue was open —
// the date was only in the title — so a failure after the previous issue had
// been closed filed a sibling (several on one day), and a failing day with one
// already open filed nothing. Thirteen such issues between 2026-09-01 and
// 2026-09-08, up to three a day (`gh issue list --label qa-failure --state all
// --search 'created:2026-09-01..2026-09-08'`, read 2026-09-08), each closed by
// hand once green, each a ticket the backlog counted as needed. The reopen path
// below is the half that lookup lacked. `docs-audit.yml` already does the right thing for
// the staleness report — one issue, rewritten in place — and this script gives
// the money-flow harness the same shape:
//
//   - an OPEN `qa-failure` issue exists → rewrite its body with the latest run
//     and leave one comment recording the failure in the thread's history;
//   - none open, but the standing issue exists CLOSED (it was closed on green)
//     → REOPEN it, then the same edit + comment. A second failing day updates
//     the same issue instead of opening `failed (<date+1>)`;
//   - neither → create it, once, under the fixed title.
//
// `gh` is called through an injectable runner so the test can drive this exact
// entry point with a recording stub on PATH and assert which calls were REACHED
// (ship-next § Implement step 5: presence in source is not reachability). The
// default runner is the real `gh`, which the workflow has via GH_TOKEN.
//
// Usage (from the workflow's failure step):
//   TRIGGER='...' RUN_URL='...' node scripts/ci/qa-failure-issue.mjs

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const LABEL = 'qa-failure'
export const LABEL_COLOR = 'b60205'
export const LABEL_DESCRIPTION =
  'Automated: the scheduled/post-deploy money-flow QA run is failing (one standing issue)'

/** Fixed title — the upsert finds a closed standing issue by it. No date in it, on purpose. */
export const ISSUE_TITLE = 'qa-dev money-flow failing'

/** The body: latest failure only. History lives in the comments. */
export function buildBody({ trigger, runUrl, when }) {
  return [
    'The deterministic money-flow QA run (`qa-dev.yml`) is failing. This is the **one standing**',
    '`qa-failure` issue (#2767): each new failure rewrites this body and adds a comment, and the',
    'issue is reopened rather than replaced when it was closed on green.',
    '',
    '## Latest failure',
    '',
    `- **Trigger:** \`${trigger}\``,
    `- **Run:** ${runUrl}`,
    `- **When:** ${when}`,
    '',
    'This blocks the dev → main freshness gate (#578) until a green run exists.',
    'Open the run to see which scenario failed, then follow the triage steps in',
    '`docs/operations/agent-qa.md` → Troubleshooting. A transient testnet/RPC',
    'flake can be cleared by re-dispatching the workflow; a real regression should',
    'get its own bug report under `docs/bug-reports/`. Close this issue once a run is green;',
    'the next failure reopens it.',
  ].join('\n')
}

export function buildComment({ trigger, runUrl, when }) {
  return `\`qa-dev\` failure at ${when} (trigger: \`${trigger}\`) — ${runUrl}`
}

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' })

function firstNumber(json) {
  try {
    const parsed = JSON.parse(json || '[]')
    const n = Array.isArray(parsed) ? parsed[0]?.number : undefined
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Upsert the standing issue. Returns { action, number } where action is one of
 * 'updated' | 'reopened' | 'created', so the workflow log states what happened.
 */
export function upsertStandingIssue({ gh = defaultGh, trigger, runUrl, when, log = console.log }) {
  const body = buildBody({ trigger, runUrl, when })
  const comment = buildComment({ trigger, runUrl, when })

  // Ensure the label exists (labels.yml owns only the surface taxonomy). A
  // failure here (already exists, transient API error) must not stop the upsert.
  try {
    gh(['label', 'create', LABEL, '--color', LABEL_COLOR, '--description', LABEL_DESCRIPTION, '--force'])
  } catch {
    // tolerated
  }

  const open = firstNumber(
    gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '1', '--json', 'number']),
  )
  if (open !== null) {
    gh(['issue', 'edit', String(open), '--body', body])
    gh(['issue', 'comment', String(open), '--body', comment])
    log(`Updated the standing qa-failure issue #${open}`)
    return { action: 'updated', number: open }
  }

  // Closed on green? Reopen the SAME issue rather than filing a sibling.
  const closed = firstNumber(
    gh([
      'issue', 'list', '--label', LABEL, '--state', 'closed', '--limit', '1',
      '--search', `in:title "${ISSUE_TITLE}"`, '--json', 'number',
    ]),
  )
  if (closed !== null) {
    gh(['issue', 'reopen', String(closed)])
    gh(['issue', 'edit', String(closed), '--body', body])
    gh(['issue', 'comment', String(closed), '--body', comment])
    log(`Reopened the standing qa-failure issue #${closed}`)
    return { action: 'reopened', number: closed }
  }

  const created = gh(['issue', 'create', '--label', LABEL, '--title', ISSUE_TITLE, '--body', body])
  log(`Created the standing qa-failure issue: ${String(created).trim()}`)
  return { action: 'created', number: null }
}

function main() {
  const trigger = process.env.TRIGGER
  const runUrl = process.env.RUN_URL
  if (!trigger || !runUrl) {
    console.error('qa-failure-issue: TRIGGER and RUN_URL must be set')
    process.exit(2)
  }
  const when = process.env.WHEN || new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  const result = upsertStandingIssue({ trigger, runUrl, when })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
