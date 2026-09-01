import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bannedModuleRefs, parseImportFacts, type ImportFacts } from './helpers/import-facts.js'

/**
 * **Nothing routes to the retired Safe/AllowanceModule rail** — the closing
 * structural guard of epic #1440 (#1993, build-order slice 10).
 *
 * The epic deleted the rail across nine slices: #1984 closed the inflow,
 * #1986 made every agent-payment entry point answer 410, #1987/#1988 deleted
 * the backend machinery, #1989 the frontend surfaces, #2020 the
 * `agent_allowances` surface, #2024/#2064 the last two tables. What none of
 * those slices left behind is a reason the rail cannot quietly grow back: a
 * re-added import, a re-registered route, a re-widened union at the seam. That
 * is this file.
 *
 * ## Design — extends #2049's extractor, does not duplicate it
 *
 * The rules below read `parseImportFacts()` (now shared, in
 * `./helpers/import-facts.ts`), the TypeScript-parser extractor #2049 built for
 * Red Line #4 after measuring that a regex missed eight import shapes. #1993
 * needed the same reading over a wider file set and two facts the original did
 * not collect (mounted route prefixes, rail-union literals), so the extractor
 * moved into a shared helper and grew two buckets rather than being copied.
 * Both suites now prove it together — a second, drifting AST reader is the
 * failure mode both files exist to prevent.
 *
 * ## The rule that governs this file
 *
 * **A guard whose reach you cannot demonstrate is not a guard.** #2049 shipped
 * five rules and its reviewer found that two of them passed VACUOUSLY: their
 * buckets were ones the real production file never fills, so if the extractor
 * had silently stopped collecting them, both rules would have stayed green
 * forever. Today's tree saying NO is not evidence a detector can say YES.
 *
 * So every rule here carries **its own fixture-based positive control**,
 * proving the detector reports that rule's violation on a synthetic input —
 * and separately a **negative control** proving a clean, delegation-rail-shaped
 * fixture trips NO rule, so a guard widened until everything fails is caught
 * too. Each rule has also been mutation-proven separately against the real
 * tree (one mutation per rule; see the PR).
 *
 * ## ⚠️ What this guard CANNOT see
 *
 * Enumerated here, in the assertion's own file, and not only in a doc — the
 * precedent #2050 and #2058 set deliberately, so a green run cannot be
 * over-read:
 *
 * 1. **Transitive reach.** Every rule reads ONE file at a time. A permitted
 *    module that itself imports retired machinery and re-exposes it is
 *    invisible. Rule 2 is backend-wide precisely to narrow this — a resurrected
 *    symbol has to be bound SOMEWHERE — but a symbol re-implemented under a new
 *    name inside a permitted module is not covered.
 * 2. **Behaviour.** Nothing here executes a request. That the retired rail
 *    actually answers 410 is `routes/__tests__/allowance-rail-retired.test.ts`
 *    and the #1986 cases in `non-custody-onchain-gate.contract.test.ts`; this
 *    file proves only that no code path CAN be constructed, not what runs.
 * 3. **Re-implementation in place.** Legacy allowance arithmetic rewritten
 *    inline, importing nothing, is invisible to every import-shaped rule.
 * 4. **`eval` / `new Function` indirection.** Rule 3 catches a computed
 *    `import()` by refusing it outright, but not a module name assembled and
 *    eval'd.
 * 5. **Non-backend packages.** The frontend, SDK, MCP and QA packages are not
 *    read here. The frontend's own regression assertions (#1989) carry that
 *    half; nothing structural spans both.
 * 6. **Routes mounted anywhere but `index.ts`.** Rule 4 reads the one registry
 *    file. A plugin that registers a sub-route internally is not seen.
 * 7. **The database.** A row still marked `execution_rail='allowance_module'`
 *    is *expected* — the epic keeps `user_safes` rows readable. This guard says
 *    nothing about data, only about reachable code.
 * 8. **A non-literal route prefix.** Rule 4 sees `{ prefix: '/x' }` written
 *    inline with a string literal — the only shape `index.ts` uses today.
 *    `app.register(routes, someConfigObject)`, or a template-literal prefix,
 *    binds no literal it can read. Named because it is invisible, not because
 *    it is likely.
 * 9. **`/safe` stays mounted on purpose.** `safe-deploy.ts` is a 410 tombstone
 *    and `safe-exec.ts` is deliberately LIVE (passkey approver management,
 *    #1229). Rule 4 therefore bans `/approvals` and not `/safe` — a prefix ban
 *    is a claim about a DELETED surface, not about the word "safe".
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BACKEND_SRC = join(HERE, '..', '..')

/**
 * Modules the epic DELETED. Referencing one again is a resurrection, wherever
 * it happens — so rule 1 scans every non-test backend source file rather than
 * a curated list. Paths are repo-relative-from-`src` and matched
 * suffix-wise, so the relative depth of the importer does not matter.
 */
