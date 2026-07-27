// The invariants the passport receipt's `standingEpoch` documentation leans on
// (#1015). Both were CONVENTION with nothing holding them, which is the same
// defect #1015 fixed one layer up: a property asserted in prose and justified
// by a mechanism that does not exist.
//
// These read source text rather than exercising behaviour. That is deliberate
// and has precedent in this repo (`agent-last-seen.test.ts` asserts on query
// text): the properties are about what every FUTURE writer must do, and no
// runtime test can observe a statement nobody has written yet.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FIND_BY_AGENT_ADDRESS_SQL,
  FIND_BY_ATTESTATION_UID_SQL,
} from '../../../infra/repositories/agent-passports.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
      sourceFiles(full, out)
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('every writer of agents.status also bumps updated_at (#1015)', () => {
  // `standing` is derived from `agents.status` alone, and the receipt's epoch
  // is `agents.updated_at`. So "of two receipts, the one reflecting a revoke
  // carries the higher epoch" holds only while every status writer sets
  // `updated_at` — there is NO trigger on the column. Audited true at the time
  // of writing (revoke, pause, resume, connection-setup cancel and approve);
  // this stops the sixth writer from quietly breaking it.
  it('finds every UPDATE agents ... SET status and requires updated_at alongside', () => {
    const offenders: string[] = []
    let checked = 0

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      // Each `UPDATE agents` statement up to its WHERE (or the end of the
      // template literal), so one statement's SET clause cannot be read as
      // another's.
      for (const m of text.matchAll(/UPDATE\s+agents\b([\s\S]*?)(?:\bWHERE\b|`)/gi)) {
        const setClause = m[1]
        if (!/\bstatus\s*=/i.test(setClause)) continue
        checked += 1
        if (!/\bupdated_at\s*=/i.test(setClause)) {
          offenders.push(`${path.relative(SRC, file)}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`)
        }
      }
    }

    // Guard the guard: if the regex stops matching, this test would pass
    // vacuously and the invariant would be unprotected while looking covered.
    expect(checked).toBeGreaterThanOrEqual(5)
    expect(
      offenders,
      'These statements change agents.status without bumping updated_at. The passport ' +
        "receipt's standingEpoch is agents.updated_at, so a revoke that skips it would not " +
        'order ahead of an earlier receipt. Add `updated_at = NOW()` (see #1015).',
    ).toEqual([])
  })
})

describe('the SQL alias matches the type it is read through (#1015)', () => {
  // Nothing else binds these. Every route-level passport test mocks `db.query`
  // and supplies `record_updated_at` from a fixture, so renaming the alias in
  // SQL alone leaves the suite green while production reads `undefined` — which
  // `verification.ts` converts to a silent `0`, not a crash. db-schema-smoke
  // PREPAREs the statement, proving `a.updated_at` exists, not that it is
  // aliased to the name `VerificationRow` declares.
  it.each([
    ['FIND_BY_AGENT_ADDRESS_SQL', FIND_BY_AGENT_ADDRESS_SQL],
    ['FIND_BY_ATTESTATION_UID_SQL', FIND_BY_ATTESTATION_UID_SQL],
  ])('%s aliases a.updated_at to record_updated_at', (_name, sql) => {
    expect(sql).toMatch(/a\.updated_at\s+AS\s+record_updated_at/i)
    // The old name asserted a precision the column does not carry; it must not
    // come back by a copy-paste from an older branch.
    expect(sql).not.toMatch(/AS\s+standing_changed_at/i)
  })
})
