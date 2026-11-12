/**
 * The enumerating refusal census (#3053, slice 2 of epic #3056) — the guard
 * that makes "a policy refusal without a ledger write" impossible to add
 * silently in the two enumerated files.
 *
 * ## Scope (four files: the epic's two, plus the two moved payment flows)
 *
 * - `src/modules/x402/delegation-authorize.ts`
 * - `src/routes/payments.ts`
 * - `src/modules/payments/create-payment.ts`
 * - `src/modules/payments/sign-payment.ts`
 *
 * #4760 (epic #4759 slice 1) moved the `POST /payments` create flow out of
 * `routes/payments.ts` into `modules/payments/create-payment.ts`, verbatim.
 * The census follows the code: the create flow's six ledger writers and two
 * no-writer sites are enumerated against the new file, and the route keeps
 * the sign route's seven. Leaving the new file out would have made every
 * create-flow refusal invisible to this guard — the exact silent gap the
 * census exists to close.
 *
 * #4761 (slice 2) moved the `POST /payments/:id/sign` submit state machine out
 * of the same route into `modules/payments/sign-payment.ts`, verbatim. The
 * census follows it the same way: the sign flow's one ledger writer (the
 * relayer-budget 429) and six no-writer answers are enumerated against the new
 * file, and `routes/payments.ts` now holds no `refuse(` site at all — it is
 * kept in the list so a refusal added back to the route is still seen.
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

const TARGET_FILES = [
  'src/modules/x402/delegation-authorize.ts',
  'src/routes/payments.ts',
  'src/modules/payments/create-payment.ts',
  'src/modules/payments/sign-payment.ts',
] as const

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
    // #4352 added the expired-only-budget branches on both legs (the shared
    // narrow expired-row read): each writes a 403 `delegation_expired` row,
    // shifting every site below the insertion point.
    // #4379 shifted every line below by +4: the three deep payments imports
    // became one five-name import through `../payments/index.js`.
    // #4458 replaced both expired-only bodies with the shared typed builder
    // (no refuse( site added or removed): the funding leg's body grew by +17
    // lines, shifting every site below it, and the erc7710 leg's by +13 more
    // below that.
    { line: 121, code: 403, ledger: 'row' }, // #3500 task budget cap exhausted — shared by both legs' pre-checks and the funding revert fallback
    { line: 353, code: 403, ledger: 'row' }, // 3009 funding-leg pre-check: over budget (#2706)
    { line: 415, code: 503, ledger: 'skipped' }, // #3416 no bundler credential for this chain — configuration, allowlisted
    // #3609 split the 3009 prepare catch's 502 in two: the unbooked
    // prepare_failed (616, infrastructure) and the booked classified-revert
    // branch (618); with its two imports and the operator log, every site
    // shifted by +1 to +16. #3610 then added the description write on both
    // legs, shifting every site by +3 to +8 more.
    // #3617 moved both legs onto the shared budget-scope resolver
    // (modules/budget-scope): the local task/sub-budget refusal tables and
    // resolve*OrRefusal helpers were deleted and each leg's period pre-check
    // collapsed into evaluatePeriodPrecheck, shifting every site by −100 to
    // −193 (and the raw 429 allowlist entry by −151). No refuse( site was
    // added or removed.
    { line: 449, code: 502, ledger: 'skipped' }, // #3609 3009 prepare catch: not a revert (bundler/RPC) — prepare_failed, allowlisted
    { line: 451, code: 502, ledger: 'row' }, // 3009 prepare catch: classified revert (slice 1's writer) — prepare_reverted, or prepare_failed for a non-execution revert, since #3609
    { line: 478, code: 403, ledger: 'row' }, // #4352 3009 expired-only budget: delegation_expired with the end date (decision unchanged, same 403)
    { line: 534, code: 403, ledger: 'row' }, // 3009 no open budget delegation (slice 1's writer)
    { line: 711, code: 403, ledger: 'row' }, // #4352 erc7710 expired-only budget: delegation_expired with the end date (decision unchanged, same 403)
    { line: 749, code: 403, ledger: 'row' }, // erc7710 no active budget delegation (#2945)
    { line: 855, code: 403, ledger: 'row' }, // erc7710 pre-check: over budget (#2082)
    { line: 910, code: 400, ledger: 'skipped' }, // #3117 caller/challenge skew — malformed request, allowlisted
    { line: 979, code: 502, ledger: 'skipped' }, // settlement-delegation build failure — infrastructure, allowlisted
    { line: 1017, code: 429, ledger: 'skipped' }, // relayer sponsorship budget exhausted — capacity, allowlisted
    { line: 1021, code: 502, ledger: 'skipped' }, // delegate-account deploy failure — infrastructure, allowlisted
  ],
  'src/routes/payments.ts': [
    // #4760 (epic #4759 slice 1) moved the `POST /payments` create flow — and
    // with it six ledger writers and two no-writer sites — into
    // `modules/payments/create-payment.ts`. #4761 (slice 2) then moved the
    // `POST /payments/:id/sign` submit state machine — one ledger writer (the
    // relayer-budget 429) and six allowlisted no-writer answers — into
    // `modules/payments/sign-payment.ts`. The route holds no `refuse(` site
    // now; it stays in TARGET_FILES so a refusal added back here is still
    // seen. The chronology below is kept for the sites that stayed; the
    // create-flow pins live under the new file.
    // #3494 added the sign route's typed 502 sites (signature-rejected,
    // account-validation-failed, task-budget and period-budget reverts
    // confirmed at submit, and the generic fallback) — all routed through
    // refuse(..., null): the catch already books the failure on the intent
    // row via failSubmittedIntent before classifying, so none of these is a
    // policy refusal the ledger owns.
    // #3564 reworked that catch: the receipt-unconfirmed variant books
    // outcome-PENDING and answers its own 502 BEFORE the terminal booking.
    // #3837 added the sponsored-gas recording blocks; #4533 the accounting
    // feed. Neither is a refusal.
  ],
  'src/modules/payments/sign-payment.ts': [
    // #4761: the sign flow, moved verbatim out of routes/payments.ts. One
    // ledger writer and six allowlisted no-writer sites, in the order the
    // state machine decides them.
    { line: 360, code: 429, ledger: 'row' }, // relayer budget refused before broadcast (#717/#2945)
    { line: 429, code: 502, ledger: 'skipped' }, // #3564 receipt-unconfirmed submit — outcome-pending booking, allowlisted
    { line: 481, code: 502, ledger: 'skipped' }, // #3494 AA24 signature rejection confirmed at submit — allowlisted
    { line: 507, code: 502, ledger: 'skipped' }, // #3494 other AA2x account-validation failure confirmed at submit — allowlisted
    { line: 556, code: 502, ledger: 'skipped' }, // #3494 task-budget transfer-cap revert confirmed at submit — allowlisted
    { line: 595, code: 502, ledger: 'skipped' }, // #3494 period-budget revert confirmed at submit — allowlisted
    { line: 649, code: 502, ledger: 'skipped' }, // on-chain execution failed after claim (including a reverted-but-landed SubmittedUserOpFailedError, review round 2) — allowlisted
  ],
  'src/modules/payments/create-payment.ts': [
    // #4760: the create flow, moved verbatim out of routes/payments.ts. Six
    // ledger writers and two allowlisted no-writer sites, in the order the
    // flow decides them.
    { line: 557, code: 403, ledger: 'row' }, // #3500 task budget cap exhausted — pre-check before the UserOp is built
    { line: 639, code: 403, ledger: 'row' }, // #3503 period budget exhausted — pre-check before the UserOp is built
    { line: 663, code: 503, ledger: 'skipped' }, // #3416 no bundler credential for this chain — configuration, allowlisted
    { line: 672, code: 403, ledger: 'row' }, // #3500 transfer-cap revert confirmed against the task budget's own spent figure
    { line: 681, code: 403, ledger: 'row' }, // #3503 period-budget revert confirmed by a fresh remaining-budget read
    { line: 705, code: 502, ledger: 'skipped' }, // #3609 prepare catch: not a revert (bundler/RPC) — prepare_failed, allowlisted
    { line: 707, code: 502, ledger: 'row' }, // prepare catch: classified revert (#2945) — prepare_reverted, or prepare_failed for a non-execution revert, since #3609
    { line: 728, code: 403, ledger: 'row' }, // no active budget delegation (#2945)
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
      line: 234,
      code: 429,
      reason: 'per-agent hourly x402 cap — spend-velocity protection with its own retry_after_seconds contract; owner decision keeps it unrecorded (a rate_limited reason would be a migration-086 CHECK widening on its own)',
    },
  ],
  'src/routes/payments.ts': [],
  'src/modules/payments/create-payment.ts': [],
  'src/modules/payments/sign-payment.ts': [],
}

const WRAPPED_NO_WRITER: Record<(typeof TARGET_FILES)[number], { line: number; reason: string }[]> = {
  'src/modules/x402/delegation-authorize.ts': [
    { line: 415, reason: '#3416 DelegationRailChainUnavailableError — this deployment has no bundler credential for the chain (configuration), not a guardrail refusal' },
    { line: 449, reason: '#3609 the funding prepare failed without a revert (bundler/RPC/transport) — prepare_failed, infrastructure, not a guardrail refusal' },
    { line: 910, reason: '#3117 the caller\'s decomposed fields disagree with the paymentRequired it sent — a malformed request, not a guardrail refusal' },
    { line: 979, reason: 'buildSettlementDelegation threw — child-construction infrastructure failure, not spend policy' },
    { line: 1017, reason: 'RelayerBudgetExceededError — the sponsorship budget is exhausted (capacity), not a guardrail refusal' },
    { line: 1021, reason: 'ensureHybridDeployed failed — delegate-account deploy infrastructure, not spend policy' },
  ],
  'src/routes/payments.ts': [],
  'src/modules/payments/create-payment.ts': [
    {
      line: 663,
      reason: '#3416 DelegationRailChainUnavailableError — this deployment has no bundler credential for the chain (configuration), not a guardrail refusal',
    },
    {
      line: 705,
      reason: '#3609 the prepare failed without a revert (bundler/RPC/transport) — prepare_failed, infrastructure, not a guardrail refusal',
    },
  ],
  'src/modules/payments/sign-payment.ts': [
    {
      line: 429,
      reason: '#3564 the receipt-unconfirmed submit — the row is booked outcome-pending (never failed) and the submission reconciler resolves it from the chain, so the 502 is a poll instruction, not a policy refusal',
    },
    {
      line: 481,
      reason: '#3494 AA24 signature rejection — deliberately not booked: the failed intent row is the record',
    },
    {
      line: 507,
      reason: '#3494 other AA2x account-validation failure — deliberately not booked: the failed intent row is the record',
    },
    {
      line: 556,
      reason: '#3494 task-budget transfer-cap revert confirmed at submit — deliberately not booked: the failed intent row is the record',
    },
    {
      line: 595,
      reason: '#3494 period-budget revert confirmed at submit — deliberately not booked: the failed intent row is the record',
    },
    {
      line: 649,
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
    { fragment: 'reply.code(code).send', count: 1, why: 'resume_state computed status (422/409 decision at the site)' },
  ],
  'src/modules/payments/sign-payment.ts': [
    { fragment: 'retired.statusCode', count: 3, why: 'retired-rail tombstones — execution-rail.ts owns the code (410)' },
  ],
  'src/modules/payments/create-payment.ts': [
    { fragment: 'retired.statusCode', count: 2, why: 'retired-rail tombstones — execution-rail.ts owns the code (410)' },
    { fragment: 'code: agentPaymentStatusHttpCode(status)', count: 1, why: 'statusReplay computed code inside findPaymentReplay' },
    { fragment: 'return replay', count: 2, why: 'findPaymentReplay passthrough — the helper owns the code (201/409/status)' },
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

/**
 * `decided(<status>, <body>)` — the reply-free decided-response helper the
 * moved payment modules use (#4760/#4761). It is the same `{ code, body }`
 * pair a `reply.code(n).send(body)` chain produces, so the census must read
 * its status the same way; otherwise every refusal in those files would be
 * classified `null` and the status predicate would go blind exactly where the
 * money-path code now lives.
 */
