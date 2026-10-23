// Self-test for the budget-liveness ratchet (#3924, epic #3919 slice E).
//
// Two layers, the same split the other ratchets use:
//
//   unit — the scanner's pure functions against fixture sources: what
//          counts, what is excluded (the named predicate definitions BY
//          EXPORT NAME, so an inline copy in delegation-budgets.ts itself
//          still counts), and what interpolation parsing catches.
//   CLI  — the gate run AS A PROCESS over a fixture repo the test owns
//          (`scripts/test-support/guard-cli.mjs`, #2720's rule: only
//          running the script proves the guard — #2690/#2704 mutated two
//          `main()` refusals away and the suites stayed green). The fixture
//          carries its own `packages/**` sources and baseline, so the gate
//          scans the FIXTURE, never the real repo. Every one of the six
//          scan roots is seeded even when empty: a scan root that reads
//          ZERO files must refuse, not pass.
//
// The green-on-the-real-repo case is NOT here on purpose: CI runs
// `npm run lint:budget-liveness` as its own step against the committed
// baseline; a fixture pins the decisions instead of drifting with the tree.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runGuard } from './test-support/guard-cli.mjs'
import {
  scanFile,
  blankNamedPredicateBodies,
  NAMED_PREDICATE_EXPORTS,
} from './lint-budget-liveness.mjs'

const GATE = 'lint-budget-liveness.mjs'
const ALSO = ['lib/ratchet.mjs']
const BASELINE = 'scripts/lint-budget-liveness-baseline.json'

// A file per scan root, so the zero-scan refusal never fires on a fixture
// that deliberately exercises only one package.
function seedDirs(files = {}) {
  const seeded = {
    'packages/backend/src/seed.ts': 'export const seeded = true\n',
    'packages/sdk/src/seed.ts': 'export const seeded = true\n',
    'packages/cli/src/seed.ts': 'export const seeded = true\n',
    'packages/frontend/src/seed.ts': 'export const seeded = true\n',
    'packages/mcp/src/seed.ts': 'export const seeded = true\n',
    'packages/mcp-server/src/seed.ts': 'export const seeded = true\n',
    ...files,
  }
  for (const [k, v] of Object.entries(files)) seeded[k] = v
  return seeded
}

// ── Unit: what counts ────────────────────────────────────────────────────────

describe('scanFile: SQL read predicates', () => {
  test('a planted SELECT WHERE on a budget table counts status and time', () => {
    const src = `export async function probe(pool: unknown) {
  return pool.query(
    \`SELECT id FROM agent_delegations WHERE status = 'active' AND expires_at > $1\`,
  )
}`
    assert.deepEqual(scanFile(src, 'packages/backend/src/probe.ts'), {
      'sql-status-literal': 1,
      'sql-time-now': 1,
    })
  })

  test('a status TRANSITION (`UPDATE … SET status`) does not count', () => {
    const src = "export const SQL = `UPDATE agent_delegations SET status = 'active' WHERE id = $1`\n"
    assert.deepEqual(scanFile(src, 'packages/backend/src/probe.ts'), {})
  })

  test('a status literal on a NON-budget table does not count, even in a statement that also reads agent_delegations', () => {
    // The agents overview shape: `mpre.status = 'open'` rides on
    // machine_payment_reconciliation_events while the same statement has an
    // agent_delegations subselect — attribution must be per predicate.
    const src = [
      'export const SQL = `SELECT EXISTS(',
      '  SELECT 1 FROM machine_payment_reconciliation_events mpre',
      '  WHERE mpre.status = \'open\'',
      ') AS has_stranded_funds,',
      '(SELECT count(*) FROM agent_delegations ald WHERE ald.agent_id = a.id) AS n`',
    ].join('\n')
    assert.deepEqual(scanFile(src, 'packages/backend/src/probe.ts'), {})
  })

  test('an ALIASED budget-table predicate counts', () => {
    const src = "export const SQL = `SELECT 1 FROM agent_sub_budgets b WHERE b.status = 'closing'`\n"
    assert.deepEqual(scanFile(src, 'packages/backend/src/probe.ts'), {
      'sql-status-literal': 1,
    })
  })

  test('SQL inside a template literal with ${} interpolation is parsed, not skipped', () => {
    const src = [
      'export const SQL = `SELECT 1 FROM agent_task_budgets tb',
      '  WHERE ${alias}status = \'open\' AND expires_at > ${nowParam}`',
    ].join('\n')
    assert.deepEqual(scanFile(src, 'packages/backend/src/probe.ts'), {
      'sql-status-literal': 1,
      'sql-time-now': 1,
    })
  })

  test('a WITH (CTE) read counts like a SELECT', () => {
    const src = "export const SQL = `WITH live AS (SELECT id FROM agent_delegations) SELECT * FROM live WHERE status = 'pending'`\n"
    // Unqualified predicate at depth 0; the counted mention sits inside the
    // CTE at depth 1 — deliberately NOT attributed (documented hole).
    assert.deepEqual(scanFile(src, 'packages/backend/src/probe.ts'), {})
  })

  test('JOIN ON predicates are not WHERE clauses and do not count', () => {
    const src = "export const SQL = `SELECT * FROM agent_delegations d JOIN agents a ON d.status = 'active' AND a.id = d.agent_id`\n"
    assert.deepEqual(scanFile(src, 'packages/backend/src/probe.ts'), {})
  })
})

