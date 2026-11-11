#!/usr/bin/env node
// Runtime import-cycle lint across the eleven packages `dep-lint` does not
// scan (#4763).
//
// Rule 7 of docs/architecture/10-module-boundaries.md — "the graph is
// acyclic", the one unwaivable rule — was checked on two of the thirteen
// packages: scripts/dep-lint.mjs's SCAN_ROOTS lists packages/backend/src and
// packages/core/src, and nothing else. The other eleven were unchecked, and
// one of them held a real runtime cycle:
//
//   packages/sdk/src/merchant-answer.ts   imports parseMerchantSettlement
//   packages/sdk/src/merchant-completion.ts imports decidePostFundingMerchantAnswer
//
// This pass is the RUNTIME half of rule 7, by owner decision (2026-11-10):
// **type-only imports are not edges here.** The repo's own ruleset counts them
// (.dependency-cruiser.cjs sets tsPreCompilationDeps: true), which is why the
// same tree reports ten cycles under that setting and one under this one. The
// nine type-only cycles are known and deliberately unenforced; the
// architecture doc lists them. backend and core keep the strict definition
// through `npm run lint:deps`, so rule 7 has two meanings and the doc says so.
//
// Two things this pass does that the backend gate does not need to:
//
//   - it resolves each package's OWN tsconfig.json, so the frontend's `@/`
//     alias is a real edge rather than an unresolved specifier. That requires
//     running the cruiser with the package directory as the working directory:
//     TypeScript resolves a tsconfig's `include`/`paths` against the process
//     cwd, so from the repo root the frontend's config matches no inputs
//     (TS18003) and every `@/` import comes back `couldNotResolve`.
//   - it reads `.tsx` as well as `.ts` — 253 of the frontend's source files
//     are components, and a cycle through a component is a cycle.
//
// Like `no-circular` everywhere else, this pass is UNWAIVABLE: a
// `// dep-lint-exempt` comment does not silence it, and the live-scan test
// pins that.
//
//   node scripts/dep-cycles.mjs

import { readdir, stat } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cruise } from 'dependency-cruiser'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The packages `npm run lint:deps` already polices under the STRICT definition
 * (type-only imports counted). They are excluded here so the two gates never
 * disagree about the same tree: backend and core are the strict half of rule 7.
 */
export const STRICT_PACKAGES = Object.freeze(['backend', 'core'])

/**
 * Production structure only, exactly as the backend gate reads it: tests
 * legitimately reach past boundaries, and a cycle through a test file is not a
 * cycle in the shipped graph. `.d.ts` files carry no runtime edge at all.
 */
export const EXCLUDE_PATH =
  '(/__tests__/|\\.test\\.tsx?$|\\.parity\\.test\\.ts$|/e2e/|\\.d\\.ts$|/dist/|/\\.next/|/node_modules/)'

/** The exclude pattern as a matcher, for the file walk. */
export const EXCLUDED = new RegExp(EXCLUDE_PATH)

/**
 * The one rule this pass enforces. `tsPreCompilationDeps: false` is the whole
 * owner decision: dependency-cruiser then drops edges that exist only at
 * compile time, so `import type { X } from './y.js'` is not a dependency.
 */
export const CYCLE_RULESET = Object.freeze({
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'This dependency is part of a runtime cycle. Cycles are defects regardless of intent — ' +
        'break it by moving the shared piece into a leaf module both sides can import.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: EXCLUDE_PATH },
    tsPreCompilationDeps: false,
  },
})

async function walk(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    else if (/\.tsx?$/.test(e.name) && !EXCLUDED.test(full.split(sep).join('/'))) out.push(full)
  }
  return out
}

/**
 * The packages this pass polices: every workspace with a `src/` directory,
 * minus the two the strict gate owns. DERIVED rather than listed, so a new
 * package is covered the day it lands instead of the day someone remembers
 * this file — the failure mode #982's chain-SDK lesson is about. The
 * self-test pins the resulting set, so a package silently losing its `src/`
 * fails there rather than shrinking this pass in silence.
 */
