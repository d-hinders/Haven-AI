// Regression guard for the narrow irreversible-schema CODEOWNERS rule (#2698).
//
// GitHub, not this test, is the authority that evaluates CODEOWNERS patterns.
// The required live positive/negative PR evidence for #2698 verifies that
// behavior before this change merges. This guard deliberately pins the reviewed rule so a future broad
// directory pattern or a removed rule cannot silently reintroduce the false
// positive (or remove protection for real migration implementations).
//
// Run with: node --test scripts/ci/codeowners.test.mjs
// (also collected by the ci_config_checks job's scripts/ci/*.test.mjs glob)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CODEOWNERS = path.join(ROOT, '.github/CODEOWNERS')
const OWNERS = '@d-hinders @AntonioSaaranen @PhilipEriksson'
const MIGRATION_RULE = '/packages/backend/src/db/migrations/*.ts'

test('CODEOWNERS gates direct migration implementations, not their test subtree (#2698)', () => {
  const rules = readFileSync(CODEOWNERS, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  assert.deepEqual(
    rules,
    [`${MIGRATION_RULE}   ${OWNERS}`],
    'CODEOWNERS must retain only the reviewed direct-file migration rule. ' +
      'Do not broaden it to the migrations directory: GitHub then includes ' +
      '__tests__/ and requires code-owner approval for non-schema test changes. ' +
      'Do not remove it: real migration implementations need independent review.',
  )
})