const DELETED_RAIL_MODULES = [
  'domain/payment-coverage', // #1987
  'rails/allowance-nonce-coordinator', // #1987
  'infra/repositories/allowance-nonce-watermarks', // #1987
  'modules/mpp/authorize', // #1987
  'modules/x402/legacy-authorize', // #1987
  'modules/accounts/safe-deployer', // #1988
  'modules/accounts/safe-owner-tx', // #1988
  'infra/repositories/approval-requests', // #2055
  'routes/approvals', // #2055
  'loop-harness/reference-allowance-module', // #2020
] as const

/**
 * The retired rail's execution and approval-queue symbols. All deleted; kept
 * as tombstones so a re-created symbol lands on a guard rather than on
 * nothing.
 *
 * Deliberately NOT listed: `getTokenAllowance`, `getTokenBalance`,
 * `getProvider`, `getRelayerWallet`, `getTokensForDelegate`. Those survive on
 * `rails/allowance-module.ts` and are LIVE — shared chain infrastructure plus
 * the legacy wallet-approval read behind `agent-connection-setups.ts`. Banning
 * them backend-wide would be a guard that fails on correct code, which teaches
 * people to edit the guard. Rule 3 keeps them off the payment ENTRY POINTS,
 * which is the claim that actually matters.
 */
const RETIRED_RAIL_SYMBOLS = [
  'executeAllowanceTransfer',
  'generateTransferHash',
  'recoverSigner',
  'decideCoverage',
  'computeEffectiveAllowance',
  'getLatestBlockTimeSec',
  'hasTokenAllowanceConfigured',
  'readSharedWatermark',
  'waitForFreshAllowanceNonce',
  'nextAllowanceNonce',
  'insertPaymentApproval',
  'insertSendApproval',
  'insertMachineApproval',
  'applyApproverChange',
] as const

/**
 * The live agent-payment ENTRY POINTS — every route an agent's spend request
 * can enter through. Rule 3 holds these to a stricter module ban than the rest
 * of the backend: they may not name the SURVIVING `rails/allowance-module`
 * either, in any literal, static or runtime.
 */
const PAYMENT_ENTRY_POINTS = [
  'routes/payments.ts',
  'routes/x402.ts',
  'routes/machine-payments.ts',
  'routes/agent-delegations.ts',
] as const

/** Rule 3's ban: everything deleted, PLUS the reads-only survivor. */
const ENTRY_POINT_BANNED_MODULES = [
  ...DELETED_RAIL_MODULES,
  'rails/allowance-module',
] as const

/** Route prefixes the epic deregistered. See limit 8 above for what is NOT here. */
const RETIRED_ROUTE_PREFIXES = ['/approvals'] as const

/**
 * The only answers `resolveExecutionRail` may give. `allowance_module` is
 * absent BY CONSTRUCTION since #1986 — re-adding it is how the rail grows back
 * at the seam, and no import-shaped rule can see that.
 */
const ALLOWED_RAIL_DECISIONS = ['delegation', 'retired_session', 'retired_allowance'] as const

// ── file collection ─────────────────────────────────────────────────────────

function backendSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full)
    }
  }
  walk(BACKEND_SRC)
  return out
}

const factsCache = new Map<string, ImportFacts>()
function factsFor(absPath: string): ImportFacts {
  const cached = factsCache.get(absPath)
  if (cached) return cached
  const parsed = parseImportFacts(readFileSync(absPath, 'utf8'), absPath)
  factsCache.set(absPath, parsed)
  return parsed
}

const rel = (abs: string) => relative(BACKEND_SRC, abs).split('\\').join('/')

/**
 * Parse the whole non-test backend tree ONCE. Rules 1 and 2 both scan it, and
 * a full TypeScript parse of ~300 files is seconds, not milliseconds — hence
 * the explicit timeouts on the two tests that trigger it rather than a silent
 * dependence on vitest's 5s default.
 */