export async function discoverPackages(root = REPO_ROOT) {
  const packagesDir = join(root, 'packages')
  let entries
  try {
    entries = await readdir(packagesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const e of entries) {
    if (!e.isDirectory() || STRICT_PACKAGES.includes(e.name)) continue
    try {
      if (!(await stat(join(packagesDir, e.name, 'src'))).isDirectory()) continue
    } catch {
      continue
    }
    found.push(e.name)
  }
  return found.sort()
}

/** The eleven packages, resolved once at import time. */
export const CYCLE_SCAN_PACKAGES = Object.freeze(await discoverPackages())

/**
 * Scan one package's `src` for runtime cycles.
 *
 * Returns `{package, files, tsxFiles, aliasEdges, cycles}` where `files` are
 * repo-relative, `aliasEdges` are the `@/`-prefixed imports that RESOLVED to a
 * real file (the proof the package's tsconfig was applied), and `cycles` are
 * `{from, to}` pairs in repo-relative paths.
 */
export async function scanPackage(pkg, { root = REPO_ROOT } = {}) {
  const pkgDir = join(root, 'packages', pkg)
  const files = []
  await walk(join(pkgDir, 'src'), files)
  files.sort()
  const rel = files.map((f) => relative(pkgDir, f).split(sep).join('/'))
  const empty = { package: pkg, files: [], tsxFiles: 0, aliasEdges: [], cycles: [] }
  if (rel.length === 0) return empty

  const options = { ...CYCLE_RULESET.options }
  // A package without a tsconfig has no aliases to resolve; passing a missing
  // file would make the cruiser throw instead of scanning.
  try {
    if ((await stat(join(pkgDir, 'tsconfig.json'))).isFile()) options.tsConfig = { fileName: 'tsconfig.json' }
  } catch {
    // no tsconfig — scan without one
  }

  // TypeScript resolves a tsconfig's `include` and `paths` against the process
  // cwd, so the cruiser has to run FROM the package directory (see the header).
  const cwd = process.cwd()
  let report
  try {
    process.chdir(pkgDir)
    const { output } = await cruise(rel, {
      ...options,
      ruleSet: { forbidden: CYCLE_RULESET.forbidden },
      outputType: 'json',
      validate: true,
    })
    report = typeof output === 'string' ? JSON.parse(output) : output
  } finally {
    process.chdir(cwd)
  }

  const prefix = (p) => `packages/${pkg}/${p}`
  const cycles = report.summary.violations
    .filter((v) => v.rule.name === 'no-circular')
    .map((v) => ({ from: prefix(v.from), to: prefix(v.to) }))
  const aliasEdges = []
  for (const m of report.modules) {
    for (const d of m.dependencies ?? []) {
      if (d.module?.startsWith('@/') && !d.couldNotResolve) {
        aliasEdges.push({ from: prefix(m.source), module: d.module, resolved: prefix(d.resolved) })
      }
    }
  }
  return {
    package: pkg,
    files: rel.map(prefix),
    tsxFiles: rel.filter((f) => f.endsWith('.tsx')).length,
    aliasEdges,
    cycles,
  }
}

/**
 * Scan every package this pass polices, in name order.
 *
 * SEQUENTIAL on purpose: `scanPackage` changes the process working directory
 * for the duration of its cruise (see the header), so two scans must never
 * overlap. A `Promise.all` here would have them fight over the cwd and resolve
 * one package's aliases against another's tsconfig.
 */
export async function scanAll({ packages = CYCLE_SCAN_PACKAGES, root = REPO_ROOT } = {}) {
  const results = []
  for (const pkg of packages) results.push(await scanPackage(pkg, { root }))
  return results
}

async function main() {
  const results = await scanAll()
  let cycles = 0
  let files = 0
  for (const r of results) {
    files += r.files.length
    cycles += r.cycles.length
    console.log(
      `${r.package}: ${r.files.length} source file(s), ${r.tsxFiles} .tsx, ` +
        `${r.aliasEdges.length} resolved @/ alias edge(s), ${r.cycles.length} runtime cycle(s)`,
    )
    for (const c of r.cycles) console.log(`  ✗ ${c.from} → ${c.to}`)
  }

  if (cycles > 0) {
    console.log(
      `\n✗ ${cycles} runtime import cycle(s) across ${results.length} package(s). ` +
        'A cycle makes a module impossible to test in isolation, split, or delete from. ' +
        'Break it by moving the shared piece into a leaf both sides can import — ' +
        '`no-circular` can never be waived.',
    )
    process.exit(1)
  }

  console.log(
    `✓ No runtime import cycles across ${results.length} package(s) (${files} source files). ` +
      'Type-only imports are not edges here — see docs/architecture/10-module-boundaries.md rule 7.',
  )
}

// True only when this file is the process's entry point, so importing it (a
// self-test) never runs the CLI. Both paths are resolved before they are
// compared: Node resolves symlinks for a module's own URL and not for
// `process.argv[1]`, so an unresolved comparison is false through any symlink,
// and the script would exit 0 without running (#4776).
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
