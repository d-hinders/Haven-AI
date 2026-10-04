/**
 * The enumerating refusal census (#3053, slice 2 of epic #3056) — the guard
 * that makes "a policy refusal without a ledger write" impossible to add
 * silently in the two enumerated files.
 *
 * ## Scope (exactly two files, by the epic decision)
 *
 * - `src/modules/x402/delegation-authorize.ts`
 * - `src/routes/payments.ts`
 *
 * Explicitly OUT of scope, named so a later worker does not enumerate them
 * as residue (owner verdict on #3056, note 4): everything in
 * `modules/x402/settle.ts` — its 409/502 family (including the
 * 'Settlement state was lost — re-authorize' 502 and the #3117 stored-offer
 * mismatch 409) is STATE LOSS or
 * client-error reporting, not spend policy — and the RelayerBudgetExceeded /
 * deploy 502 family in `routes/agent-delegations.ts` (`:528` and siblings),
 * which is grant-activation infrastructure. This guard reads ONLY the two
 * files above; a policy refusal appearing in a third file is invisible here
 * by decision, and widening the scope is its own change.
 *
 * ## The predicate is the HTTP status set — NOT "carries an error_code"
 *
 * A policy refusal site is a `return { code: 403|429|502, ... }` or a
 * `reply.code(403|429|502).send(...)`. The owner's note 1 measured that an
 * `error_code`-keyed predicate sees two of its own targets (the
 * `no_delegation_for_target` 403s carry the reason only inside the ledger
 * call), so the census keys on the STATUS alone; `error_code` is not
 * inspected. Consequence: some status-set sites are policy refusals with a
 * ledger row, and some are infrastructure/capacity answers with none — the
 * ALLOWLIST below names each no-writer site with its reason, and a new
 * status-set site must either be wrapped in `refuse(...)` (the choke point
 * records it) or join that allowlist with a one-line reason.
 *
 * ## Parsing is the TypeScript compiler API, not a regex
 *
 * `reply.code(...)` chains, multi-line `{ code, body }` literals and the
 * single-line forms are all visited as AST nodes, so formatting cannot hide
 * a site. Statuses are resolved only from numeric literals: a COMPUTED
 * status (`retired.statusCode`, `agentPaymentStatusHttpCode(status)`,
 * `reply.code(code).send` in resume_state, the scheme/replay passthroughs)
 * cannot be classified, so every such passthrough is pinned by a literal
 * fragment COUNT instead (ALIAS_PINS) — a new alias site grows the count and
 * reddens until it is pinned or migrated behind refuse(). A site that hides
 * its object in a local `const` before returning is seen as UNWRAPPED (the
 * walker follows only expressions nested inside a `refuse(` argument), so
 * the indirection cannot dodge the census.
 *
 * ## Bidirectional (Daniel M4)
 *
 * BOTH directions are asserted: (a) every un-exempted policy-status site
 * sits inside a `refuse(` call, and (b) the refuse( call sites equal the
 * enumerated list exactly — removing a writer is as red as adding an
 * unwrapped refusal.
 *
 * ## Positive control
 *
 * Proven for #3053 by mutation: remove the `payments.ts:785` wrapped
 * allowlist entry AND unwrap that site's `refuse(..., null)` back to a bare
 * `reply.code(502).send(...)` → this suite reddens on both the raw-site and
 * the refuse-count direction; restoring the file returns it to green,
 * byte-identical.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const POLICY_STATUSES = new Set([403, 429, 502])

const TARGET_FILES = ['src/modules/x402/delegation-authorize.ts', 'src/routes/payments.ts'] as const

/**
 * Every refuse( call site at the guarded head, in file order:
 * `line` = 1-based line of the call, `code` = the decided HTTP status,
 * `ledger` = 'row' when the call records a ledger row, 'skipped' when the
 * ledger argument is null (an allowlisted no-writer site routed through the
 * choke point so the census sees it).
 */
