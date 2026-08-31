import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * The Safe / AllowanceModule rail CANNOT SPEND (#1986, epic #1440 slice 3).
 *
 * This file is the single place that proves the legacy rail refuses to move
 * money, the way `safe-inflow-retired.test.ts` is the single place that proves
 * it refuses new accounts (#1984). It is the #834 session-rail tombstone
 * applied to the rail that actually held funds.
 *
 * **The entry-point table below IS the definition of the closure.** It was
 * built by asking "what can EXECUTE a spend on this rail", not "what routes
 * does the ticket name" — the #1984 lesson, where enumerating writers instead
 * of callers turned three inflows into four. The ticket named `POST /payments`
 * and "x402 machine-payment paths"; enumerating executors found six, and two
 * of them are the ones a scope read would have missed:
 *
 *   POST /payments                — mints the intent (ticket)
 *   POST /payments/:id/sign       — the only path that reaches
 *                                   `executeAllowanceTransfer` FROM A LIVE
 *                                   ROUTE, so this is the last line between a
 *                                   legacy intent authorized BEFORE this
 *                                   slice and a real transfer. Closing only
 *                                   the create path would have left every
 *                                   pending intent executable.
 *                                   (`executeAllowanceTransfer` has THREE call
 *                                   sites, not one — `haven-reviewer` caught
 *                                   the overstatement. The other two are the
 *                                   one-shot auto-executes in
 *                                   `modules/mpp/authorize.ts` and
 *                                   `modules/x402/legacy-authorize.ts`, each
 *                                   gated by its own `retired_allowance`
 *                                   refusal upstream, and the MPP one is
 *                                   additionally dead in production behind a
 *                                   #1328 stub. Both gates are pinned below.)
 *   POST /x402/authorize, POST /x402 — the legacy funding leg (ticket)
 *   POST /machine-payments/send   — does not itself execute, but WRITES an
 *                                   intent (or an approval row) and hands
 *                                   back signing instructions. Leaving it
 *                                   open would satisfy "410 on the executor"
 *                                   while still writing rows for a payment
 *                                   that can never complete.
 *   POST /approvals/:id/approve, /proposed — the owner-facing half: approving
 *                                   hands the dashboard an executable Safe
 *                                   transaction. Named here so the table stays
 *                                   complete; as of #2055 the route itself is
 *                                   deregistered (404, not 410 — see "the
 *                                   approval queue" section below), so this
 *                                   entry-point closed by deletion rather than
 *                                   by refusal.
 *
 * Each refusal gets four assertions, because "returns 410" alone would still
 * pass if the handler had already written a row or funded the delegate on its
 * way to the refusal:
 *
 *   1. the status is 410 — not 403, which reads as a policy failure the caller
 *      can retry out of, and not 404, which reads as a transient routing error
 *      (the #834 / #1328 precedent);
 *   2. the body is `allowanceModuleRailRetired(...)` VERBATIM, compared against
 *      the producer rather than a copied string;
 *   3. NOTHING was written — no INSERT, no UPDATE — and no chain call was
 *      made: the allowance was never read and the delegate was never funded.
 *
 *      **#2307 corrected this clause.** It used to end "and
 *      `executeAllowanceTransfer` was never called", asserted with a spy. That
 *      assertion could not fail: #1987 deleted the executor, and
 *      `rails/allowance-module.ts` has never exported that name since, so the
 *      `vi.mock` factory entry was a function nothing could reach. Vitest
 *      accepts such an entry silently, which is how 56 of these accumulated
 *      across seven files before #2307 counted them.
 *
 *      What replaces it is strictly stronger, and lives in
 *      "the spend machinery is GONE, not merely refused" at the bottom of this
 *      file: the executor is asserted ABSENT from backend production code,
 *      rather than un-called on one request. A spy proves one path did not
 *      spend; the absence proves no path can;
 *   4. it holds for the WHOLE retired population, not just the literal
 *      `execution_rail='allowance_module'`: the LEFT-JOIN `null` and an
 *      unknown column value reach the same executor and must refuse too.
 *
 * Two further assertions exist because they are the ones most likely to rot:
 *
 *   - **401 precedes 410.** `agentAuthMiddleware` is an `onRequest` hook and
 *     every refusal here is inside the handler, so an unauthenticated caller
 *     never learns the route's disposition. Asserted, not assumed.
 *   - **The positive control.** A DELEGATION-rail account still pays, green in
 *     the same run. Without it every assertion in this file would be satisfied
 *     by deleting the payment code, and the suite would be a guard that can
 *     only say no.
 *
 * And the reads: an existing legacy account is NOT cut off from its own
 * PAYMENT HISTORY. The epic is explicit — "Accounts/history stay READABLE" —
 * so the read case at the bottom pins that `GET /payments` still serves a
 * legacy account, deliberately shallow: it asserts the route still SERVES,
 * and its semantics stay pinned where they already are.
 *
 * `GET /machine-payments/allowances` does NOT belong in that "reads stay
 * open" set any more (#2020, epic #1440, reversing this file's own #1986
 * decision recorded 2026-08-25 on the issue): it REPORTS spend authority
 * rather than serving history, and #1986's read-regression argument for
 * leaving it open stopped holding once the population it protected was
 * emptied and unsupported. It now 410s alongside the spend paths above,
 * pinned in "an existing legacy account is not cut off from its own data".
 */

// db-mock-exempt: the contract under test is "the database is never reached",
// so the pool stand-in exists precisely so `expect(mockQuery).not.toHaveBeen
// CalledWith(INSERT…)` can be asserted at all. There is no database BEHAVIOUR
// here to prove on the real-Postgres harness (#1219) — a real database would
// make these assertions weaker, not stronger, because it cannot distinguish
// "no write was issued" from "a write was issued and changed nothing".
const { mockQuery, allowanceMocks, fiatMocks, delegationMocks, x402DelegationMocks } = vi.hoisted(
  () => ({
    mockQuery: vi.fn(),
    allowanceMocks: {
      getTokenAllowance: vi.fn(),
      getTokenBalance: vi.fn(),
      getProvider: vi.fn(),
      getRelayerWallet: vi.fn(),
    },
    fiatMocks: {
      getFiatValuesForTokenAmount: vi.fn(),
      getBookTimeSekValue: vi.fn().mockResolvedValue(null),
    },
    delegationMocks: {
      prepareDelegationPayment: vi.fn(),
      submitDelegationPayment: vi.fn(),
    },
    x402DelegationMocks: {
      runDelegationAuthorize: vi.fn(),
    },
  }),
)

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)

import fs from 'node:fs'
import path from 'node:path'

import paymentRoutes from '../payments.js'
import x402Routes from '../x402.js'
import machinePaymentRoutes from '../machine-payments.js'
import {
  allowanceModuleRailRetired,
  sessionRailRetired,
} from '../../rails/execution-rail.js'

const RETIRED_ACCOUNT = allowanceModuleRailRetired('account').body.error
const RETIRED_INTENT = allowanceModuleRailRetired('intent').body.error

const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const SIGNATURE = `0x${'ab'.repeat(65)}`

function agentRow(executionRail: string | null) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: '22222222-2222-2222-2222-222222222222',
    name: 'Payment Agent',
    delegate_address: DELEGATE,
    safe_address: SAFE,
    chain_id: 84532,
    status: 'active',
    execution_rail: executionRail,
    account_type: executionRail === 'delegation' ? 'delegator_hybrid' : 'safe',
  }
}

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: agentRow(null).id,
    user_id: agentRow(null).user_id,
    safe_address: SAFE,
    chain_id: 84532,
    token_symbol: 'USDC',
    token_address: USDC,
    to_address: RECIPIENT.toLowerCase(),
    amount_raw: '10000',
    amount_human: '0.01',
    delegate_address: DELEGATE,
    allowance_nonce: 7,
    sign_hash: `0x${'cd'.repeat(32)}`,
    signature: null,
    tx_hash: null,
    status: 'pending_signature',
    error_message: null,
    created_at: '2026-08-24T10:00:00.000Z',
    signed_at: null,
    submitted_at: null,
    confirmed_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    execution_rail: null,
    session_permission_id: null,
    session_user_op: null,
    payment_rail: null,
    source: 'direct',
    ...overrides,
  }
}