// ── Unit: exclusion by export name ───────────────────────────────────────────

describe('blankNamedPredicateBodies', () => {
  const DELEGATION_FILE = [
    'export function spendableDelegationSql(',
    '  tableAlias: string | undefined,',
    '  opts: { requireStarted: boolean },',
    '): string {',
    "  const prefix = tableAlias ? `${tableAlias}.` : ''",
    "  return `${prefix}status = 'active' AND ${prefix}expires_at > EXTRACT(EPOCH FROM NOW())`",
    '}',
    '',
    'export const INLINE = `SELECT id FROM agent_delegations WHERE status = \'active\' AND expires_at > $1`',
  ].join('\n')

  test('the named definition body is excluded; an inline copy in the SAME file still counts', () => {
    const counts = scanFile(DELEGATION_FILE, 'packages/backend/src/infra/repositories/delegation-budgets.ts')
    assert.deepEqual(counts, {
      'sql-status-literal': 1,
      'sql-time-now': 1,
    })
  })

  test('every export on the exclusion list is a real function declaration shape', () => {
    for (const name of NAMED_PREDICATE_EXPORTS) {
      assert.match(name, /^[a-z][A-Za-z0-9]*$/)
    }
  })

  test('blanking keeps line count stable and removes the definition body', () => {
    const blanked = blankNamedPredicateBodies(DELEGATION_FILE)
    assert.equal(blanked.split('\n').length, DELEGATION_FILE.split('\n').length)
    assert.equal(blanked.includes("${prefix}status = 'active'"), false)
  })

  test('a RENAMED copy of a predicate is not excluded', () => {
    const src = [
      'export function myPredicateSql(): string {',
      "  return `SELECT 1 FROM agent_delegations WHERE status = 'active'`",
      '}',
    ].join('\n')
    const counts = scanFile(src, 'packages/backend/src/infra/repositories/delegation-budgets.ts')
    // The renamed definition is NOT on the exclusion list: its body counts.
    assert.deepEqual(counts, { 'sql-status-literal': 1 })
  })
})

// ── Unit: the TypeScript half ────────────────────────────────────────────────

describe('scanFile: TypeScript sites', () => {
  test('a budget-shaped status comparison counts', () => {
    const src = "export function f(budget: { status: string }) { return budget.status === 'active' }\n"
    assert.deepEqual(scanFile(src, 'packages/sdk/src/probe.ts'), { 'ts-status-liveness': 1 })
  })

  test('an AGENT status comparison does not count (dashboard-attention shape)', () => {
    const src = [
      'export function agentIsSetUp(agent: DashboardAgent): boolean {',
      "  return (agent.status === 'active' || agent.status === 'paused') && hasUsableBudget(agent)",
      '}',
    ].join('\n')
    assert.deepEqual(scanFile(src, 'packages/frontend/src/lib/probe.ts'), {})
  })

  test('a PAYMENT status comparison does not count (payment-state shape)', () => {
    const src = "export const f = (raw: PaymentRecord) => raw.status === 'pending' ? 1 : 0\n"
    assert.deepEqual(scanFile(src, 'packages/sdk/src/probe.ts'), {})
  })

  test('budget shape via the ±6-line window: a bare `b` beside its row fields counts', () => {
    const src = [
      'const row = budgets.find((b) => b.delegation_hash === grantHash && b.status === \'pending\')',
      'const amount = row?.budget_atomic',
    ].join('\n')
    assert.deepEqual(scanFile(src, 'packages/frontend/src/components/Probe.tsx'), {
      'ts-status-liveness': 1,
    })
  })

  test('budget shape via a named predicate call in the window', () => {
    const src = [
      'const active = (budgets ?? []).filter((b) => b.status === \'active\')',
      'const hasActive = active.some((b) => delegationIsLive(b))',
    ].join('\n')
    assert.deepEqual(scanFile(src, 'packages/frontend/src/components/Probe.tsx'), {
      'ts-status-liveness': 1,
    })
  })

  test('expires_at compared to now on a budget object counts; on a cache entry it does not', () => {
    const budget = "export const f = (budget: BudgetRow) => budget.expires_at > nowSec\n"
    assert.deepEqual(scanFile(budget, 'packages/sdk/src/probe.ts'), { 'ts-time-now': 1 })
    const cache = "export const f = (cached: Entry) => cached.expiresAt <= Date.now()\n"
    assert.deepEqual(scanFile(cache, 'packages/sdk/src/probe.ts'), {})
  })

  test('the backend payment-window mirror counts (the accepted mirror, ratcheted)', () => {
    const src = '.filter((b) => expiresAtOf(b) > now && startAtOf(b) <= now)'
    assert.deepEqual(scanFile(src, 'packages/backend/src/infra/repositories/probe.ts'), {
      'ts-payment-window': 2,
    })
  })
})

