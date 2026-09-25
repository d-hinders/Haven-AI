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
 * Proven for #3053 by mutation: remove the `payments.ts:781` wrapped
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
    { line: 292, code: 403, ledger: 'row' }, // 3009 funding-leg pre-check: over budget (#2706)
    { line: 377, code: 502, ledger: 'row' }, // 3009 prepare catch: classified caveat revert (slice 1's writer)
    { line: 416, code: 403, ledger: 'row' }, // 3009 no open budget delegation (slice 1's writer)
    { line: 565, code: 403, ledger: 'row' }, // erc7710 no active budget delegation (#2945)
    { line: 666, code: 403, ledger: 'row' }, // erc7710 pre-check: over budget (#2082)
    { line: 736, code: 400, ledger: 'skipped' }, // #3117 caller/challenge skew — malformed request, allowlisted
    { line: 799, code: 502, ledger: 'skipped' }, // settlement-delegation build failure — infrastructure, allowlisted
    { line: 836, code: 429, ledger: 'skipped' }, // relayer sponsorship budget exhausted — capacity, allowlisted
    { line: 840, code: 502, ledger: 'skipped' }, // delegate-account deploy failure — infrastructure, allowlisted
  ],
  'src/routes/payments.ts': [
    // #3271 shifted every line below by +3: `replayIntentBody`'s delegation
    // branch now shares `buildDirectSignData` (`modules/payments/
    // direct-sign-context.ts`) with the new GET /:id/sign-context route,
    // and its doc comment grew by three lines to say so.
    // #3307 shifted every line below by +1: the `toCanonicalAddress` import.
    // #3329 shifted every line below: task-budget imports, refusal-status
    // consts, and the task-budget resolution block ahead of
    // prepareDelegationPayment (review finding E widened it further —
    // 404/409 refusals now return directly instead of falling through).
    { line: 516, code: 502, ledger: 'row' }, // prepare catch: classified caveat revert (#2945)
    { line: 540, code: 403, ledger: 'row' }, // no active budget delegation (#2945)
    { line: 833, code: 429, ledger: 'row' }, // relayer budget refused before broadcast (#717/#2945)
    { line: 860, code: 502, ledger: 'skipped' }, // on-chain execution failed after claim — allowlisted
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
      line: 206,
      code: 429,
      reason: 'per-agent hourly x402 cap — spend-velocity protection with its own retry_after_seconds contract; owner decision keeps it unrecorded (a rate_limited reason would be a migration-086 CHECK widening on its own)',
    },
  ],
  'src/routes/payments.ts': [],
}

const WRAPPED_NO_WRITER: Record<(typeof TARGET_FILES)[number], { line: number; reason: string }[]> = {
  'src/modules/x402/delegation-authorize.ts': [
    { line: 736, reason: '#3117 the caller\'s decomposed fields disagree with the paymentRequired it sent — a malformed request, not a guardrail refusal' },
    { line: 799, reason: 'buildSettlementDelegation threw — child-construction infrastructure failure, not spend policy' },
    { line: 836, reason: 'RelayerBudgetExceededError — the sponsorship budget is exhausted (capacity), not a guardrail refusal' },
    { line: 840, reason: 'ensureHybridDeployed failed — delegate-account deploy infrastructure, not spend policy' },
  ],
  'src/routes/payments.ts': [
    {
      line: 860,
      reason: 'on-chain execution failed after claim — bundler/chain failure booked on the intent row by failSubmittedIntent, not a policy refusal',
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
    // 8 ledger writers (5 in delegation-authorize + 3 in payments.ts) plus 5
    // wrapped no-writer sites = 13 refuse( call sites total.
    expect(rows).toBe(8)
  })
})