type DbRoute = [RegExp, () => { rows: unknown[] }]

/**
 * Content-dispatch DB stub (#1226, the `payments.test.ts` model) — never
 * positional. Deliberately GENEROUS: every unmatched query resolves happily,
 * so if a handler DID run past the guard it succeeds quietly and the
 * "nothing was written" assertions are what catch it, rather than a crash
 * that could be mistaken for the refusal working.
 */
function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler()
    }
    return { rows: [] }
  })
}

const authRoute = (rail: string | null): DbRoute => [
  /api_key_hash = \$1/,
  () => ({ rows: [agentRow(rail)] }),
]
/** `FIND_EXECUTION_RAIL_FOR_AGENT_SQL` — the LEFT JOIN through `agents.safe_id`. */
const railRoute = (rail: string | null): DbRoute => [
  /LEFT JOIN user_safes/,
  () => ({ rows: [{ execution_rail: rail }] }),
]
const intentRoute = (overrides: Record<string, unknown> = {}): DbRoute => [
  /FROM payment_intents/,
  () => ({ rows: [intentRow(overrides)] }),
]

const sqlCalls = () => mockQuery.mock.calls.map((c) => String(c[0]))
const writes = () => sqlCalls().filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql.trim()))

/**
 * Every assertion that makes a 410 mean "fail-closed" rather than just "410".
 *
 * #2307 removed two spies from this helper (`executeAllowanceTransfer`,
 * `generateTransferHash`). Neither is an export of the mocked module, so
 * neither could ever fail. Both remaining assertions are real: `writes()` reads
 * the query log the handler actually produced, and `getTokenAllowance` is a
 * genuine export of `rails/allowance-module.ts`.
 *
 * The "no spend happened" half of the old claim did not move to another spy —
 * it moved to a structural assertion (see "the spend machinery is GONE" below),
 * because after #1987 there is no spend function left for a spy to watch.
 */