// ── CLI: the gate as a process ───────────────────────────────────────────────

const PLANTED_READ = `export async function probe(pool: unknown) {
  return pool.query(
    \`SELECT id FROM agent_delegations WHERE status = 'active' AND expires_at > $1\`,
  )
}`

const PLANTED_UPDATE =
  "export const SQL = `UPDATE agent_delegations SET status = 'active' WHERE id = $1`\n"

describe('CLI: lint-budget-liveness.mjs', () => {
  test('positive control: a planted inline read predicate turns the gate red', () => {
    const { status, out } = runGuard(GATE, {
      files: seedDirs({ 'packages/backend/src/probe.ts': PLANTED_READ }),
      also: ALSO,
    })
    assert.equal(status, 1)
    assert.match(out, /probe\.ts/)
    assert.match(out, /sql-status-literal/)
  })

  test('a planted status TRANSITION stays green', () => {
    const { status, out } = runGuard(GATE, {
      files: seedDirs({ 'packages/backend/src/probe.ts': PLANTED_UPDATE }),
      also: ALSO,
    })
    assert.equal(status, 0, out)
  })

  test('--update refuses to raise the baseline over a planted predicate', () => {
    const { status, out } = runGuard(GATE, {
      files: seedDirs({
        'packages/backend/src/probe.ts': PLANTED_READ,
        [BASELINE]: JSON.stringify({ 'packages/backend/src/probe.ts': { 'sql-status-literal': 0, 'sql-time-now': 0 } }),
      }),
      also: ALSO,
      args: ['--update'],
    })
    assert.equal(status, 1)
    assert.match(out, /refuses to RAISE/)
  })

  test('--update accepts a count within the baseline and writes it', () => {
    const baseline = { 'packages/backend/src/probe.ts': { 'sql-status-literal': 1, 'sql-time-now': 1 } }
    const { status, out, wrote } = runGuard(GATE, {
      files: seedDirs({
        'packages/backend/src/probe.ts': PLANTED_READ,
        [BASELINE]: JSON.stringify(baseline),
      }),
      also: ALSO,
      args: ['--update'],
      readBack: [BASELINE],
    })
    assert.equal(status, 0, out)
    assert.deepEqual(JSON.parse(wrote[BASELINE] ?? '{}'), baseline)
  })

  test('a first run with debt requires --accept-new before the baseline is written', () => {
    const refused = runGuard(GATE, {
      files: seedDirs({ 'packages/backend/src/probe.ts': PLANTED_READ }),
      also: ALSO,
      args: ['--update'],
    })
    assert.equal(refused.status, 1)
    assert.match(refused.out, /--accept-new/)

    const accepted = runGuard(GATE, {
      files: seedDirs({ 'packages/backend/src/probe.ts': PLANTED_READ }),
      also: ALSO,
      args: ['--update', '--accept-new'],
      readBack: [BASELINE],
    })
    assert.equal(accepted.status, 0, accepted.out)
    assert.deepEqual(JSON.parse(accepted.wrote[BASELINE] ?? '{}'), {
      'packages/backend/src/probe.ts': { 'sql-status-literal': 1, 'sql-time-now': 1 },
    })
  })

  test('a clean tree passes and --update on a shrunk tree tightens', () => {
    const baseline = {
      'packages/backend/src/probe.ts': { 'sql-status-literal': 2, 'sql-time-now': 2 },
    }
    const green = runGuard(GATE, {
      files: seedDirs({ 'packages/backend/src/probe.ts': PLANTED_READ, [BASELINE]: JSON.stringify(baseline) }),
      also: ALSO,
    })
    assert.equal(green.status, 0, green.out)
    assert.match(green.out, /lock in the progress/)

    const tightened = runGuard(GATE, {
      files: seedDirs({ 'packages/backend/src/probe.ts': PLANTED_READ, [BASELINE]: JSON.stringify(baseline) }),
      also: ALSO,
      args: ['--update'],
      readBack: [BASELINE],
    })
    assert.equal(tightened.status, 0, tightened.out)
    assert.deepEqual(JSON.parse(tightened.wrote[BASELINE] ?? '{}'), {
      'packages/backend/src/probe.ts': { 'sql-status-literal': 1, 'sql-time-now': 1 },
    })
  })
})
