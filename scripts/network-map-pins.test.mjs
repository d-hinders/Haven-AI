/**
 * #1478 — four hand-rolled network-string → chain-id maps, pinned together.
 * Run with: node --test scripts/network-map-pins.test.mjs
 *
 * WHY A PIN TEST AND NOT A SHARED SOURCE. The obvious fix is one map in
 * `@haven_ai/core` imported everywhere, and it is IMPOSSIBLE for half the
 * maps: `@haven_ai/sdk` and `@haven_ai/signer` are published to npm, while
 * `@haven_ai/core` is a private workspace package that never is — a published
 * package cannot depend on one that does not exist on the registry (CLAUDE.md
 * § Releasing forbids the wildcard-pin workaround in published packages for
 * exactly this reason). So the maps stay separate, and THIS file is what makes
 * separate survivable: any copy drifting from the known shape fails CI.
 *
 * THE FAILURE DIRECTION THIS GUARDS. Widening the backend's gate (a new chain,
 * a new bare alias) is a normal change a backend engineer has no reason to
 * associate with a file in `packages/signer`. If the signer's copy is not
 * widened in the same change, the erc7710 settlement path REFUSES VALID
 * PAYMENTS — an outage dressed as a security feature. This test turns that
 * silent drift into a red build naming every copy that needs the same edit.
 *
 * Source text is parsed rather than imported, following dep-lint /
 * db-mock-ratchet / lint-wire-types: several maps are module-private, and
 * `node --test` cannot import the packages' TypeScript anyway.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/**
 * The vocabulary every map must draw from. A NEW bare alias added anywhere
 * fails until it is added here — which is the moment the author is forced to
 * look at this file and see which other copies need the same alias.
 */
const KNOWN_ALIASES = { base: 8453, 'base-sepolia': 84532 }

/**
 * KNOWN divergences between the client-side maps and the backend gate.
 * EMPTY since #1471: 'base-sepolia' is a canonical identifier in the x402
 * spec's NetworkSchema enum, so the backend was wrong to reject it and now
 * maps it. Any entry appearing here again is a decision to record, not a
 * default to inherit — #1471 is the precedent for how one gets resolved.
 */
const DOCUMENTED_DIVERGENCE = []

/** Extract `if (network === '<alias>') return <id>` pairs from a function body. */
function bareAliasesFromConditionals(source, fnName) {
  const start = source.indexOf(fnName)
  assert.notEqual(start, -1, `${fnName} not found — the map moved; update this pin test`)
  const body = source.slice(start, start + 900)
  const aliases = {}
  for (const m of body.matchAll(/network === '([a-z0-9-]+)'\) return (\d+)/g)) {
    aliases[m[1]] = Number(m[2])
  }
  return { aliases, caip: /eip155:/.test(body) }
}

/** Extract the bare (non-eip155) keys of an object-literal map. */
function bareKeysFromObjectLiteral(source, constName) {
  const start = source.indexOf(constName)
  assert.notEqual(start, -1, `${constName} not found — the map moved; update this pin test`)
  const open = source.indexOf('{', start)
  const body = source.slice(open, source.indexOf('}', open))
  const keys = []
  for (const m of body.matchAll(/'([a-z0-9:-]+)':/g)) {
    if (!m[1].startsWith('eip155:')) keys.push(m[1])
  }
  return keys
}

const backend = bareAliasesFromConditionals(
  read('packages/backend/src/modules/x402/helpers.ts'),
  'function chainIdFromX402Network',
)
// #1618 moved this map out of client.ts into the scheme-neutral x402
// protocol module. The pin follows the map, not the file it used to sit in.
const sdkClient = bareAliasesFromConditionals(
  read('packages/sdk/src/x402-protocol.ts'),
  'function chainIdFromNetwork',
)
const signer = bareAliasesFromConditionals(
  read('packages/signer/src/settlement-child.ts'),
  'function chainIdForNetwork',
)
const supportedKeys = bareKeysFromObjectLiteral(
  read('packages/sdk/src/x402.ts'),
  'SUPPORTED_X402_NETWORKS',
)
const standardKeys = bareKeysFromObjectLiteral(
  read('packages/sdk/src/x402.ts'),
  'STANDARD_X402_NETWORKS',
)

test('every bare alias in every map comes from the known vocabulary', () => {
  const all = [
    ...Object.keys(backend.aliases),
    ...Object.keys(sdkClient.aliases),
    ...Object.keys(signer.aliases),
    ...supportedKeys,
    ...standardKeys,
  ]
  for (const alias of all) {
    assert.ok(
      alias in KNOWN_ALIASES,
      `'${alias}' is not in KNOWN_ALIASES — a new alias must be added to every copy that ` +
        'should accept it, and to this table, in the same change',
    )
  }
})

test('shared aliases resolve to the same chain id everywhere', () => {
  for (const [alias, id] of Object.entries(KNOWN_ALIASES)) {
    for (const [name, map] of [
      ['backend', backend],
      ['sdk client', sdkClient],
      ['signer', signer],
    ]) {
      if (alias in map.aliases) {
        assert.equal(
          map.aliases[alias],
          id,
          `${name} maps '${alias}' to ${map.aliases[alias]}, expected ${id} — ` +
            'two copies now disagree about which CHAIN a string means, which is worse than drift',
        )
      }
    }
  }
})

test('all three functions accept the eip155: CAIP form', () => {
  // The caip branch is the one shape all four agree on; losing it in any copy
  // would reject every network string the backend itself emits on replay.
  assert.ok(backend.caip, 'backend gate lost its eip155: branch')
  assert.ok(sdkClient.caip, 'sdk client lost its eip155: branch')
  assert.ok(signer.caip, 'signer lost its eip155: branch')
})

test('the backend gate is the narrowest map, and the divergence is exactly the documented one', () => {
  // Direction, not equality (the handoff's decision point 1, answered
  // explicitly): the SDK/signer may accept MORE than the backend — that is
  // #1471's open question — but the excess must be exactly what is documented.
  // A new excess alias, or the backend widening past a client copy, fails.
  const backendSet = new Set(Object.keys(backend.aliases))
  const clientSide = new Set([
    ...Object.keys(sdkClient.aliases),
    ...Object.keys(signer.aliases),
    ...supportedKeys,
    ...standardKeys,
  ])
  const divergence = [...clientSide].filter((a) => !backendSet.has(a)).sort()
  assert.deepEqual(
    divergence,
    [...DOCUMENTED_DIVERGENCE].sort(),
    'the client-side maps accept bare aliases the backend gate rejects, beyond the ' +
      'documented #1471 divergence — either widen the backend in the same change, or ' +
      'do not accept the alias client-side',
  )
  for (const alias of backendSet) {
    assert.ok(
      alias in signer.aliases && alias in sdkClient.aliases,
      `backend accepts '${alias}' but a client-side function does not — the erc7710 ` +
        'settlement path would refuse a valid payment (#1478, the failure this file exists for)',
    )
  }
})

test('Gnosis stays out of the bare-alias vocabulary — CAIP-only, like-for-like', () => {
  // eip155:100 legitimately appears in SUPPORTED (display) and not in the
  // standard-scheme set; that scope difference is fine. What must NOT happen
  // is a bare 'gnosis' alias appearing in one copy only. The vocabulary test
  // above enforces it; this records WHY the vocabulary has two entries.
  assert.equal(Object.keys(KNOWN_ALIASES).length, 2)
})
