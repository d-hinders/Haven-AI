/**
 * Queue-framing census guard — repo-wide (#1947 → #2063 → #2100/#2101).
 *
 * WHAT IT PINS
 *
 * There is no queue-and-approve step on any live Haven rail. The delegation
 * rail — the only rail that can pay (`packages/backend/src/rails/execution-rail.ts`,
 * `resolveExecutionRail` returns only `delegation | retired_session |
 * retired_allowance`) — enforces budget, recipient and expiry ON-CHAIN during
 * prepare, so an out-of-policy payment is DECLINED before any money moves and
 * before anything is written (`routes/payments.ts`: no active delegation → 403,
 * caveat rejection → 502; `modules/x402/delegation-authorize.ts`: over-budget →
 * 403 `delegation_budget_exceeded`). Both retired rails answer HTTP 410 at every
 * agent-payment entry point (#1986), #2020 retired the `agent_allowances`
 * surface, and #2055 dropped `approval_requests` outright — the table the
 * queued state was ever read back from does not exist.
 *
 * Prose that says otherwise is not stale documentation a human skims past. On
 * the SDK/MCP surfaces below it is what an LLM agent reads to decide what to
 * do: a description naming the AllowanceModule as the spend path steers an
 * agent at an endpoint that answers 410, and one promising a `pending_approval`
 * outcome makes it wait for an approval that will never arrive.
 *
 * WHY IT LIVES HERE AND NOT IN packages/frontend
 *
 * #2063 put this census in `packages/frontend/src/lib/__tests__/`. That job is
 * `if: needs.changes.outputs.frontend == 'true'` in `.github/workflows/ci.yml`,
 * so the guard could not fire on an SDK- or MCP-only PR — exactly the PR that
 * regresses the agent-facing half. Moved to `scripts/ci/`, which the
 * `ci_config_checks` job runs on EVERY PR, dependency-free, for the same reason
 * the money-path list lives there (#1206). One census, one phrase list, no
 * parallel guard.
 *
 * HOW IT CHECKS
 *
 * Comments are stripped first, then banned PROSE phrases are matched against
 * what is left. That is deliberate: `status === 'pending_approval'` and the
 * `pending_approval` wire literal are retained fail-closed code (see
 * `isPendingApproval` in `packages/mcp-server/src/tools.ts` for the argued
 * retention), and a maintainer comment may legitimately name the retired rail
 * to explain the retirement. What must not survive is an agent-visible or
 * reader-visible SENTENCE promising the queue.
 *
 * Source-text check, with the usual honesty: it proves the words are absent
 * from these files, not that every remaining sentence is true — that half is
 * the per-claim code citations in the shipping PR.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Every surface whose prose the census has cleared. Adding a file here is the
 * cheap way to keep a fix from rotting; removing one needs a reason in the PR.
 */
const GUARDED_FILES = [
  // #2063 — product copy + generated agent handoff text (frontend)
  'packages/frontend/src/app/page.tsx',
  'packages/frontend/src/app/signup/page.tsx',
  'packages/frontend/src/components/UsingYourAgentInfo.tsx',
  'packages/frontend/src/components/EditAgentModal.tsx',
  'packages/frontend/src/components/connect-agent/ReviewStep.tsx',
  'packages/frontend/src/app/(authenticated)/agents/[agentId]/AgentDetailClient.tsx',
  'packages/frontend/src/lib/agent-handoff.ts',
  'packages/frontend/src/lib/agent-skill-bundle.ts',
  // #2100 — SDK: model-facing tool descriptions, the published README, and the
  // examples that ship inside the npm tarball's `files` array
  'packages/sdk/src/tool-descriptions.ts',
  'packages/sdk/src/tools.ts',
  'packages/sdk/src/payment-state.ts',
  'packages/sdk/src/skill-content.ts',
  'packages/sdk/README.md',
  'packages/sdk/examples/x402_openapi_python.py',
  'packages/sdk/examples/mcp-x402-sse.ts',
  // #2101 — hosted MCP (the default topology) and the local MCP runtime
  'packages/mcp-server/src/server.ts',
  'packages/mcp-server/src/tools.ts',
  'packages/mcp-server/README.md',
  'packages/mcp/src/server.ts',
  'packages/mcp/src/tools.ts',
  'packages/mcp/README.md',
]

