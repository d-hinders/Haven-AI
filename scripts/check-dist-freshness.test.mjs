// Unit tests for the stale-dist guard (#1188).
// Run with: node --test scripts/check-dist-freshness.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatStale } from './check-dist-freshness.mjs'

test('a fresh dist produces no message', () => {
  assert.equal(formatStale([{ pkg: 'signer', state: 'fresh', srcMs: 1, distMs: 2 }]), null)
})

test('a MISSING dist is not reported — it fails loudly at import on its own', () => {
  // The guard exists for the SILENT failure. A missing dist throws
  // "Cannot find module" the moment anything imports it, which needs no help.
  assert.equal(formatStale([{ pkg: 'signer', state: 'missing', srcMs: 1, distMs: null }]), null)
})

test('a stale dist names the package and the exact fix command', () => {
  const day = 86_400_000
  const msg = formatStale([{ pkg: 'signer', state: 'stale', srcMs: 30 * day, distMs: 2 * day }])
  assert.match(msg, /packages\/signer/)
  assert.match(msg, /28 day\(s\) behind/)
  // The message must carry the remedy: this fires while someone is debugging
  // something that looks like a protocol error, and "rebuild" is not obvious.
  assert.match(msg, /npm run build -w packages\/signer/)
})

test('several stale packages are listed together, with one combined fix', () => {
  const day = 86_400_000
  const msg = formatStale([
    { pkg: 'signer', state: 'stale', srcMs: 10 * day, distMs: 1 * day },
    { pkg: 'fresh-one', state: 'fresh', srcMs: 1, distMs: 2 },
    { pkg: 'mcp', state: 'stale', srcMs: 10 * day, distMs: 3 * day },
  ])
  assert.match(msg, /packages\/signer/)
  assert.match(msg, /packages\/mcp/)
  assert.doesNotMatch(msg, /fresh-one/)
  assert.match(msg, /npm run build -w packages\/signer && npm run build -w packages\/mcp/)
})

test('equal timestamps count as fresh — a rebuild that touched nothing is not stale', () => {
  assert.equal(formatStale([{ pkg: 'sdk', state: 'fresh', srcMs: 5, distMs: 5 }]), null)
})
