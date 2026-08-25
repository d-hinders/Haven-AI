import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'
import { allowanceModuleRailRetired } from '../../rails/execution-rail.js'

/**
 * On-chain-is-the-final-gate contract test (design:
 * docs/research/non-custody-verification.md; guardrail: casp-risk-guardrails.md
 * Red Line #4, "Off-Chain-Only Spend Control" + "Use On-Chain Enforcement As
 * The Final Gate").
 *
 * **Rebased onto the live delegation rail (#1986, epic #1440 slice 3), with a
 * named boundary this suite does NOT close — read this before trusting the
 * green.**
 *
 * The original suite proved the spend envelope on the legacy AllowanceModule
 * rail was the ON-CHAIN remaining (`computeEffectiveAllowance`), not Haven's
 * database — Haven's own arithmetic decided whether to queue an approval or
 * mint a signable intent, but the NUMBER that arithmetic used came from a
 * chain read. On the delegation rail there is no equivalent Haven-side
 * arithmetic at all: `routes/payments.ts`'s delegation branch never calls
 * `computeEffectiveAllowance`, `getTokenAllowance`, or `decideCoverage` — it
 * calls `prepareDelegationPayment`, which asks the bundler to estimate gas for
 * the redemption, and that estimation runs the DelegationManager's caveat
 * enforcers (budget, recipient, expiry) ON-CHAIN, in Solidity. An
 * out-of-policy payment reverts DURING THAT ESTIMATION, `prepareDelegationPayment`
 * throws, and Haven forwards the refusal — it does not, and structurally
 * cannot, second-guess it with its own remaining-balance math.
 *
 * The cases below prove the part of that claim this backend test CAN reach:
 *   - the delegation branch performs NO off-chain coverage arithmetic, ever
 *     (`computeEffectiveAllowance`/`getTokenAllowance`/`decideCoverage` are
 *     asserted not-called in every delegation-rail case, refusal or success);
 *   - a rejection from the on-chain simulation (`prepareDelegationPayment`
 *     throwing, standing in for a caveat-enforcer revert) is forwarded
 *     verbatim as a refusal, with NOTHING written and no local override;
 *   - only an on-chain ACCEPTANCE (`prepareDelegationPayment` resolving)
 *     produces a signable intent — the mandatory positive control.
 *
 * **What this suite does NOT prove, and cannot from this seam: that the
 * DelegationManager's caveat enforcers themselves correctly revert an
 * over-budget/wrong-recipient/expired redemption.** That is on-chain Solidity
 * behaviour, exercised by the bundler during real gas estimation — outside a
 * backend unit test's reach by construction, since `prepareDelegationPayment`
 * is mocked here as the network seam.
 *
 * ✅ **#2004 CLOSED THAT GAP — the proof now exists, in a sibling file:**
 * `non-custody-onchain-enforcer.contract.test.ts`. It compiles a delegation
 * with Haven's real caveat compiler and `eth_call`s each DEPLOYED enforcer's
 * `beforeHook` at Haven's pinned Base Sepolia address, asserting the exact
 * on-chain revert for an over-budget, wrong-recipient and expired redemption,
 * each against an in-policy positive control on the same enforcer. Read the
 * two files together: THIS one proves Haven does no arithmetic of its own and
 * forwards the chain's verdict; THAT one proves the verdict refuses what it
 * claims to refuse. Neither is sufficient alone.
 *
 * One remainder is still open and is deliberately not claimed by either file:
 * a full `redeemDelegations` round trip proving the manager runs the whole
 * caveat stack in order needs a funded testnet delegator and a signature, i.e.
 * operator-held keys. See that file's header and the #2004 CASP shard.
 *
 * The legacy-rail cases are kept as an ADDITIONAL, STRICTLY STRONGER
 * assertion (#1986): the retired rail now refuses BEFORE any on-chain
 * allowance read runs at all, regardless of the requested amount — collapsed
 * into one parametrized case rather than the original three, since all three
 * inputs now produce the identical early refusal.
 *
 * ⚠️ **#1987 / #2044 — what the not-called spies do and do NOT prove.**
 * #1986 proved "the delegation branch performs no off-chain coverage
 * arithmetic" with `not.toHaveBeenCalled()` spies on six names from
 * `rails/allowance-module.js`. #1987 then deleted the rail's execution half,
 * and three of those six — `generateTransferHash`, `recoverSigner`,
 * `executeAllowanceTransfer` — stopped existing as exports of the real module.
 * `vi.mock(..., () => allowanceMocks)` replaces the module wholesale, so the
 * factory simply invented three functions production does not have and the
 * suite asserted they were never called: **unfalsifiable, not merely quiet** —
 * no edit to production code could turn them red, because you cannot re-add a
 * call to a function that is gone. An empty-set guard inside a regulatory
 * proof. #2044 removed all three, and the `executeAllowanceTransfer`
 * assertion with them.
 *
 * **The three that remain are mutation-proven falsifiable** (#2044), and it is
 * worth being exact about the mechanism, because #2004's inventory read it too
 * pessimistically. `routes/payments.ts` imports nothing from
 * `rails/allowance-module.js` directly — but the module IS on the route's
 * transitive graph (`routes/payments.ts` → `modules/mpp/index.ts` →
 * `modules/mpp/allowances.ts`), so the `vi.mock` is live, and re-adding a call
 * on the payment path DOES trip the spy. Measured, per name:
 *   - `computeEffectiveAllowance` — a call added after the retirement gate
 *     reddens all three delegation cases by name;
 *   - `getTokenAllowance` — a call added BEFORE the retirement gate reddens
 *     the two #1986 RETIREMENT cases too, which is what makes their claim
 *     ("refused before ANY on-chain allowance read") a real ordering
 *     assertion rather than a restatement of the 410;
 *   - `getLatestBlockTimeSec` — the block-time read that fed the legacy
 *     arithmetic; promoted into the helper by #2044 to replace the dead
 *     `generateTransferHash` slot, and reddened by the same shape of edit.
 * These three survive on the live READ path behind
 * `GET /machine-payments/allowances`, which is exactly why a re-added call is
 * a real risk and a real assertion.
 *
 * The three deleted names are still guarded — by the STRUCTURAL assertion
 * below, over the route's real import bindings, which is falsifiable by a
 * single edit (re-add the import and it goes red) and carries its own positive
 * control proving the extractor can say yes. That, not the spies, is what
 * carries the red line.
 */

