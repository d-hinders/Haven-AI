import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const PACKAGES = [
  'packages/backend/package.json',
  'packages/demo-merchant-mcp/package.json',
  'packages/frontend/package.json',
  'packages/mcp-server/package.json',
  'packages/qa-agent/package.json',
  'packages/sdk/package.json',
  'packages/signer/package.json',
]

function readPackage(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

describe('direct viem dependency parity', () => {
  test('Haven packages use one exact viem version for typed-data hashing/signing', () => {
    const versions = PACKAGES.map((relativePath) => {
      const pkg = readPackage(relativePath)
      const version = pkg.dependencies?.viem ?? pkg.devDependencies?.viem
      assert.ok(version, `${relativePath} must declare viem directly`)
      assert.doesNotMatch(version, /^[~^]/, `${relativePath} must exact-pin viem, not use ${version}`)
      return [relativePath, version]
    })

    const uniqueVersions = new Set(versions.map(([, version]) => version))
    assert.deepEqual(
      [...uniqueVersions],
      ['2.54.1'],
      `direct viem versions drifted:\n${versions.map(([pathName, version]) => `${pathName}: ${version}`).join('\n')}`,
    )
  })
})
