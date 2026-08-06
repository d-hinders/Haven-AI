import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrations } from '../migrations/index.js'

/**
 * The migration registry is a hand-maintained array, so a new migration FILE is
 * inert until someone also adds it to `migrations/index.ts`. Nothing caught
 * that: migration 050 shipped unregistered and every test stayed green, because
 * tests mock `pg` and never apply a schema.
 *
 * It surfaced only by luck — the same PR happened to add `db:schema-smoke`
 * queries using the new columns, which failed in CI. Without that coincidence
 * an unregistered migration reaches production as "the column does not exist",
 * at runtime, on whatever code path needed it first.
 *
 * These tests make the file system the source of truth and the registry the
 * thing that must agree with it.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** Every `NNN_name.ts` in the directory — `index.ts` and tests excluded. */
function migrationFileVersions(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort()
}

describe('migration registry', () => {
  it('REGISTERS every migration file — an unregistered one never runs', () => {
    const onDisk = migrationFileVersions()
    const registered = migrations.map((m) => m.version).sort()
    expect(registered).toEqual(onDisk)
  })

  it('has no registered migration without a file', () => {
    // The other direction: a rename or delete that left the import dangling
    // would fail at import, but a version string that no longer matches its
    // filename would silently re-run or skip.
    const onDisk = new Set(migrationFileVersions())
    const orphans = migrations.map((m) => m.version).filter((v) => !onDisk.has(v))
    expect(orphans).toEqual([])
  })

  it('runs in sorted order — the table is applied in the order listed', () => {
    // `migrate.ts` executes the array as given, so a misplaced entry applies a
    // later migration before an earlier one it depends on.
    const versions = migrations.map((m) => m.version)
    expect(versions).toEqual([...versions].sort())
  })

  it('has unique versions — the applied-set is keyed by version', () => {
    const versions = migrations.map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('every migration exposes an `up`', () => {
    const broken = migrations.filter((m) => typeof m.up !== 'function').map((m) => m.version)
    expect(broken).toEqual([])
  })
})