const EXPECTED_REFUSE_CALLS: Record<(typeof TARGET_FILES)[number], { line: number; code: number; ledger: 'row' | 'skipped' }[]> = {
  'src/modules/x402/delegation-authorize.ts': [
    // #3329 shifted every line below: task-budget refusal-status consts,
    // the resolveTaskBudgetOrRefusal helper (now resolving the parent by
    // hash, review finding E), and the funding-leg/erc7710 task-budget
    // resolution blocks were inserted above/between these sites.
    // #3392 shifted every line below by +3: the shared replayContext now
    // carries `taskBudgetId` (two comment lines + the field).
    // #3416 shifted every line below: the one-line delegation-rail import
    // (+1), then the chain-unavailable branch in the 3009 prepare catch
    // (+8 from 379 on).
    // #3330 inserted the sub-budget refusal-status/message consts, the
    // resolveSubBudgetOrRefusal helper and the sub-budget resolution block
    // above/between these sites, shifting them progressively by +116 to +147
    // on top of #3416's shifts (the sub-budget refusals are 404/409 — never
    // census policy statuses).
    // #3500 added `taskBudgetCapRefusal` (the ONE task-budget cap writer
    // both legs and the funding revert fallback share, at 210) below
    // resolveTaskBudgetOrRefusal, then the funding leg's cap input + pre-check
    // and revert fallback, and the erc7710 pre-check — shifting every refuse(
    // site below by +71 to +93 (and the raw 429 allowlist entry by +56).
    { line: 113, code: 403, ledger: 'row' }, // #3500 task budget cap exhausted — shared by both legs' pre-checks and the funding revert fallback
    { line: 346, code: 403, ledger: 'row' }, // 3009 funding-leg pre-check: over budget (#2706)
    { line: 408, code: 503, ledger: 'skipped' }, // #3416 no bundler credential for this chain — configuration, allowlisted
    // #3609 split the 3009 prepare catch's 502 in two: the unbooked
    // prepare_failed (616, infrastructure) and the booked classified-revert
    // branch (618); with its two imports and the operator log, every site
    // shifted by +1 to +16. #3610 then added the description write on both
    // legs, shifting every site by +3 to +8 more.
    // #3617 moved both legs onto the shared budget-scope resolver
    // (modules/budget-scope): the local task/sub-budget refusal tables and
    // resolve*OrRefusal helpers were deleted and each leg's period pre-check
    // collapsed into evaluatePeriodPrecheck, shifting every site by −101 to
    // −193 (and the raw 429 allowlist entry by −151). No refuse( site was
    // added or removed.
    { line: 442, code: 502, ledger: 'skipped' }, // #3609 3009 prepare catch: not a revert (bundler/RPC) — prepare_failed, allowlisted
    { line: 444, code: 502, ledger: 'row' }, // 3009 prepare catch: classified revert (slice 1's writer) — prepare_reverted, or prepare_failed for a non-execution revert, since #3609
    { line: 477, code: 403, ledger: 'row' }, // 3009 no open budget delegation (slice 1's writer)
    { line: 650, code: 403, ledger: 'row' }, // erc7710 no active budget delegation (#2945)
    { line: 756, code: 403, ledger: 'row' }, // erc7710 pre-check: over budget (#2082)
    { line: 811, code: 400, ledger: 'skipped' }, // #3117 caller/challenge skew — malformed request, allowlisted
    { line: 880, code: 502, ledger: 'skipped' }, // settlement-delegation build failure — infrastructure, allowlisted
    { line: 918, code: 429, ledger: 'skipped' }, // relayer sponsorship budget exhausted — capacity, allowlisted
    { line: 922, code: 502, ledger: 'skipped' }, // delegate-account deploy failure — infrastructure, allowlisted
  ],
  'src/routes/payments.ts': [
    // #3531 added the recipient-history import and the `classifyRecipient`
    // helper (+46 above the create handler, with the replay-branch hunk),
    // then the pre-insert classification in the create handler (+11 more
    // below it): every site below shifts by +46 or +57.
    // #3271 shifted every line below by +3: `replayIntentBody`'s delegation
    // branch now shares `buildDirectSignData` (`modules/payments/
    // direct-sign-context.ts`) with the new GET /:id/sign-context route,
    // and its doc comment grew by three lines to say so.
    // Chronology of shifts in src/routes/payments.ts: #3307 +1 (the
    // `toCanonicalAddress` import), #3329's task-budget imports/refusal-consts/
    // resolution block, then #3031's schema restructure — the hand-rolled
    // shape rungs in the prepare handler became the request schema's (−2 on
    // the 502/403 pair) and replayIntentBody collapsed the same way (+1 on
    // the 429/skipped pair) — then #3392 shifted every line below by
    // +12/+13: `mismatch()` gained the task_budget comparison (comment +
    // widened signature + branch), the doc comment lost the stale
    // same-contract sentence, both findPaymentReplay call sites gained the
    // `taskBudgetId` line, and the second (23505-catch) site sits below the
    // first two shifts. Pins re-derived against the merged file; the
    // census re-checks them against the live source, so a wrong pin reddens
    // here, not in production. Chronology of shifts: #3416 added the one-line
    // delegation-rail import (+1) and the chain-unavailable branch inside the
    // prepare catch; #3330's sub-budget branch (the refused pair + sub_budget
    // resolution) then shifted every site below by +121, and the sites below
    // the sub_budget resolution block by +123 — the #3416 503 row (inside the
    // prepare catch) and the 502/403 pair ride the same +121.
    // #3500 added the task-budget cap pre-check (605) after the task budget
    // resolves and the transfer-cap revert fallback (708) inside the prepare
    // catch, shifting every site below by +52 to +62.
    // #3503 added two imports (+2) and the period budget pre-check (770)
    // before the UserOp is built, plus its revert fallback (811) inside the
    // prepare catch, shifting every site below by +93 to +102.
    // #3528 added the self-transfer domain import pair and the prepare
    // success response's additive self-transfer warning block, then #3560
    // REVERTED #3528 entirely — net zero shift from that round-trip, so the
    // pins below are the #3503 baseline numbers again.
    // #3494 added imports for isAccountValidationRevert/boundFailureMessage
    // and new refuse( sites inside the sign route's failure catch
    // (signature-rejected, account-validation-failed, task-budget and
    // period-budget reverts confirmed at submit, and the generic fallback) —
    // all 502, all routed through refuse(..., null): the catch already books
    // the failure on the intent row via failSubmittedIntent before
    // classifying, so none of these is a policy refusal the ledger owns.
    // Review round 1 (#3494) widened the delegation-rail import to include
    // SubmittedUserOpFailedError — net +5 above every site below.
    // #3564 reworked that same catch: the receipt-unconfirmed variant now
    // books outcome-PENDING and answers its own 502 BEFORE the terminal
    // booking (so the #3494 submission-outcome-unknown site is GONE, not
    // moved), and the typed sites below it shift by the classification
    // block's +40; the other four #3494 sites keep their relative order.
    // #3564 review round 2 hoisted `boundedFailureMessage(errorMsg)` above
    // the booking split (+6) and added the outcome-pending body's fixed
    // remedy `message` (+5) — the outcome-pending site shifts +6 and every
    // typed site below it +12; no site was added or removed.
    // #3618 rewired the authorize-time path onto the #3616 resolver: the
    // inline task-budget/sub-budget resolution, the duplicated refusal
    // tables, the link pre-check, the period 403 body and both ledger
    // `detail` objects moved into the budget-scope module — refuse( calls
    // stay in THIS file, so TARGET_FILES is unchanged. The five sites at the
    // guarded head shift up by −55 (task-cap pre-check row) and −135 (period
    // pre-check row); every site below shifts by −135.
    { line: 613, code: 403, ledger: 'row' }, // #3500 task budget cap exhausted — pre-check before the UserOp is built
    { line: 695, code: 403, ledger: 'row' }, // #3503 period budget exhausted — pre-check before the UserOp is built
    { line: 719, code: 503, ledger: 'skipped' }, // #3416 no bundler credential for this chain — configuration, allowlisted
    { line: 728, code: 403, ledger: 'row' }, // #3500 transfer-cap revert confirmed against the task budget's own spent figure
    { line: 737, code: 403, ledger: 'row' }, // #3503 period-budget revert confirmed by a fresh remaining-budget read
    // #3609 split the prepare catch's 502 in two: the unbooked
    // prepare_failed (896, infrastructure) and the booked classified-revert
    // branch (898); with the one-line import and the operator log every site
    // shifts by +1 to +22.
    { line: 761, code: 502, ledger: 'skipped' }, // #3609 prepare catch: not a revert (bundler/RPC) — prepare_failed, allowlisted
    { line: 763, code: 502, ledger: 'row' }, // prepare catch: classified revert (#2945) — prepare_reverted, or prepare_failed for a non-execution revert, since #3609
    { line: 784, code: 403, ledger: 'row' }, // no active budget delegation (#2945)
    { line: 1094, code: 429, ledger: 'row' }, // relayer budget refused before broadcast (#717/#2945)
    { line: 1139, code: 502, ledger: 'skipped' }, // #3564 receipt-unconfirmed submit — outcome-pending booking, allowlisted
    { line: 1191, code: 502, ledger: 'skipped' }, // #3494 AA24 signature rejection confirmed at submit — allowlisted
    { line: 1217, code: 502, ledger: 'skipped' }, // #3494 other AA2x account-validation failure confirmed at submit — allowlisted
    { line: 1266, code: 502, ledger: 'skipped' }, // #3494 task-budget transfer-cap revert confirmed at submit — allowlisted
    { line: 1305, code: 502, ledger: 'skipped' }, // #3494 period-budget revert confirmed at submit — allowlisted
    { line: 1359, code: 502, ledger: 'skipped' }, // on-chain execution failed after claim (including a reverted-but-landed SubmittedUserOpFailedError, review round 2) — allowlisted
  ],
}

