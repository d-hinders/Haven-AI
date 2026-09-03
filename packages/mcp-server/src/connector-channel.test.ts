import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The hosted server's connector channel (#2423).
 *
 * Unlike the published packages, this one is DEPLOYED — so its channel is read
 * from `HAVEN_CONNECTOR_CHANNEL` at module load rather than baked in at
 * release. These tests exercise that by actually loading the module under a
 * given environment, because the question is what the process resolves at
 * boot, and only booting it answers that.
 *
 * Nothing here asserts what any real deployment sets. Setting the variable on
 * any environment is an operator action (epic #2420, operator step 3) that no
 * test can see and none of these tests claim has happened.
 */

// Each case reloads the module graph so the env is read at module load, which
// is the behaviour under test. A cold transform of the SDK + server module
// graph exceeds vitest's 5s default on its own, so these carry an explicit
// budget — without it the suite goes red on transform time rather than on any
// assertion (observed in review).
const RELOAD_TIMEOUT_MS = 30_000

async function loadWithChannel(value?: string) {
  vi.resetModules()
  if (value === undefined) vi.stubEnv('HAVEN_CONNECTOR_CHANNEL', '')
  else vi.stubEnv('HAVEN_CONNECTOR_CHANNEL', value)
  return {
    channel: await import('./connector-channel.js'),
    server: await import('./server.js'),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('hosted connector channel', () => {
  it('falls back to the SDK build channel when the variable is unset', async () => {
    const { channel, server } = await loadWithChannel(undefined)
    expect(channel.HOSTED_CONNECTOR_CHANNEL).toBe('alpha')
    expect(channel.hostedConnectorRerunCommand()).toBe('npx @haven_ai/connect@alpha')
    // Characterization of the instructions line as it stood before #2423 —
    // an unconfigured deployment says exactly what it said yesterday.
    expect(server.HOSTED_INSTRUCTIONS).toContain(
      'npx @haven_ai/connect@alpha; nothing has been spent at that point.',
    )
  }, RELOAD_TIMEOUT_MS)

  it('takes the channel from the environment, and the instructions follow it', async () => {
    const { channel, server } = await loadWithChannel('dev')
    expect(channel.HOSTED_CONNECTOR_CHANNEL).toBe('dev')
    expect(server.HOSTED_INSTRUCTIONS).toContain(
      'npx @haven_ai/connect@dev; nothing has been spent at that point.',
    )
    // The literal that used to be hard-coded must be GONE, not merely joined by
    // a second one: a hint naming both channels is worse than either.
    expect(server.HOSTED_INSTRUCTIONS).not.toContain('connect@alpha')
  }, RELOAD_TIMEOUT_MS)

  it('carries the environment channel into the signer-compatibility advisory', async () => {
    // This is the string a paying agent meets on a version-mismatch refusal,
    // and it is the one place the hosted server and the LOCAL signer are meant
    // to give the same advice. On a dev deployment they legitimately differ by
    // channel — which is the point of the epic, not a regression.
    vi.resetModules()
    vi.stubEnv('HAVEN_CONNECTOR_CHANNEL', 'dev')
    const { signerCompatibilityNotice } = await import('./tools.js')
    const compat = signerCompatibilityNotice(2)
    expect(compat.check).toContain('npx @haven_ai/connect@dev')
    expect(compat.check).not.toContain('connect@alpha')
    expect(compat.fallback).toContain('npx @haven_ai/connect@dev')
    expect(compat.fallback).not.toContain('connect@alpha')
  }, RELOAD_TIMEOUT_MS)

  it('treats an empty or whitespace value as unset', async () => {
    for (const blank of ['', '   ']) {
      const { channel } = await loadWithChannel(blank)
      expect(channel.HOSTED_CONNECTOR_CHANNEL).toBe('alpha')
    }
  }, RELOAD_TIMEOUT_MS)

  it('REFUSES to load on a malformed value rather than serving the production hint', async () => {
    vi.resetModules()
    vi.stubEnv('HAVEN_CONNECTOR_CHANNEL', 'DEV;rm -rf /')
    await expect(import('./connector-channel.js')).rejects.toThrow(/not a valid npm dist-tag/)
  }, RELOAD_TIMEOUT_MS)
})