function expectNothingHappened() {
  expect(writes(), `a write reached the database: ${writes().join(' | ')}`).toEqual([])
  expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
}

/**
 * The retired population. `user_safes.execution_rail` is
 * `NOT NULL DEFAULT 'allowance_module'` with a three-value CHECK, so `null`
 * here means the LEFT JOIN found no Safe row — the case the issue's own
 * `execution_rail='allowance_module'` phrasing does not name, and the one a
 * literal string comparison would have left open.
 */
const RETIRED_RAILS: Array<[string, string | null]> = [
  ['the literal allowance_module marking', 'allowance_module'],
  ['a missing Safe row (LEFT JOIN null)', null],
  ['an unrecognised rail value', 'something_else'],
]

describe('the Safe / AllowanceModule rail cannot spend (#1986)', () => {
  let app: FastifyInstance
  let token: string
  const headers = { authorization: 'Bearer sk_agent_test' }

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(paymentRoutes, { prefix: '/payments' })
    await app.register(x402Routes, { prefix: '/x402' })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
    // #2055: `/approvals` is NOT registered here — the route is deregistered
    // repo-wide, so every path under it is a plain unmatched-route 404 rather
    // than an app-level refusal. See "the approval queue" section below.
    token = app.jwt.sign({ sub: agentRow(null).user_id, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
    for (const m of Object.values(allowanceMocks)) m.mockReset()
    for (const m of Object.values(delegationMocks)) m.mockReset()
    for (const m of Object.values(x402DelegationMocks)) m.mockReset()
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '1.00', eur: '0.92' })
    fiatMocks.getBookTimeSekValue.mockResolvedValue(null)
  })

  // ── The spend paths ──────────────────────────────────────────────────────

  describe('POST /payments — the direct spend path', () => {
    it.each(RETIRED_RAILS)('refuses %s — 410, nothing written, no chain read', async (_label, rail) => {
      primeDb(authRoute(rail), railRoute(rail))

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers,
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_ACCOUNT)
      expectNothingHappened()
    })

    it('refuses BEFORE the idempotency replay lookup — a replay cannot resurrect sign_data', async () => {
      // Position matters, not just presence: the early gate sits above the
      // replay lookup, so a retried request cannot be handed the FIRST
      // request's still-actionable sign_data after the rail is retired. Same
      // reasoning as the #1207 review finding on the session rail.
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'))

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers,
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT, idempotency_key: 'k-1' },
      })

      expect(res.statusCode).toBe(410)
      expect(sqlCalls().some((sql) => /send_idempotency_key/.test(sql))).toBe(false)
      expectNothingHappened()
    })
  })

  // Historical name: this route WAS the only live caller of the deleted
  // `executeAllowanceTransfer`. It is kept because the refusal it pins is the
  // last line between a legacy intent authorized before #1986 and a transfer.
  describe('POST /payments/:id/sign — the last line in front of a pre-#1986 intent', () => {
    it('refuses a pending legacy intent authorized before the retirement — 410, no transfer', async () => {
      // The pre-existing-intent case is the one that decides whether this
      // slice actually closes the rail: `POST /payments` refusing new intents
      // does nothing about the ones already sitting in `pending_signature`.
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'), intentRoute())

      const res = await app.inject({
        method: 'POST',
        url: `/payments/${PAYMENT_ID}/sign`,
        headers,
        payload: { signature: SIGNATURE },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_INTENT)
      expectNothingHappened()
      // #2307: a `recoverSigner` spy stood here for "not even the signature was
      // checked". Unfalsifiable — the raw-ECDSA recovery scheme died with the
      // rail (#1986) and the helper was deleted (#1987), so the name is not an
      // export and the spy could never have been called. The surviving claim is
      // that nothing was written on the way to the 410, which
      // `expectNothingHappened()` asserts against the real query log.
    })

    it('refuses an EXPIRED legacy intent without writing the expiry flip', async () => {
      // The #1120 ordering rule: a 410-with-nothing-written contract must not
      // be reached through a path that has already flipped a status on the way.
      primeDb(
        authRoute('allowance_module'),
        railRoute('allowance_module'),
        intentRoute({ expires_at: '2020-01-01T00:00:00.000Z' }),
      )

      const res = await app.inject({
        method: 'POST',
        url: `/payments/${PAYMENT_ID}/sign`,
        headers,
        payload: { signature: SIGNATURE },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_INTENT)
      expectNothingHappened()
    })
  })

  describe('x402 — the legacy funding leg', () => {
    it.each(['/x402/authorize', '/x402'])(
      'POST %s refuses a legacy account — 410, delegate never funded',
      async (url) => {
        primeDb(authRoute('allowance_module'), railRoute('allowance_module'))

        const res = await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            url: 'https://merchant.example/resource',
            payTo: RECIPIENT,
            amount: '10000',
            asset: USDC,
            network: 'base-sepolia',
          },
        })

        expect(res.statusCode).toBe(410)
        expect(res.json().error).toBe(RETIRED_ACCOUNT)
        expectNothingHappened()
      },
    )
  })

  /**
   * #2245 — a caller-supplied field must not decide WHICH refusal a
   * retired-rail account gets.
   *
   * Before this slice `validateGenericSchemeRail` ran ABOVE the rail
   * resolution in `modules/x402/authorize.ts`, so a retired-rail account that
   * sent `settlementScheme: 'erc7710'` (or any `facilitatorAddresses`) never
   * reached the tombstone above. It got a **400** whose body said *"the legacy
   * AllowanceModule rail settles via EIP-3009 only"* — telling an agent, in a
   * response body on a money-path route, that a rail #1986 has fail-closed
   * would settle its payment, and inviting it to retry forever with a
   * different scheme against a rail that answers 410 to everything.
   *
   * Money was never at risk either way: both branches are refusals, both are
   * pure (`validateGenericSchemeRail` and `resolveExecutionRail` are both
   * side-effect-free and read the SAME `agent.execution_rail` field), and
   * nothing was read on-chain or written on either. `expectNothingHappened()`
   * is asserted on every case below anyway, because that is the property that
   * would silently invert if the fix were ever undone by re-raising a guard.
   *
   * The mutation that proves these: restore the
   * `validateGenericSchemeRail(agent, settlementScheme, facilitatorAddresses)`
   * call above the token resolution in `modules/x402/authorize.ts` and every
   * `settlementScheme: 'erc7710'` / `facilitatorAddresses` case here goes red
   * on a 400.
   */
  describe('a caller-supplied settlementScheme cannot divert the tombstone (#2245)', () => {
    const baseX402 = {
      url: 'https://merchant.example/resource',
      payTo: RECIPIENT,
      amount: '10000',
      asset: USDC,
      network: 'base-sepolia',
    }

    // The scheme-bearing shapes, on BOTH authorize aliases and the whole
    // retired population. `eip3009` and the bare request are included as
    // controls: they already got the 410 before #2245, so their presence here
    // is what makes "for EVERY input shape" a claim rather than a slogan —
    // and their staying green under the mutation is what shows the mutation
    // is discriminating rather than blanket-red.
    const SCHEME_SHAPES: Array<[string, Record<string, unknown>]> = [
      ['settlementScheme: erc7710 (the diverted case)', { settlementScheme: 'erc7710' }],
      ['settlementScheme: eip3009', { settlementScheme: 'eip3009' }],
      ['facilitatorAddresses present (the #1058 diverted case)', { facilitatorAddresses: [RECIPIENT] }],
      ['erc7710 AND facilitatorAddresses together', { settlementScheme: 'erc7710', facilitatorAddresses: [RECIPIENT] }],
      ['no scheme field at all (the pre-#2245 control)', {}],
    ]

    for (const [railLabel, rail] of RETIRED_RAILS) {
      for (const url of ['/x402/authorize', '/x402']) {
        it.each(SCHEME_SHAPES)(
          `POST ${url} on ${railLabel} with %s — 410, nothing written`,
          async (_shapeLabel, extra) => {
            primeDb(authRoute(rail), railRoute(rail))

            const res = await app.inject({
              method: 'POST',
              url,
              headers,
              payload: { ...baseX402, ...extra },
            })

            expect(res.statusCode, `got ${res.body}`).toBe(410)
            // Named, not merely "some 410" — and explicitly NOT the 400 the
            // scheme guard used to produce.
            expect(res.json().error).toBe(RETIRED_ACCOUNT)
            expect(JSON.stringify(res.json())).not.toContain('EIP-3009')
            expect(JSON.stringify(res.json())).not.toContain('delegation-rail account')
            expectNothingHappened()
          },
        )
      }
    }

    it('no surviving response body on this route describes the retired rail as settling', async () => {
      // Acceptance criterion 2, asserted as a literal guard on the file that
      // used to carry the sentence rather than as an interpretation of prose.
      // `scheme-selection.ts` has no legitimate use of either literal: what
      // remains in it is delegation-rail-INTERNAL shape checking, which never
      // names the legacy rail.
      const src = await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../../modules/x402/scheme-selection.ts', import.meta.url), 'utf8'),
      )
      // The refusal STRINGS are gone. The file's own #2245 rationale block
      // quotes the deleted sentence to explain why it went, so the guard is
      // scoped to the executable half.
      const code = src
        .split('\n')
        .filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line))
        .join('\n')
      expect(code).not.toContain('AllowanceModule')
      expect(code).not.toContain('delegation-rail account')
    })

    /**
     * The OTHER direction, and the one PR #2052/#2056 says to check
     * explicitly: the reorder must not make a LIVE-rail caller's answer worse.
     * A delegation account that asks for a scheme its request SHAPE cannot
     * settle still gets its own 400 from the delegation-rail-internal check
     * (`validateDelegationSchemeShape`, where #946's real contract lives) —
     * not a 410, and not a silent pass into settlement.
     *
     * This doubles as the x402 POSITIVE CONTROL for this route: reaching a
     * delegation-rail-INTERNAL error proves the rail gate answered
     * `delegation` and control entered the delegation branch. A version of
     * this fix that 410'd everything would fail here, which the retired-rail
     * cases above cannot detect on their own.
     */
    it('POSITIVE CONTROL — a DELEGATION account asking erc7710 with the funding payTo still gets its own scheme 400, not a 410', async () => {
      primeDb(authRoute('delegation'), railRoute('delegation'))

      const res = await app.inject({
        method: 'POST',
        url: '/x402/authorize',
        headers,
        // payTo = the agent's OWN delegate EOA is the 3009 funding shape;
        // asking for erc7710 with it is the shape contradiction #946 guards.
        payload: { ...baseX402, payTo: DELEGATE, settlementScheme: 'erc7710' },
      })

      expect(res.statusCode, `got ${res.body}`).toBe(400)
      expect(res.json().error).toMatch(/payTo = the merchant/)
      expect(res.json().error).not.toBe(RETIRED_ACCOUNT)
      expectNothingHappened()
    })

    it('POSITIVE CONTROL — a DELEGATION account with a valid erc7710 shape is not refused at the rail seam', async () => {
      // Weaker on purpose: it asserts only that the request passed BOTH the
      // rail gate and the scheme shape check, since anything past that point
      // needs chain estimation this suite deliberately does not mock. Without
      // it, "410 nothing / 400 nothing" would still be satisfiable by a fix
      // that refused every erc7710 request outright.
      primeDb(authRoute('delegation'), railRoute('delegation'))

      const res = await app.inject({
        method: 'POST',
        url: '/x402/authorize',
        headers,
        payload: { ...baseX402, settlementScheme: 'erc7710', facilitatorAddresses: [RECIPIENT] },
      })

      expect(res.statusCode).not.toBe(410)
      expect(JSON.stringify(res.json())).not.toContain('retired')
      expect(JSON.stringify(res.json())).not.toMatch(/payTo = the merchant/)
    })

    /**
     * The residue, stated rather than glossed. Two refusals still precede the
     * 410 on this route, and BOTH are rail-INDEPENDENT — neither makes a claim
     * about any rail, which is the property #2245 is actually about:
     *
     *   - `routes/x402.ts`'s structural enum check on `settlementScheme`
     *     (a value that is not a settlement scheme at all), and
     *   - token resolution in `authorizeX402`, exactly where `POST /payments`
     *     puts its own gate relative to the seam.
     *
     * Same class as the 401-precedes-410 case this file already pins.
     */
    it('a STRUCTURALLY invalid settlementScheme is still a 400 — and it makes no rail claim', async () => {
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'))

      const res = await app.inject({
        method: 'POST',
        url: '/x402/authorize',
        headers,
        payload: { ...baseX402, settlementScheme: 'not-a-scheme' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/settlementScheme must be/)
      // The point of keeping it: it says nothing about what any rail settles.
      expect(res.json().error).not.toContain('AllowanceModule')
      expect(res.json().error).not.toContain('EIP-3009')
      expectNothingHappened()
    })

    it('the same structural 400 is what a DELEGATION account gets too — the check never branched on rail', async () => {
      primeDb(authRoute('delegation'), railRoute('delegation'))

      const res = await app.inject({
        method: 'POST',
        url: '/x402/authorize',
        headers,
        payload: { ...baseX402, settlementScheme: 'not-a-scheme' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/settlementScheme must be/)
      expectNothingHappened()
    })
  })

  describe('POST /machine-payments/send — writes rows even though it does not execute', () => {
    it.each(RETIRED_RAILS)('refuses %s — 410, no intent and no approval row', async (_label, rail) => {
      primeDb(authRoute(rail), railRoute(rail))

      const res = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers,
        payload: { asset: 'USDC', recipient: RECIPIENT, amount: '0.01' },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_ACCOUNT)
      expectNothingHappened()
      expect(sqlCalls().some((sql) => /approval_requests/i.test(sql))).toBe(false)
    })
  })

  // #2055 (epic #1440): `routes/approvals.ts` is deleted and `/approvals` is
  // deregistered outright — the table it read is dropped (migration 070).
  // Pre-#2055 this suite proved approve/proposed refused 410 while reject
  // still cleared the queue (#1986); the #2021 owner decision that carried
  // that distinction — "queue-history readability for legacy accounts is
  // waived" — removed the reason to keep any of the five operations live, so
  // there is no longer a queue to be readable, rejectable, or approvable.
  // Every one of them, GET and every POST transition alike, is now a plain
  // unmatched-route 404 rather than an app-level refusal.
  describe('the approval queue is gone — /approvals 404s everywhere (#2055, #2021)', () => {
    it.each([
      ['GET', '/approvals'],
      ['POST', `/approvals/${PAYMENT_ID}/approve`],
      ['POST', `/approvals/${PAYMENT_ID}/proposed`],
      ['POST', `/approvals/${PAYMENT_ID}/reject`],
      ['POST', `/approvals/${PAYMENT_ID}/executed`],
    ] as const)('%s /approvals... is 404 — the route is deregistered, not refused', async (method, url) => {
      primeDb()
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })

      expect(res.statusCode).toBe(404)
      // Not the on-chain-rail 410: there is no handler left to produce it.
      // #2085 removed the `'approval'` variant this compared against — it was
      // unreachable and its message was false. Comparing against the two
      // SURVIVING variants is strictly stronger: it rules out every 410 this
      // codebase can still produce, not just the one that no longer exists.
      expect(res.json().error).not.toBe(allowanceModuleRailRetired('account').body.error)
      expect(res.json().error).not.toBe(allowanceModuleRailRetired('intent').body.error)
      expect(mockQuery).not.toHaveBeenCalled()
    })
  })

  // ── Order, and the other tombstone ───────────────────────────────────────

  describe('401 precedes 410 — auth still runs first', () => {
    it.each([
      ['/payments', { token: 'USDC', amount: '0.01', to: RECIPIENT }],
      [`/payments/${PAYMENT_ID}/sign`, { signature: SIGNATURE }],
      ['/x402/authorize', { url: 'https://m.example/r', payTo: RECIPIENT, amount: '1', asset: USDC, network: 'base-sepolia' }],
      ['/machine-payments/send', { asset: 'USDC', recipient: RECIPIENT, amount: '0.01' }],
    ])('POST %s without a key is 401, and the caller learns nothing about the rail', async (url, payload) => {
      // `agentAuthMiddleware` is an onRequest hook and every refusal above is
      // inside the handler, so this is Fastify's documented lifecycle rather
      // than a coincidence — but it is the kind of guarantee that quietly
      // inverts when someone promotes a guard to onRequest, so it is asserted.
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'))

      const res = await app.inject({ method: 'POST', url, payload })

      expect(res.statusCode).toBe(401)
      expect(JSON.stringify(res.json())).not.toContain('retired')
      expectNothingHappened()
    })
  })

  describe('both tombstones coexist on the seam', () => {
    it('a session-rail account still gets #834s OWN message, not this one', async () => {
      primeDb(authRoute('session_key'), railRoute('session_key'))

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers,
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(sessionRailRetired('account').body.error)
      // Named, not merely "some 410": a guard against a FORK has to say which
      // branch it is on, or it only asserts that something refused (#1984).
      expect(res.json().error).not.toBe(RETIRED_ACCOUNT)
      expectNothingHappened()
    })
  })

  // ── The positive control ─────────────────────────────────────────────────

  describe('POSITIVE CONTROL — the delegation rail still pays', () => {
    it('POST /payments on a delegation account still returns signable sign_data', async () => {
      // Without this, every assertion in this file would be satisfied by
      // deleting the payment code. This is what makes the refusals mean
      // something: the guard can say yes.
      primeDb(authRoute('delegation'), railRoute('delegation'), [
        /INSERT INTO payment_intents/,
        () => ({ rows: [intentRow({ execution_rail: 'delegation' })] }),
      ])
      delegationMocks.prepareDelegationPayment.mockResolvedValue({
        ok: true,
        prepared: {
          userOpHash: `0x${'cd'.repeat(32)}`,
          signingTypedData: { domain: {}, types: {}, primaryType: 'X', message: {} },
          delegateAccountAddress: SAFE,
          delegationHash: `0x${'12'.repeat(32)}`,
          budgetDelegationHash: `0x${'12'.repeat(32)}`,
          userOp: {},
        },
      })

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers,
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
      })

      expect(res.statusCode, `delegation rail must still pay, got ${res.body}`).toBe(201)
      expect(res.json().sign_data).toBeTruthy()
      // And it was never mistaken for the retired rail.
      expect(JSON.stringify(res.json())).not.toContain('retired')
    })
  })

  // ── The reads stay open ──────────────────────────────────────────────────

  describe('an existing legacy account is not cut off from its own data', () => {
    it('GET /payments still lists a legacy account history', async () => {
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'), [
        /FROM payment_intents/,
        () => ({ rows: [intentRow({ status: 'confirmed', tx_hash: `0x${'ef'.repeat(32)}` })] }),
      ])

      const res = await app.inject({ method: 'GET', url: '/payments', headers })

      expect(res.statusCode).toBe(200)
      expect(res.json().payments).toHaveLength(1)
    })

    // #2020 (epic #1440), reversing this file's own #1986 decision (owner
    // call recorded 2026-08-25 on the issue): this endpoint REPORTS spend
    // authority, and #1986 deliberately left it readable on the retired
    // rail on that basis. #2020 finds the read-regression argument no longer
    // holds — the accounts are emptied and unsupported, and this read was the
    // last thing pinning `agent_allowances` and the legacy on-chain allowance
    // reader into the codebase — so it now gets the SAME 410 as the spend
    // paths above, and reads nothing to build it.
    it('GET /machine-payments/allowances now 410s a legacy account too — the last read closes with the rest of the rail', async () => {
      primeDb(authRoute('allowance_module'), railRoute('allowance_module'))

      const res = await app.inject({ method: 'GET', url: '/machine-payments/allowances', headers })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(RETIRED_ACCOUNT)
      // `getTokenAllowance` IS an export, so this one bites. (#2307 removed a
      // `getLatestBlockTimeSec` spy alongside it, which was not.)
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
      expect(sqlCalls().some((sql) => /agent_allowances/.test(sql))).toBe(false)
    })
  })
})

