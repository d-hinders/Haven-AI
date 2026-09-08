#!/usr/bin/env node
// `npm run docs:measure` — re-derive every baseline figure in epic #2678.
//
// Four read-only, dependency-free scripts. Nothing here gates; nothing here
// writes. The point is that the epic's numbers are REPRODUCIBLE rather than
// remembered — #2678's § *How to re-run this measurement* described four
// scripts and committed none, so its figures could only be trusted or doubted,
// never checked.
//
// Run one on its own with `node scripts/docs/measure/<name>.mjs`.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = ['corpus-mass.mjs', 'derivable-claims.mjs', 'covers-gaps.mjs', 'correction-rate.mjs']

const head = execFileSync('git', ['-C', join(HERE, '..', '..', '..'), 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()

console.log(`#2678 baseline measurement — HEAD ${head}`)
console.log('Epic baseline was taken on dee89b8e (2026-09-07).')

for (const s of SCRIPTS) {
  execFileSync(process.execPath, [join(HERE, s), ...process.argv.slice(2)], { stdio: 'inherit' })
}