const { mockQuery, allowanceMocks, fiatMocks, delegationMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  // Only names the real module still EXPORTS (#2044). A factory entry for a
  // deleted export is a spy nothing can ever call — see the header.
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeSekValue: vi.fn().mockResolvedValue(null),
  },
  delegationMocks: {
    prepareDelegationPayment: vi.fn(),
    submitDelegationPayment: vi.fn(),
  },
}))

// #2044: the `allowance-nonce-watermarks` stub that stood here mocked a module
// #1987 DELETED, so it resolved to nothing and stubbed nothing. Removed rather
// than left reading as coverage of a path that no longer exists. (The same
// stale stub survives in six sibling suites — `payments`, `machine-payments`,
// `x402`, `x402-consolidation.characterization`, `payments-session-rail` and
// `allowance-rail-retired` — tracked as #2048, not widened into this diff.)
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 84532,
  status: 'active',
}
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const USER_OP_HASH = `0x${'cd'.repeat(32)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`
const PAY = { token: 'USDC', amount: '1', to: RECIPIENT }

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]
/** `FIND_EXECUTION_RAIL_FOR_AGENT_SQL` — the account's CURRENT rail. */
const railRoute = (rail: string | null): DbRoute => [
  /LEFT JOIN user_safes/,
  () => ({ rows: [{ execution_rail: rail }] }),
]
const insertIntent = (row: Record<string, unknown>): DbRoute => [
  /INSERT INTO payment_intents/,
  () => ({ rows: [row] }),
]

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Every off-chain "how much is left" computation this suite must never see run
 * on the delegation rail — and every name here is one the real module still
 * exports, so each can be reached again by a future edit and each has been
 * mutation-proven to go red by name (#2044). `generateTransferHash` used to
 * occupy the third slot; it was deleted with the rail by #1987 and could never
 * fire again, so it is gone and `getLatestBlockTimeSec` — the block-time read
 * that fed the legacy arithmetic — takes its place.
 *
 * These are a supporting guard, not the red line's proof. The load-bearing
 * assertion is the structural import-binding check below.
 */
function expectNoOffChainCoverageArithmetic() {
  expect(allowanceMocks.computeEffectiveAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.getLatestBlockTimeSec).not.toHaveBeenCalled()
}

/**
 * The retired rail's off-chain spend arithmetic — every "how much is left"
 * name that must never be reachable from the payment route again. Three of
 * these (`computeEffectiveAllowance`, `getTokenAllowance`,
 * `getLatestBlockTimeSec`) are still live exports of
 * `rails/allowance-module.ts`, so they can be re-imported today; the other
 * seven were deleted with the rail by #1987 and are kept as tombstones so a
 * re-created symbol lands on a guard rather than on nothing.
 */
const BANNED_ARITHMETIC = [
  'computeEffectiveAllowance',
  'getTokenAllowance',
  'getLatestBlockTimeSec',
  'decideCoverage',
  'generateTransferHash',
  'recoverSigner',
  'executeAllowanceTransfer',
  'readSharedWatermark',
  'waitForFreshAllowanceNonce',
  'hasTokenAllowanceConfigured',
] as const

/**
 * The modules that hold (or held) that arithmetic. A module-level rule is what
 * catches the shapes that bind no banned NAME at all — `import * as AM from`,
 * `await import('…')`, a bare side-effect import, `export * from`.
 */
const BANNED_MODULES = [
  'rails/allowance-module',
  'domain/payment-coverage',
  'infra/repositories/allowance-nonce-watermarks',
] as const

/** Which of `specs` name a retired-rail module, extension- and prefix-agnostic. */
function bannedModuleRefs(specs: Iterable<string>): string[] {
  return [...specs].filter((s) => {
    const normalized = s.replace(/\.(m?[jt]s)$/, '')
    return BANNED_MODULES.some((b) => normalized === b || normalized.endsWith(`/${b}`))
  })
}

type PaymentPathImports = {
  /**
   * Names bound into the route's module scope by a static import clause: every
   * named specifier (BOTH its original name and its local alias), a default
   * binding, and a namespace binding's local name.
   */
  bindings: Set<string>
  /**
   * Names re-exported by name from another module (`export { x } from '…'`).
   * These bind nothing locally, so the binding rule cannot see them — but they
   * put the symbol back on the payment route's own public surface.
   */
  reexports: Set<string>
  /**
   * Module specifiers reached by a STATIC form: `import … from '…'`,
   * side-effect `import '…'`, `export … from '…'`, `export * from '…'`.
   */
  staticModuleRefs: Set<string>
  /**
   * Every string literal in the file's CODE. Comments are not AST nodes, so
   * nothing written in one can appear here — which is what makes a
   * literal-level rule safe on a file that deliberately names retired symbols
   * in prose. This is the backstop for every runtime shape: `import('…')`,
   * `createRequire(import.meta.url)('…')`, and whatever is invented next.
   */
  codeStringLiterals: Set<string>
  /**
   * Count of dynamic `import(...)` calls whose specifier is not a literal
   * (a variable, a concatenation, a template with substitutions). No static
   * analysis can resolve one, so its presence on this route IS the finding.
   */
  unresolvableDynamicImports: number
}

/**
 * The import STRUCTURE of `routes/payments.ts`, parsed from source with the
 * TypeScript parser.
 *
 * Deliberately not a substring scan of the whole file: `payments.ts` names
 * retired symbols in comments explaining why the retirement gate above them
 * still matters, and a `toContain` check would call that a violation. Parsing
 * gives that for free — a comment is not a node, so nothing in prose can make
 * this red, and nothing in code can hide from it behind formatting.
 *
 * **Why an AST and not a wider regex (#2049).** The previous extractor matched
 * `import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']+'` — named clauses in single
 * quotes, and nothing else. Measured against the shapes a reintroduction could
 * take, it missed eight: namespace import, dynamic `import()` (destructured or
 * whole-namespace), a computed dynamic specifier, `createRequire`-style
 * `require('…')`, `export { … } from`, `export * from`, side-effect `import '…'`,
 * and — not in the ticket, found while measuring — a perfectly ordinary named
 * clause written with DOUBLE quotes. A regex grown to cover eight cases is
 * itself hard to falsify, and it stops matching silently when a ninth appears.
 *
 * ⚠️ **What this still does NOT see, named here so it cannot be over-read.**
 * 1. **Transitive reach.** It reads ONE file. An allowed module that itself
 *    imports the arithmetic and re-exposes it is invisible — and that path is
 *    real: `routes/payments.ts` → `modules/mpp/index.ts` →
 *    `modules/mpp/allowances.ts` (#2044). What covers a transitive CALL is the
 *    `vi.mock` spy set above, which is live for exactly that reason.
 * 2. **Other payment surfaces.** `routes/x402.ts` and the machine-payment path
 *    are not read here; their own suites carry them.
 * 3. **Arithmetic re-implemented inline**, importing nothing. No import-shaped
 *    guard can see that; the spies cannot either.
 * 4. **`eval` / `new Function` string indirection.** Rule (5) below catches a
 *    computed `import()`, but not a module name assembled and eval'd.
 */
function paymentPathImports(): PaymentPathImports {
  const src = readFileSync(
    fileURLToPath(new URL('../payments.ts', import.meta.url)),
    'utf8',
  )
  const sourceFile = ts.createSourceFile(
    'payments.ts',
    src,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )

  const facts: PaymentPathImports = {
    bindings: new Set<string>(),
    reexports: new Set<string>(),
    staticModuleRefs: new Set<string>(),
    codeStringLiterals: new Set<string>(),
    unresolvableDynamicImports: 0,
  }

  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) facts.codeStringLiterals.add(node.text)

    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        facts.staticModuleRefs.add(node.moduleSpecifier.text)
      }
      const clause = node.importClause
      if (clause?.name) facts.bindings.add(clause.name.text) // default import
      const named = clause?.namedBindings
      if (named && ts.isNamespaceImport(named)) facts.bindings.add(named.name.text)
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          facts.bindings.add((el.propertyName ?? el.name).text) // original name
          facts.bindings.add(el.name.text) // local alias
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        facts.staticModuleRefs.add(node.moduleSpecifier.text)
        const clause = node.exportClause
        if (clause && ts.isNamedExports(clause)) {
          for (const el of clause.elements) facts.reexports.add((el.propertyName ?? el.name).text)
        }
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0]
      if (!specifier || !ts.isStringLiteralLike(specifier)) facts.unresolvableDynamicImports += 1
    }

    ts.forEachChild(node, walk)
  }
  ts.forEachChild(sourceFile, walk)

  return facts
}