/**
 * The allowlist: policy-status sites that are deliberately NOT ledger
 * refusals, one line of reason per entry, in two groups.
 *
 * RAW — an unwrapped bare `return { code, body }` / `reply.code(n).send(...)`
 * in the guarded files; adding another one of these reddens the raw-site
 * census until it is either refuse()-wrapped or listed here.
 *
 * WRAPPED_NO_WRITER — sites routed through `refuse(..., null)` so the census
 * sees them while recording nothing; a removed wrapper reddens the
 * refuse-call enumeration above.
 */
const RAW_ALLOWLIST: Record<(typeof TARGET_FILES)[number], { line: number; code: number; reason: string }[]> = {
  'src/modules/x402/delegation-authorize.ts': [
    {
      line: 227,
      code: 429,
      reason: 'per-agent hourly x402 cap — spend-velocity protection with its own retry_after_seconds contract; owner decision keeps it unrecorded (a rate_limited reason would be a migration-086 CHECK widening on its own)',
    },
  ],
  'src/routes/payments.ts': [],
}

const WRAPPED_NO_WRITER: Record<(typeof TARGET_FILES)[number], { line: number; reason: string }[]> = {
  'src/modules/x402/delegation-authorize.ts': [
    { line: 408, reason: '#3416 DelegationRailChainUnavailableError — this deployment has no bundler credential for the chain (configuration), not a guardrail refusal' },
    { line: 442, reason: '#3609 the funding prepare failed without a revert (bundler/RPC/transport) — prepare_failed, infrastructure, not a guardrail refusal' },
    { line: 811, reason: '#3117 the caller\'s decomposed fields disagree with the paymentRequired it sent — a malformed request, not a guardrail refusal' },
    { line: 880, reason: 'buildSettlementDelegation threw — child-construction infrastructure failure, not spend policy' },
    { line: 918, reason: 'RelayerBudgetExceededError — the sponsorship budget is exhausted (capacity), not a guardrail refusal' },
    { line: 922, reason: 'ensureHybridDeployed failed — delegate-account deploy infrastructure, not spend policy' },
  ],
  'src/routes/payments.ts': [
    {
      line: 719,
      reason: '#3416 DelegationRailChainUnavailableError — this deployment has no bundler credential for the chain (configuration), not a guardrail refusal',
    },
    {
      line: 761,
      reason: '#3609 the prepare failed without a revert (bundler/RPC/transport) — prepare_failed, infrastructure, not a guardrail refusal',
    },
    {
      line: 1139,
      reason: '#3564 the receipt-unconfirmed submit — the row is booked outcome-pending (never failed) and the submission reconciler resolves it from the chain, so the 502 is a poll instruction, not a policy refusal',
    },
    {
      line: 1191,
      reason: '#3494 AA24 signature rejection — deliberately not booked: the failed intent row is the record',
    },
    {
      line: 1217,
      reason: '#3494 other AA2x account-validation failure — deliberately not booked: the failed intent row is the record',
    },
    {
      line: 1266,
      reason: '#3494 task-budget transfer-cap revert confirmed at submit — deliberately not booked: the failed intent row is the record',
    },
    {
      line: 1305,
      reason: '#3494 period-budget revert confirmed at submit — deliberately not booked: the failed intent row is the record',
    },
    {
      line: 1359,
      reason: 'on-chain execution failed after claim (including a reverted-but-landed SubmittedUserOpFailedError, review round 2) — deliberately not booked: the failed intent row is the record',
    },
  ],
}