/**
 * #2307 — the coverage that REPLACES the 56 removed spies.
 *
 * Every one of those spies was trying to say the same thing: the retired rail
 * did not spend. They said it by watching a function that does not exist, which
 * is why none of them could fail. The claim is real, so it is re-stated here in
 * a form that CAN fail — and in a stronger form than the spies had, because a
 * spy proves one request did not spend while this proves no request can.
 *
 * #1987 deleted the write path outright: the executor, the transfer-hash
 * builder, the raw-ECDSA signer recovery, and the allowance-state arithmetic.
 * "Deleted" is a property of the source tree, so the source tree is what gets
 * asserted. If any of these names returns to backend production code, the rail
 * has grown a spend path back and this goes red by name.
 *
 * Scope note (the #2163 rule about matching the check to the claim): this scans
 * `packages/backend/src` only, and the sentence above says "backend production
 * code" for that reason. `packages/frontend/src/lib/allowance-math.ts` exports
 * its own `computeEffectiveAllowance` — pure display arithmetic over a legacy
 * account's on-chain state, which is a READ and is deliberately still there.
 * It is not in scope for a claim about the backend's write path.
 */
describe('#1986/#1987: the spend machinery is GONE, not merely refused', () => {
  const BACKEND_SRC = path.resolve(__dirname, '../..')

  /** The write path #1987 deleted, by the name each symbol had. */
  const DELETED_WRITE_PATH = [
    'executeAllowanceTransfer',
    'generateTransferHash',
    'recoverSigner',
    'getLatestBlockTimeSec',
    'computeEffectiveAllowance',
  ]

  function productionSources(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // `__tests__` is test code; `testing/` is test INFRASTRUCTURE (the
        // #2307 mock-factory guard and its fixture source, which necessarily
        // spells the dead names out). Neither is production code.
        if (entry.name === '__tests__' || entry.name === 'testing') continue
        productionSources(full, acc)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        acc.push(full)
      }
    }
    return acc
  }

  /**
   * Strip comments AND string literals, leaving executable code.
   *
   * Both exclusions are deliberate and were forced by real occurrences. A
   * tombstone comment that names the dead symbol is the documentation this
   * retirement wants (`routes/payments.ts:541` is one). And `openapi/spec.ts`
   * names `recoverSigner` inside an endpoint DESCRIPTION — prose telling
   * integrators that the scheme is gone. Naming a deleted function in order to
   * say it is deleted must not be what trips a guard against it coming back.
   *
   * **The cost of stripping strings, stated rather than left implicit** (review
   * finding, #2307): a reintroduction routed through a string would evade this
   * — `obj['execute' + 'AllowanceTransfer']`, a computed member access, a
   * dynamic import by name. That is accepted deliberately. The threat model
   * here is ACCIDENTAL regrowth by ordinary editing, which is what actually
   * happened three times (#1987 → #2048 → #2044/#1993); a contributor
   * assembling a deleted money-path function name out of string fragments to
   * get past a test is not a case a source scan can win, and the controls for
   * it are code review and `.github/CODEOWNERS`, not this assertion.
   */
  function executableCode(src: string): string {
    let out = ''
    for (let i = 0; i < src.length; i++) {
      const c = src[i]
      const next = src[i + 1]
      if (c === '/' && next === '/') {
        const nl = src.indexOf('\n', i)
        if (nl === -1) break
        i = nl - 1
        continue
      }
      if (c === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2)
        if (end === -1) break
        i = end + 1
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        const quote = c
        i++
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i++
          i++
        }
        continue
      }
      out += c
    }
    return out
  }

  const sources = productionSources(BACKEND_SRC)

  it('scans a real population of backend sources — an empty scan is not a pass', () => {
    // The falsifiability floor (#1897's "false zeros" lesson): prove the
    // instrument can see anything before a zero is allowed to mean something.
    expect(sources.length).toBeGreaterThan(150)
    expect(sources.some((f) => f.endsWith('rails/allowance-module.ts'))).toBe(true)
  })

  it('proves the instrument can say YES — a surviving read IS found by the same scan', () => {
    // Positive control. Without this, the absence assertions below would pass
    // just as happily against a broken matcher, which is the exact defect
    // #2307 exists to end.
    const hits = sources.filter((f) => /\bgetTokenBalance\b/.test(executableCode(fs.readFileSync(f, 'utf8'))))
    expect(hits.length).toBeGreaterThan(0)
  })

  it.each(DELETED_WRITE_PATH)(
    '`%s` appears nowhere in backend production code outside comments',
    (symbol) => {
      const re = new RegExp(`\\b${symbol}\\b`)
      const offenders = sources
        .filter((f) => re.test(executableCode(fs.readFileSync(f, 'utf8'))))
        .map((f) => path.relative(BACKEND_SRC, f))
      expect(
        offenders,
        `\`${symbol}\` is back in backend production code (${offenders.join(', ')}). ` +
          'It was deleted by #1987 as part of retiring the AllowanceModule rail. ' +
          'If the rail is genuinely being revived that is an owner decision (#1440), ' +
          'not a test fix.',
      ).toEqual([])
    },
  )
})
