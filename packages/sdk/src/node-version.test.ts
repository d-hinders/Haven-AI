import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  HAVEN_MINIMUM_NODE_VERSION,
  compareNodeVersions,
  isSupportedNodeVersion,
  unsupportedNodeVersionMessage,
} from './node-version.js'

const require = createRequire(import.meta.url)

describe('HAVEN_MINIMUM_NODE_VERSION', () => {
  it("matches this package's declared engines.node floor", () => {
    // The drift guard (#1161). `engines` said >=24 while connect's runtime
    // manifest enforced 20.0.0, so the guard meant to hold the floor waved
    // Node v23 through, installed the signer, and signed a real payment. Two
    // numbers for one fact is one too many — this pins them together.
    const engines = require('../package.json').engines as { node?: string }
    expect(engines.node).toBe(`>=${major(HAVEN_MINIMUM_NODE_VERSION)}`)
  })
})

describe('compareNodeVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareNodeVersions('24.0.0', '24.0.0')).toBe(0)
    expect(compareNodeVersions('24.1.0', '24.0.9')).toBeGreaterThan(0)
    expect(compareNodeVersions('23.11.0', '24.0.0')).toBeLessThan(0)
    expect(compareNodeVersions('24.0.1', '24.0.0')).toBeGreaterThan(0)
  })

  it('accepts a leading v and partial versions', () => {
    expect(compareNodeVersions('v24.0.0', '24')).toBe(0)
    expect(compareNodeVersions('v24', '24.0.0')).toBe(0)
  })
})

describe('isSupportedNodeVersion', () => {
  it('accepts the floor and anything above it', () => {
    expect(isSupportedNodeVersion('24.0.0')).toBe(true)
    expect(isSupportedNodeVersion('24.3.1')).toBe(true)
    expect(isSupportedNodeVersion('25.0.0')).toBe(true)
  })

  it('rejects everything below the floor, including the observed v23.1.0', () => {
    // v23.1.0 is the version from the #1161 report: a full connect completed
    // "successfully" on it and the signer produced a real testnet signature.
    expect(isSupportedNodeVersion('23.1.0')).toBe(false)
    expect(isSupportedNodeVersion('20.0.0')).toBe(false)
    expect(isSupportedNodeVersion('18.19.0')).toBe(false)
  })

  it('fails closed on an unparseable version', () => {
    // A version string Haven cannot read is not evidence of a supported
    // runtime. Treating it as one would reopen the hole this closes.
    expect(isSupportedNodeVersion('not-a-version')).toBe(false)
    expect(isSupportedNodeVersion('')).toBe(false)
  })
})

describe('unsupportedNodeVersionMessage', () => {
  it('names the subject, the detected version, and the required version', () => {
    const message = unsupportedNodeVersionMessage({
      subject: 'Haven setup',
      nodeVersion: '23.1.0',
    })
    expect(message).toContain('Haven setup')
    expect(message).toContain('23.1.0')
    expect(message).toContain(`>=${HAVEN_MINIMUM_NODE_VERSION}`)
  })

  it('says what to DO, not only what is wrong', () => {
    // The old message stopped after the two version numbers, which tells a user
    // they are stuck without telling them how to get unstuck.
    const message = unsupportedNodeVersionMessage({
      subject: 'The Haven signer',
      nodeVersion: '23.1.0',
    })
    expect(message).toContain('nvm install 24')
    expect(message).toContain('fnm install 24')
    expect(message).toContain('volta install node@24')
    expect(message).toContain('https://nodejs.org')
  })

  it('warns that the runtime spawning Haven may not be the upgraded shell', () => {
    const message = unsupportedNodeVersionMessage({ subject: 'x', nodeVersion: '20.0.0' })
    expect(message).toMatch(/agent runtime launching Haven/i)
  })

  it('appends a retry hint when given', () => {
    const message = unsupportedNodeVersionMessage({
      subject: 'Haven setup',
      nodeVersion: '20.0.0',
      retryHint: 'Then re-run the connect command from Haven.',
    })
    expect(message.trimEnd().endsWith('Then re-run the connect command from Haven.')).toBe(true)
  })
})

function major(version: string): string {
  return version.split('.')[0] as string
}