/**
 * Computed-status passthroughs the status predicate cannot classify, pinned
 * by literal fragment count. A new occurrence of any fragment reddens until
 * this pin is consciously updated (or the site migrates behind refuse()).
 */
const ALIAS_PINS: Record<(typeof TARGET_FILES)[number], { fragment: string; count: number; why: string }[]> = {
  'src/modules/x402/delegation-authorize.ts': [
    { fragment: 'return shapeError', count: 1, why: 'scheme-shape 400 passthrough (scheme-selection.ts owns the code)' },
    { fragment: 'return replayed', count: 3, why: 'delegationReplay passthroughs — replay.ts owns the code (200/409/201)' },
  ],
  'src/routes/payments.ts': [
    { fragment: 'retired.statusCode', count: 5, why: 'retired-rail tombstones — execution-rail.ts owns the code (410)' },
    { fragment: 'reply.code(replay.code)', count: 2, why: 'findPaymentReplay passthrough — the helper owns the code' },
    { fragment: 'reply.code(code).send', count: 1, why: 'resume_state computed status (422/409 decision at the site)' },
    { fragment: 'code: agentPaymentStatusHttpCode(status)', count: 1, why: 'statusReplay computed code inside findPaymentReplay' },
  ],
}

interface RefuseCallInfo {
  call: ts.CallExpression
  line: number
  code: number | null
  ledger: 'row' | 'skipped'
}