/**
 * Prose only. Nothing here can appear inside a legitimate code literal, an
 * enum value, or a wire-status comparison — that is what keeps the retained
 * fail-closed branches compiling while their false PROMISE stays deleted.
 *
 * Deliberately NOT banned, and each for a stated reason:
 * - "approval queue": the corrected prose says there is NO approval queue.
 * - "is pending" and "poll next_tool": too broad — the first matches the
 *   CORRECTED "no approval is pending", the second matches the legitimate
 *   transient funding poll (check_status_later). Both were tried and rejected:
 *   a phrase that trips on the fix is a guard that pressures the next author
 *   into reverting it.
 * - "wait_for_user_approval" / "pending_approval": retained wire values, and
 *   the SDK README documents them as "No longer produced" retirement records
 *   in the #2055 style.
 * - "needs_approval", "pending_approval" as an AGENT LIFECYCLE status, and the
 *   owner's one-time budget grant/revoke signature: those approvals are real
 *   and still happen (#1069, #1572).
 */
const QUEUE_CLAIMS = [
  // #2063's original list (frontend product copy)
  'waits for your approval',
  'wait for your approval',
  'waits for your manual approval',
  'queued for your approval',
  'queued for approval',
  'queued for the user',
  'need your manual approval',
  'needs your manual approval',
  'requires approval',
  // #2100/#2101 — agent-facing additions
  'queued for owner approval',
  'queues for owner approval',
  'queued for the wallet owner',
  'queued for the owner',
  'while it is pending',
  'while approval is pending',
  'until the payment is approved',
  'queued as pending_approval',
  'queued as a pending_approval',
  'waiting for user approval',
  'waiting for approval',
  'waiting for your approval',
  'wait for the wallet owner to approve',
  'approve in haven',
  'approves in haven',
  'owner must approve',
  'safe allowancemodule',
  'allowancemodule top-up',
  'allowancemodule allowance',
  'allowancemodule transaction',
  'allowancemodule transfer hash',
  "allowancemodule path",
  'pending_approval means stop',
  'after approval',
]

/**
 * Strip `//` line comments and block comments so a maintainer comment that
 * NAMES the retirement is not mistaken for a claim that re-asserts it. Crude
 * on purpose: it does not parse strings, so a banned phrase inside a string
 * literal that happens to follow a `//` on the same line would be missed. That
 * has never been the shape of this defect — the defect is whole sentences — and
 * the positive controls below prove the scanner still detects real prose.
 */