let scanned: { path: string; facts: ImportFacts }[] | null = null
function backendScan(): { path: string; facts: ImportFacts }[] {
  if (!scanned) scanned = backendSourceFiles().map((path) => ({ path, facts: factsFor(path) }))
  return scanned
}

const SCAN_TIMEOUT_MS = 120_000

// ── the guard ───────────────────────────────────────────────────────────────

describe('safe-retirement (#1993): nothing routes to the retired AllowanceModule rail', () => {
  // ── REACH CONTROL ─────────────────────────────────────────────────────────
  //
  // Before any "no violations" result is allowed to mean anything, prove the
  // scan actually READ a substantial tree and parsed it into non-empty facts.
  // A collector that silently returned [] would otherwise report a perfect,
  // empty, meaningless pass — the #2049 defect one layer down.

  it('REACH CONTROL: the scan reads the real backend tree and every pinned entry point exists', () => {
    const files = backendScan()
    expect(files.length, 'backend source scan collected almost nothing').toBeGreaterThan(100)
    expect(
      files.filter((f) => f.facts.staticModuleRefs.size > 0).length,
      'the scan parsed files but extracted no imports from any of them',
    ).toBeGreaterThan(100)

    // Every pinned entry point resolves and parses to a real import surface.
    for (const entry of PAYMENT_ENTRY_POINTS) {
      const facts = factsFor(join(BACKEND_SRC, entry))
      expect(facts.bindings.size, `${entry} parsed to no import bindings`).toBeGreaterThan(5)
      expect(facts.codeStringLiterals.size, `${entry} parsed to no string literals`).toBeGreaterThan(5)
    }

    // The two files the single-file rules read are real and non-trivial.
    expect(factsFor(join(BACKEND_SRC, 'index.ts')).registeredPrefixes.size).toBeGreaterThan(10)
    expect(factsFor(join(BACKEND_SRC, 'rails/execution-rail.ts')).railDecisionLiterals.size)
      .toBeGreaterThan(0)
  }, SCAN_TIMEOUT_MS)

  // ── RULE 1 ────────────────────────────────────────────────────────────────

  it('RULE 1 — no backend source file references a DELETED retired-rail module, statically OR at runtime', () => {
    // Reads `codeStringLiterals`, not `staticModuleRefs`.
    //
    // The narrower version shipped first and haven-reviewer broke it with a
    // measurement rather than an argument: adding
    // `await import('../../domain/payment-coverage.js')` to
    // `modules/accounts/mainnet-gate.ts` — a real backend file that is not one
    // of the five pinned entry points — passed all twelve tests. Rule 3 would
    // have caught the same edit on an entry point; nothing caught it anywhere
    // else. `codeStringLiterals` is a superset of every static specifier, so
    // widening loses no coverage and closes `import()`, `require()` and any
    // other literal-specifier shape in one move.
    const offenders: string[] = []
    for (const { path, facts } of backendScan()) {
      for (const hit of bannedModuleRefs(facts.codeStringLiterals, DELETED_RAIL_MODULES)) {
        offenders.push(`${rel(path)} → ${hit}`)
      }
    }
    expect(offenders, 'a module epic #1440 deleted has been referenced again').toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('RULE 1 — positive control: the detector reports a resurrected module in every literal shape', () => {
    const facts = parseImportFacts(
      [
        `import { decideCoverage } from '../domain/payment-coverage.js'`,
        `export * from '../../routes/approvals.js'`,
        `import '../infra/repositories/approval-requests.js?bust=1'`,
        // the runtime shapes the narrower first version missed, backend-wide:
        `const dyn = await import('../rails/allowance-nonce-coordinator.js')`,
        `const cjs = createRequire(import.meta.url)('../modules/mpp/authorize.js')`,
      ].join('\n'),
    )
    expect(bannedModuleRefs(facts.codeStringLiterals, DELETED_RAIL_MODULES).sort()).toEqual([
      '../../routes/approvals.js',
      '../domain/payment-coverage.js',
      '../infra/repositories/approval-requests.js?bust=1',
      '../modules/mpp/authorize.js',
      '../rails/allowance-nonce-coordinator.js',
    ])
    // …and the static bucket alone would have seen only three of the five —
    // the finding that widened this rule, pinned so it cannot silently narrow.
    expect(bannedModuleRefs(facts.staticModuleRefs, DELETED_RAIL_MODULES)).toHaveLength(3)
  })

  // ── RULE 2 ────────────────────────────────────────────────────────────────

  it('RULE 2 — no backend source file binds or re-exports a retired-rail execution symbol', () => {
    const offenders: string[] = []
    for (const { path, facts } of backendScan()) {
      for (const symbol of RETIRED_RAIL_SYMBOLS) {
        if (facts.bindings.has(symbol)) offenders.push(`${rel(path)} binds ${symbol}`)
        if (facts.reexports.has(symbol)) offenders.push(`${rel(path)} re-exports ${symbol}`)
      }
    }
    expect(offenders, 'a retired-rail execution symbol is reachable again').toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('RULE 2 — positive control: the detector reports a bound and a re-exported symbol', () => {
    const facts = parseImportFacts(
      [
        `import { executeAllowanceTransfer } from './anywhere.js'`,
        `import { somethingElse as insertPaymentApproval } from './anywhere.js'`,
        `export { applyApproverChange } from './anywhere.js'`,
        `// prose naming nextAllowanceNonce must NOT count — comments are not nodes`,
      ].join('\n'),
    )
    // bound directly, and bound under an alias (both sides of a named clause)
    expect(facts.bindings.has('executeAllowanceTransfer')).toBe(true)
    expect(facts.bindings.has('insertPaymentApproval')).toBe(true)
    // re-exported without binding anything locally — invisible to `bindings`
    expect(facts.reexports.has('applyApproverChange')).toBe(true)
    expect(facts.bindings.has('applyApproverChange')).toBe(false)
    // and the comment did not leak into any bucket
    expect(facts.bindings.has('nextAllowanceNonce')).toBe(false)
    expect(facts.reexports.has('nextAllowanceNonce')).toBe(false)
  })

  // ── RULE 3 ────────────────────────────────────────────────────────────────

  it('RULE 3 — no payment ENTRY POINT names a retired-rail module in any literal, or uses a computed import()', () => {
    const offenders: string[] = []
    for (const entry of PAYMENT_ENTRY_POINTS) {
      const facts = factsFor(join(BACKEND_SRC, entry))
      // codeStringLiterals is a superset of every static specifier, so this one
      // rule covers `import`, `export … from`, side-effect imports, dynamic
      // `import('…')` and `createRequire(…)('…')` without enumerating them.
      for (const hit of bannedModuleRefs(facts.codeStringLiterals, ENTRY_POINT_BANNED_MODULES)) {
        offenders.push(`${entry} names ${hit}`)
      }
      if (facts.unresolvableDynamicImports > 0) {
        offenders.push(`${entry} uses ${facts.unresolvableDynamicImports} computed dynamic import()`)
      }
    }
    expect(
      offenders,
      'a payment entry point can reach the retired rail — including via the reads-only survivor',
    ).toEqual([])
  })

  it('RULE 3 — positive control: the detector reports a runtime reach and a computed specifier', () => {
    const facts = parseImportFacts(
      [
        `const AM = await import('../rails/allowance-module.js')`,
        `const req = createRequire(import.meta.url)`,
        `const legacy = req('../modules/x402/legacy-authorize.js')`,
        `const computed = await import('../rails/' + name)`,
      ].join('\n'),
    )
    expect(bannedModuleRefs(facts.codeStringLiterals, ENTRY_POINT_BANNED_MODULES).sort()).toEqual([
      '../modules/x402/legacy-authorize.js',
      '../rails/allowance-module.js',
    ])
    expect(facts.unresolvableDynamicImports).toBe(1)
  })

  // ── RULE 4 ────────────────────────────────────────────────────────────────

  it('RULE 4 — the route registry mounts no retired route prefix', () => {
    const mounted = factsFor(join(BACKEND_SRC, 'index.ts')).registeredPrefixes
    const offenders = RETIRED_ROUTE_PREFIXES.filter((p) => mounted.has(p))
    expect(offenders, 'a route surface epic #1440 deregistered has been mounted again').toEqual([])

    // …and prove the same read SEES the prefixes that are supposed to be there,
    // so "no retired prefix" is not the answer of a reader that saw nothing.
    expect(mounted.has('/payments')).toBe(true)
    expect(mounted.has('/agents')).toBe(true)
  })

  it('RULE 4 — positive control: the detector reports a re-registered retired prefix, and ignores prose', () => {
    const facts = parseImportFacts(
      [
        `// #2055: /approvals is deregistered — this comment must stay green`,
        `await app.register(paymentRoutes, { prefix: '/payments' })`,
        `await app.register(approvalRoutes, { prefix: '/approvals' })`,
      ].join('\n'),
    )
    expect([...facts.registeredPrefixes].sort()).toEqual(['/approvals', '/payments'])
    expect(RETIRED_ROUTE_PREFIXES.filter((p) => facts.registeredPrefixes.has(p))).toEqual([
      '/approvals',
    ])
  })

  // ── RULE 5 ────────────────────────────────────────────────────────────────

  it('RULE 5 — the rail seam offers no LIVE allowance-module answer', () => {
    const literals = factsFor(join(BACKEND_SRC, 'rails/execution-rail.ts')).railDecisionLiterals
    // Exactly the three #1986 left. Written as an equality, not a "does not
    // include 'allowance_module'": a re-widening could just as easily spell the
    // live answer `legacy` or `safe`, and a denylist of one string would miss it.
    expect(
      [...literals].sort(),
      'the ExecutionRailDecision union changed shape — a new answer must be reviewed, not absorbed',
    ).toEqual([...ALLOWED_RAIL_DECISIONS].sort())
  })

  it('RULE 5 — positive control: the detector reports a re-widened union', () => {
    const facts = parseImportFacts(
      [
        `export type ExecutionRailDecision =`,
        `  | { rail: 'delegation' }`,
        `  | { rail: 'retired_session' }`,
        `  | { rail: 'retired_allowance' }`,
        `  | { rail: 'allowance_module' }`,
      ].join('\n'),
    )
    expect([...facts.railDecisionLiterals].sort()).toEqual([
      'allowance_module',
      'delegation',
      'retired_allowance',
      'retired_session',
    ])
    expect([...facts.railDecisionLiterals].sort()).not.toEqual([...ALLOWED_RAIL_DECISIONS].sort())
  })

  // ── NEGATIVE CONTROL ──────────────────────────────────────────────────────

  it('NEGATIVE CONTROL: an ordinary delegation-rail file trips NO rule', () => {
    // The twin of the five positive controls. They prove each detector CAN say
    // yes; this proves none of them says yes to everything. A guard widened
    // until correct code fails is not a stricter guard — it is a guard people
    // learn to edit instead of obeying.
    const facts = parseImportFacts(
      [
        `import { prepareDelegationPayment } from '../rails/delegation-authorization.js'`,
        `import { getTokenAllowance } from '../rails/allowance-module.js'`, // live: reads-only survivor
        `import * as chains from '../domain/chains.js'`,
        `export { resolveExecutionRail } from '../rails/execution-rail.js'`,
        `await app.register(agentDelegationRoutes, { prefix: '/agents' })`,
        `const mod = await import('../modules/x402/index.js')`,
        `type Decision = { rail: 'delegation' } | { rail: 'retired_allowance' }`,
        `// executeAllowanceTransfer and /approvals named in prose only`,
      ].join('\n'),
    )

    expect(bannedModuleRefs(facts.codeStringLiterals, DELETED_RAIL_MODULES)).toEqual([]) // rule 1
    for (const symbol of RETIRED_RAIL_SYMBOLS) {
      expect(facts.bindings.has(symbol), `rule 2 over-read on ${symbol}`).toBe(false)
      expect(facts.reexports.has(symbol), `rule 2 over-read on ${symbol}`).toBe(false)
    }
    expect(facts.unresolvableDynamicImports).toBe(0) // rule 3
    expect(RETIRED_ROUTE_PREFIXES.filter((p) => facts.registeredPrefixes.has(p))).toEqual([]) // rule 4
    expect([...facts.railDecisionLiterals].every((l) =>
      (ALLOWED_RAIL_DECISIONS as readonly string[]).includes(l),
    )).toBe(true) // rule 5

    // The one deliberate asymmetry, stated so it cannot be mistaken for a gap:
    // rule 3's ENTRY-POINT ban DOES catch the surviving reads-only module — the
    // same import that is correct in `agent-connection-setups.ts` is a finding
    // on `routes/payments.ts`, and that is the point.
    expect(bannedModuleRefs(facts.staticModuleRefs, ENTRY_POINT_BANNED_MODULES)).toEqual([
      '../rails/allowance-module.js',
    ])
  })
})