function decidedHelperStatus(call: ts.CallExpression): number | null {
  const expr = call.expression
  if (!ts.isIdentifier(expr) || expr.text !== 'decided') return null
  return numericStatus(call.arguments[0])
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
          code = replyStatus ? replyStatus.status : decidedHelperStatus(responseArg)
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
      } else if (arg && ts.isCallExpression(arg)) {
        // The reply-free `decided(<status>, …)` form: an unwrapped policy
        // status returned this way is exactly as invisible as a bare
        // `reply.code(n).send(...)`, so it joins the raw-site census.
        const code = decidedHelperStatus(arg)
        if (code !== null && POLICY_STATUSES.has(code) && !insideRefuse(arg)) {
          rawSites.push({ line: lineOf(source, arg), code, kind: 'decided' })
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
    // 15 ledger writers (8 in delegation-authorize + 6 in create-payment.ts
    // + 1 in sign-payment.ts; #3500 added three, #3503 two, #4352 the two
    // expired-only-budget rows) plus 14 no-writer sites (6 + 2 + 6: #3416,
    // the #3494/#3564 sign-failure answers and #3609's two prepare_failed
    // branches among them) = 29 refuse( call sites total. #4761 moved the
    // route's one writer and six no-writer sites into sign-payment.ts; the
    // totals are unchanged by the move.
    expect(rows).toBe(15)
  })
})