export function stripComments(source, { markdown = false } = {}) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  // JSDoc continuation lines (` * …`) and `#` comments are noise in SOURCE
  // files. In MARKDOWN both are content — `# Heading` and `* bullet` — and
  // blanking them would hide a queue claim written in a heading or a
  // star-bulleted list from the census entirely. Reviewer finding on #2100:
  // no live false negative, but a latent hole in three published READMEs.
  const decommented = markdown ? stripped : stripped.replace(/^\s*[*#]\s?.*$/gm, ' ')
  // Join adjacent string literals. A banned sentence in source is almost never
  // one literal — it is `'…is queued for the ' + 'wallet owner…'` wrapped across
  // lines by the formatter, and a contiguous-substring scanner sails straight
  // past it. This was not hypothetical: the three hosted guidance payloads the
  // #2100 review found had exactly that shape, and the census caught them only
  // because a SECOND banned phrase happened to sit inside one literal.
  return decommented.replace(/['"`]\s*\+\s*['"`]/g, '')
}

export function findQueueClaims(source, options) {
  const haystack = stripComments(source, options).toLowerCase()
  return QUEUE_CLAIMS.filter((phrase) => haystack.includes(phrase))
}

for (const file of GUARDED_FILES) {
  test(`${file} makes no queue-and-approve claim`, () => {
    const hits = findQueueClaims(readFileSync(resolve(repoRoot, file), 'utf8'), {
      markdown: file.endsWith('.md'),
    })
    assert.deepEqual(
      hits,
      [],
      `queue-and-approve phrasing is back in ${file}: ${JSON.stringify(hits)} — ` +
        'no live rail queues a payment; an out-of-policy payment is declined ' +
        'before any money moves (#2100/#2101, epic #1440)',
    )
  })
}

// ── Positive controls ────────────────────────────────────────────────────
//
// A census that has been widened until nothing can pass, or narrowed until
// nothing can fail, reports the same green as a correct one. Both directions
// are pinned here so the zero above is evidence rather than an assumption.

test('POSITIVE CONTROL: the scanner detects every banned phrase it claims to', () => {
  for (const phrase of QUEUE_CLAIMS) {
    const fixture = `The payment ${phrase} before it settles.`
    assert.deepEqual(
      findQueueClaims(fixture),
      [phrase],
      `the census cannot detect "${phrase}" — the guard would report a vacuous pass`,
    )
  }
})

test('POSITIVE CONTROL: the scanner does not flag the corrected replacement prose', () => {
  // Sentences taken verbatim from the shipped rewrites. If a future widening of
  // QUEUE_CLAIMS starts tripping on the very prose this census exists to
  // protect, that is a guard that has stopped discriminating — catch it here
  // rather than by reverting a correct fix to make CI green.
  const corrected = [
    'A payment outside the on-chain budget is declined before any money moves; nothing is queued for a human to approve later.',
    'There is no approval queue — an over-budget redemption would revert on-chain. Ask the wallet owner to grant or raise the budget in Haven before retrying.',
    'An over-budget payment is declined before any money moves: there is no approval queue, so ask the owner to grant or raise the budget in Haven rather than waiting for an approval.',
    'spend_authority_readiness is "ready" when at least one token has remaining spend authority, "needs_approval" when the agent is active but has none.',
    'Sends the requested amount by redeeming the agent\'s on-chain budget delegation, account to recipient with no funding leg.',
  ]
  for (const sentence of corrected) {
    assert.deepEqual(
      findQueueClaims(sentence),
      [],
      `the census flags corrected prose as a queue claim: ${sentence}`,
    )
  }
})

test('POSITIVE CONTROL: markdown headings and star-bullets are not stripped away', () => {
  // The source-file stripper blanks `# …` and `* …` lines. In a README those are
  // a heading and a bullet, so running it there would silently hide a claim.
  const md = '# Payments queued for approval\n* The payment waits for your approval.\n'
  assert.deepEqual(findQueueClaims(md, { markdown: true }).sort(), ['queued for approval', 'waits for your approval'])
  // …and the source-file mode is what makes the retained-code comments tolerable.
  assert.deepEqual(findQueueClaims(md), [])
})

test('POSITIVE CONTROL: a claim split across concatenated string literals is still caught', () => {
  // The shape a formatter actually produces. Without literal-joining this reads
  // as "...queued for the ' + 'wallet owner..." and matches nothing.
  const wrapped = [
    "  reason:",
    "    'The amount exceeds the remaining budget, so the payment is queued for the ' +",
    "    'wallet owner. Tell the user.',",
  ].join('\n')
  assert.deepEqual(findQueueClaims(wrapped), ['queued for the wallet owner'])
})

test('POSITIVE CONTROL: comment stripping does not blind the scanner to real prose', () => {
  // The stripper is what lets retained fail-closed code and its explanatory
  // comments coexist with the census. Prove it removes comments AND that a
  // banned sentence outside a comment still trips.
  const mixed = [
    '// historical note: the legacy Safe AllowanceModule rail queued for approval',
    "const message = 'This payment is waiting for approval in Haven.'",
  ].join('\n')
  assert.deepEqual(findQueueClaims(mixed), ['waiting for approval'])
})