describe('non-custody: the on-chain policy is the final gate (Red Line #4)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    mockQuery.mockReset()
    for (const m of Object.values(allowanceMocks)) m.mockReset()
    for (const m of Object.values(fiatMocks)) m.mockReset()
    for (const m of Object.values(delegationMocks)) m.mockReset()
    allowanceMocks.getTokenAllowance.mockResolvedValue({
      token: '0x0000000000000000000000000000000000000000',
      amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 7,
    })
  })

  // ── #1986 retirement: kept as one additional, strictly stronger case ─────

  it.each([
    ['a request exceeding what the legacy on-chain remaining ever was', '1'],
    ['a request well within what the legacy on-chain remaining ever was', '0.000001'],
  ])(
    '#1986 RETIREMENT: %s is refused before ANY on-chain allowance read — amount is irrelevant on the retired rail',
    async (_label, amount) => {
      primeDb(AUTH, railRoute(null)) // no Safe row / no rail marking → retired_allowance

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { ...PAY, amount },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expectNoOffChainCoverageArithmetic()
      // #2044: the `executeAllowanceTransfer` spy that stood here asserted on a
      // function #1987 deleted. That the retired rail cannot execute a transfer
      // is now carried by the structural import assertion below, which names
      // it and CAN fail.
    },
  )

  // ── STRUCTURAL: the arithmetic is not merely unused, it is UNREACHABLE ──

  it('RED LINE #4 (structural, #1987/#2049): the payment path imports NO off-chain coverage arithmetic, in ANY import shape', () => {
    const imports = paymentPathImports()

    // Positive control FIRST — prove the parser can say YES before a "no" is
    // allowed to mean anything. Without this, a parse that silently produced
    // nothing would report a perfect, empty, meaningless pass.
    expect(imports.bindings.has('prepareDelegationPayment')).toBe(true)
    expect(imports.bindings.has('submitDelegationPayment')).toBe(true)
    expect(imports.bindings.size).toBeGreaterThan(20)
    expect(imports.staticModuleRefs.has('../rails/delegation-authorization.js')).toBe(true)
    expect(imports.codeStringLiterals.size).toBeGreaterThan(20)

    // (1) BOUND NAMES. No retired arithmetic is bound into the route's module
    // scope by any static clause — named, aliased, or default — and either
    // quote style, since the parser does not care which one was typed.
    for (const banned of BANNED_ARITHMETIC) {
      expect(
        imports.bindings.has(banned),
        `${banned} must not be imported by routes/payments.ts`,
      ).toBe(false)
    }

    // (2) RE-EXPORTS. `export { computeEffectiveAllowance } from '…'` binds
    // nothing locally — rule (1) is blind to it — but it puts the arithmetic
    // straight back onto the payment route's own public surface.
    for (const banned of BANNED_ARITHMETIC) {
      expect(
        imports.reexports.has(banned),
        `${banned} must not be re-exported by routes/payments.ts`,
      ).toBe(false)
    }

    // (3) STATIC MODULE REACH. `import * as AM from`, `export * from` and a
    // bare side-effect `import '…'` bind no banned NAME at all, so only a
    // module-level rule can see them. A namespace binding is the shape #2049
    // was filed for.
    expect(
      bannedModuleRefs(imports.staticModuleRefs),
      'routes/payments.ts must not statically reference a retired-rail module in ANY clause form',
    ).toEqual([])

    // (4) RUNTIME MODULE REACH. Every string literal in the file's code is in
    // scope here, so `await import('…')` and a `createRequire(import.meta.url)`
    // `require('…')` fall to the same rule without either being enumerated.
    // Comments are not nodes, so prose naming a retired symbol stays green.
    // This rule structurally SUBSUMES (3) for any literal specifier; (3) is
    // kept so the failure names the static shape rather than just the string.
    expect(
      bannedModuleRefs(imports.codeStringLiterals),
      'routes/payments.ts must not name a retired-rail module in any runtime import() or require()',
    ).toEqual([])

    // (5) UNRESOLVABLE SPECIFIERS. A dynamic `import(expr)` — variable,
    // concatenation, or template with substitutions — cannot be resolved by
    // rule (4) or by anything else reading source. Its presence on this route
    // IS the finding: this route has no legitimate need for one.
    expect(
      imports.unresolvableDynamicImports,
      'routes/payments.ts must not use a computed dynamic import() specifier — it cannot be checked',
    ).toBe(0)
  })

  // ── DELEGATION RAIL: the on-chain simulation is the only gate ────────────

  it('DELEGATION RAIL: a caveat-enforcer rejection is forwarded verbatim — nothing written, no off-chain override', async () => {
    // Stand-in for the DelegationManager's caveat enforcers reverting during
    // gas estimation (budget/recipient/expiry) — see the file header for what
    // this can and cannot prove about the Solidity itself.
    delegationMocks.prepareDelegationPayment.mockRejectedValueOnce(
      new Error('ERC20PeriodTransferEnforcer:transfer-amount-exceeded'),
    )
    primeDb(AUTH, railRoute('delegation'))

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode).toBe(502)
    expect(res.json().error).toMatch(/on-chain policy/)
    expect(res.json().details).toContain('transfer-amount-exceeded')
    expectNoOffChainCoverageArithmetic()
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('DELEGATION RAIL: no active delegation authorizes this recipient — refused, still no off-chain arithmetic', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValueOnce(null)
    primeDb(AUTH, railRoute('delegation'))

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode).toBe(403)
    expectNoOffChainCoverageArithmetic()
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('DELEGATION RAIL — positive control: the on-chain simulation accepts the payment and Haven relays a signable intent, still without computing its own remaining', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValueOnce({
      delegationHash: DELEGATION_HASH,
      prepared: {
        userOperation: { sender: AGENT.safe_address, nonce: 1n, callData: '0xabcd' },
        userOpHash: USER_OP_HASH,
        signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
        delegateAccountAddress: '0x' + 'ee'.repeat(20),
      },
    })
    primeDb(
      AUTH,
      railRoute('delegation'),
      insertIntent(intentRow({ execution_rail: 'delegation' })),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode, `delegation rail must still pay, got ${res.body}`).toBe(201)
    expect(res.json().sign_data).toBeTruthy()
    // The chain's simulation was consulted — nothing else was:
    expect(delegationMocks.prepareDelegationPayment).toHaveBeenCalledOnce()
    expectNoOffChainCoverageArithmetic()
  })
})