interface RawSiteInfo {
  line: number
  code: number
  kind: 'decided' | 'reply'
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

/** Numeric status from an expression, or null when not a numeric literal. */
function numericStatus(expr: ts.Expression | undefined): number | null {
  if (expr && ts.isNumericLiteral(expr)) return Number(expr.text)
  return null
}

/** The `code` value of a `{ code: <status>, ... }` object literal, or null. */
function decidedCode(obj: ts.ObjectLiteralExpression): number | null {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'code') {
      return numericStatus(prop.initializer)
    }
  }
  return null
}

/** `reply.code(<status>)` receiver+status from a `.send(...)` call, or null. */
function replySendStatus(sendCall: ts.CallExpression): { status: number | null } | null {
  const expr = sendCall.expression
  if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.name) || expr.name.text !== 'send') return null
  const target = expr.expression
  if (!ts.isCallExpression(target)) return null
  const codeExpr = target.expression
  if (!ts.isPropertyAccessExpression(codeExpr) || !ts.isIdentifier(codeExpr.name) || codeExpr.name.text !== 'code') return null
  const recv = codeExpr.expression
  if (!ts.isIdentifier(recv) || recv.text !== 'reply') return null
  return { status: numericStatus(target.arguments[0]) }
}

function analyze(source: ts.SourceFile): { refuseCalls: RefuseCallInfo[]; rawSites: RawSiteInfo[] } {
  const refuseCalls: RefuseCallInfo[] = []
  const rawSites: RawSiteInfo[] = []

  const insideRefuse = (node: ts.Node): boolean => {
    let cur: ts.Node = node
    while (cur.parent) {
      cur = cur.parent
      if (refuseCalls.some((r) => r.call === cur)) return true
    }
    return false
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      const name = ts.isIdentifier(expr)
        ? expr.text
        : ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)
          ? expr.name.text
          : null
      if (name === 'refuse') {
        const responseArg = node.arguments[0]
        let code: number | null = null
        if (responseArg && ts.isObjectLiteralExpression(responseArg)) {
          code = decidedCode(responseArg)
        } else if (responseArg && ts.isCallExpression(responseArg)) {
          const replyStatus = replySendStatus(responseArg)
          code = replyStatus ? replyStatus.status : null
        }
        const ledgerArg = node.arguments[1]
        const ledger = ledgerArg && ledgerArg.kind === ts.SyntaxKind.NullKeyword ? 'skipped' : 'row'
        refuseCalls.push({ call: node, line: lineOf(source, node), code, ledger })
      }
      const replyStatus = replySendStatus(node)
      if (replyStatus && replyStatus.status !== null && POLICY_STATUSES.has(replyStatus.status)) {
        if (!insideRefuse(node)) {
          rawSites.push({ line: lineOf(source, node), code: replyStatus.status, kind: 'reply' })
        }
      }
    }
    if (ts.isReturnStatement(node)) {
      const arg = node.expression
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const code = decidedCode(arg)
        if (code !== null && POLICY_STATUSES.has(code)) {
          if (!insideRefuse(arg)) {
            rawSites.push({ line: lineOf(source, arg), code, kind: 'decided' })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return { refuseCalls, rawSites }
}

describe('refusal census — every policy refusal in the enumerated files goes through refuse() (#3053)', () => {
  for (const rel of TARGET_FILES) {
    const src = readFileSync(join(BACKEND_ROOT, rel), 'utf8')
    const source = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true)
    const { refuseCalls, rawSites } = analyze(source)

    it(`${rel}: the refuse( call sites equal the enumerated list exactly (no writer removed)`, () => {
      const observed = refuseCalls
        .map((r) => ({ line: r.line, code: r.code, ledger: r.ledger }))
        .sort((a, b) => a.line - b.line)
      expect(observed).toEqual(EXPECTED_REFUSE_CALLS[rel])
    })

    it(`${rel}: every un-exempted policy-status return sits inside refuse( (raw allowlist matches exactly, one reason per entry)`, () => {
      const observed = rawSites.sort((a, b) => a.line - b.line)
      const allowed = RAW_ALLOWLIST[rel].map(({ line, code }) => ({ line, code })).sort((a, b) => a.line - b.line)
      expect(observed.map(({ line, code }) => ({ line, code }))).toEqual(allowed)
      // Every allowlist entry carries a non-empty one-line reason.
      for (const entry of RAW_ALLOWLIST[rel]) {
        expect(entry.reason.trim().length).toBeGreaterThan(10)
      }
      for (const entry of WRAPPED_NO_WRITER[rel]) {
        expect(entry.reason.trim().length).toBeGreaterThan(10)
      }
    })

    it(`${rel}: the computed-status alias passthroughs are pinned (no new alias site slips past the status predicate)`, () => {
      for (const pin of ALIAS_PINS[rel]) {
        const count = src.split(pin.fragment).length - 1
        expect(count, `alias fragment "${pin.fragment}" (${pin.why})`).toBe(pin.count)
      }
    })
  }

  it('the wrapped no-writer allowlisted sites are routed through refuse( with a null ledger (the census sees them)', () => {
    for (const rel of TARGET_FILES) {
      const src = readFileSync(join(BACKEND_ROOT, rel), 'utf8')
      const source = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true)
      const { refuseCalls } = analyze(source)
      const skipped = refuseCalls.filter((r) => r.ledger === 'skipped').map((r) => r.line)
      for (const entry of WRAPPED_NO_WRITER[rel]) {
        expect(skipped, `${rel}:${entry.line} is allowlisted and must go through refuse(..., null)`).toContain(entry.line)
      }
    }
  })

  it('every ledger-recording refuse( call records exactly once — the total writer count across both files', () => {
    let rows = 0
    for (const rel of TARGET_FILES) {
      const src = readFileSync(join(BACKEND_ROOT, rel), 'utf8')
      const source = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true)
      rows += analyze(source).refuseCalls.filter((r) => r.ledger === 'row').length
    }
    // 13 ledger writers (6 in delegation-authorize + 7 in payments.ts; #3500
    // added three, #3503 two) plus 14 no-writer sites (6 + 8: #3416, the
    // #3494/#3564 sign-failure answers and #3609's two prepare_failed
    // branches among them) = 27 refuse( call sites total.
    expect(rows).toBe(13)
  })
})
