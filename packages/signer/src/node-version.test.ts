import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { HAVEN_MINIMUM_NODE_VERSION } from '@haven_ai/sdk'
import {
  assertSupportedNodeVersion,
  resolveEdgeSigner,
  resolveSignerRuntime,
  runSignerStdioServer,
} from './index.js'

const DELEGATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'

describe('signer Node floor (#1161)', () => {
  it("matches this package's declared engines.node", () => {
    const engines = createRequire(import.meta.url)('../package.json').engines as { node?: string }
    expect(engines.node).toBe(`>=${HAVEN_MINIMUM_NODE_VERSION.split('.')[0]}`)
  })

  it('refuses to start below the floor', () => {
    // Asserted at STARTUP, not only at install: a user can upgrade Node,
    // connect, then downgrade — or a version manager can hand the agent runtime
    // a different Node than the shell that ran setup. Only a startup check sees
    // the version this process is actually running on.
    expect(() => assertSupportedNodeVersion('23.1.0')).toThrow(/requires Node\.js >=24\.0\.0/)
    expect(() => assertSupportedNodeVersion('20.0.0')).toThrow(/The Haven signer/)
  })

  it('carries a machine-readable code', () => {
    const err = catchError(() => assertSupportedNodeVersion('20.0.0'))
    expect((err as NodeJS.ErrnoException).code).toBe('HAVEN_SIGNER_UNSUPPORTED_NODE')
  })

  it('allows the floor and above', () => {
    expect(() => assertSupportedNodeVersion('24.0.0')).not.toThrow()
    expect(() => assertSupportedNodeVersion('25.2.0')).not.toThrow()
  })

  it('refuses before the delegate key is read from disk', async () => {
    // Ordering is the point: an unsupported runtime must not be the thing that
    // first touches the signing key. `credentialsPath` points at a file that
    // does not exist, so if the guard ran late this would fail with an ENOENT
    // about the credential rather than the Node refusal.
    await expect(
      runSignerStdioServer({
        credentialsPath: '/nonexistent/haven/signer.json',
        nodeVersion: '23.1.0',
      }),
    ).rejects.toThrow(/requires Node\.js >=24\.0\.0/)
  })

  // Guarding only the stdio entrypoint would have reproduced #1161 itself one
  // layer down: a guard that exists but sits on one path while another reaches
  // the delegate key unchecked. These are the OTHER public ways to get a
  // key-bound signer out of this package — the `skipConsent` docs invite
  // controlled embedding, so they are a supported surface, not a test seam.
  describe('every key-bound entry point is guarded, not just the stdio server', () => {
    it('refuses in resolveSignerRuntime', async () => {
      await expect(
        resolveSignerRuntime({ credentialsPath: '/nonexistent/haven/signer.json', nodeVersion: '23.1.0' }),
      ).rejects.toThrow(/requires Node\.js >=24\.0\.0/)
    })

    it('refuses in resolveEdgeSigner', async () => {
      await expect(
        resolveEdgeSigner({ credentialsPath: '/nonexistent/haven/signer.json', nodeVersion: '23.1.0' }),
      ).rejects.toThrow(/requires Node\.js >=24\.0\.0/)
    })

    it('refuses even on the pre-resolved delegateKey fast path', async () => {
      // This branch never loads a credential file, so a guard placed after the
      // load would miss it entirely — and it is the branch that hands back a
      // working signer with the least ceremony.
      await expect(
        resolveSignerRuntime({ delegateKey: DELEGATE_KEY, nodeVersion: '23.1.0' }),
      ).rejects.toThrow(/requires Node\.js >=24\.0\.0/)
    })

    it('still builds a signer on a supported Node', async () => {
      const { signer } = await resolveSignerRuntime({ delegateKey: DELEGATE_KEY, nodeVersion: '24.0.0' })
      expect(signer).toBeDefined()
    })
  })
})

function catchError(fn: () => void): unknown {
  try {
    fn()
    throw new Error('expected a throw')
  } catch (err) {
    return err
  }
}
