import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constraintLookups, isScoped } from './lint-migration-constraint-scope.mjs'

// The gate reports on a repo that is currently clean, so running it proves
// nothing about whether it CAN fail — neutering `isScoped` to `return true`
// leaves it green (measured). These fixtures are the part that can go red.

test('catches the single-line shape (the four original sites)', () => {
  const src = `
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'x'
      ) THEN
        ALTER TABLE t ADD CONSTRAINT x UNIQUE (a);
      END IF;
    END $$;`
  const found = constraintLookups(src)
  assert.equal(found.length, 1)
  assert.equal(isScoped(found[0].body), false)
})

test('catches the MULTI-LINE shape — the one a line-oriented grep missed', () => {
  // 018_machine_payment_approval_evidence_refs.ts verbatim in shape. The
  // hand-written grep that claimed "zero remaining" was line-anchored and
  // could not see this, and that claim reached a regulatory changelog shard.
  const src = `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'machine_payment_evidence_one_payment_reference'
      ) THEN
        ALTER TABLE machine_payment_evidence ADD CONSTRAINT ...;
      END IF;
    END $$;`
  const found = constraintLookups(src)
  assert.equal(found.length, 1)
  assert.equal(isScoped(found[0].body), false)
})

test('accepts a conrelid anchor', () => {
  const src = `
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'x' AND c.conrelid = 't'::regclass
      ) THEN`
  assert.equal(isScoped(constraintLookups(src)[0].body), true)
})

test('accepts a current_schema() anchor', () => {
  const src = `
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.conname = 'x' AND n.nspname = current_schema()
      ) THEN`
  assert.equal(isScoped(constraintLookups(src)[0].body), true)
})

test('a scoped and an unscoped lookup in one file are told apart', () => {
  // The failure mode a whole-file boolean would have: one good site vouching
  // for a bad one.
  const src = `
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conname = 'a' AND c.conrelid = 't'::regclass
      ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'b'
      ) THEN`
  const found = constraintLookups(src)
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((f) => isScoped(f.body)), [true, false])
})

test('POSITIVE CONTROL: the extractor finds nothing in SQL that has no lookup', () => {
  // Without this, an extractor that returned [] for everything would satisfy
  // every "unscoped === false" assertion above by finding nothing at all.
  assert.deepEqual(constraintLookups('ALTER TABLE t ADD COLUMN c text;'), [])
})
