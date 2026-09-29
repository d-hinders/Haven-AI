import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_VERSION_CONSTANT_FILES, versionConstantPattern } from './release-version-constants.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The release bump dies half-way when a constant it owns has moved: #3454 moved
// SIGNER_VERSION from signer/src/server.ts into tools.ts, and the next bump
// stopped after rewriting the package.json files. Each entry must name the file
// that DECLARES the constant, exactly once — a re-export does not count.
for (const [name, rel] of SOURCE_VERSION_CONSTANT_FILES) {
  test(`${name} is declared in ${rel}, where release-bump rewrites it`, () => {
    const source = readFileSync(join(ROOT, rel), 'utf8')
    const all = new RegExp(versionConstantPattern(name).source, 'gm')
    assert.equal(
      (source.match(all) ?? []).length,
      1,
      `${rel} must declare \`export const ${name} = '...'\` exactly once`,
    )
  })
}

test('the pattern rejects a re-export and accepts the declaration', () => {
  const re = versionConstantPattern('SIGNER_VERSION')
  assert.equal(re.test('export { SIGNER_NAME, SIGNER_VERSION }\n'), false)
  assert.equal(re.test("export const SIGNER_VERSION = '0.6.0-alpha.0'\n"), true)
})
