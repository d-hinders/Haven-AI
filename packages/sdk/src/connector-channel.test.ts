import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_PACKAGE_NAME,
  HAVEN_CONNECTOR_CHANNEL,
  connectorRerunCommand,
  connectorSpec,
  isConnectorChannel,
  resolveConnectorChannel,
} from './connector-channel.js'
import { SIGNER_UPDATE_FALLBACK, signerUpdateFallback } from './types.js'

describe('connector channel constant', () => {
  it('defaults to the production channel', () => {
    // The default IS the production blast radius: everything that does not
    // explicitly pass a channel renders this one, so a silent move here would
    // change what every published package tells a user to install.
    expect(HAVEN_CONNECTOR_CHANNEL).toBe('alpha')
  })

  it('names the connector package and nothing else', () => {
    expect(CONNECTOR_PACKAGE_NAME).toBe('@haven_ai/connect')
    expect(connectorSpec()).toBe('@haven_ai/connect@alpha')
    expect(connectorSpec('dev')).toBe('@haven_ai/connect@dev')
  })
})

describe('connectorRerunCommand', () => {
  it('renders the bare re-run command at the build channel', () => {
    expect(connectorRerunCommand()).toBe('npx @haven_ai/connect@alpha')
  })

  it('appends arguments verbatim', () => {
    expect(connectorRerunCommand('--doctor --repair --runtime')).toBe(
      'npx @haven_ai/connect@alpha --doctor --repair --runtime',
    )
    expect(connectorRerunCommand('--rekey-finish')).toBe('npx @haven_ai/connect@alpha --rekey-finish')
  })

  it('carries npx flags before the spec, where npx wants them', () => {
    expect(connectorRerunCommand('--setup hv_x', { npxFlags: '-y' })).toBe(
      'npx -y @haven_ai/connect@alpha --setup hv_x',
    )
  })

  it('moves the channel token and NOTHING else — the point of #2423', () => {
    // Stated as a diff rather than as two literals, so a change to the
    // surrounding wording fails here instead of passing because both literals
    // were edited together.
    const alpha = connectorRerunCommand('--doctor')
    const dev = connectorRerunCommand('--doctor', { channel: 'dev' })
    expect(dev).toBe('npx @haven_ai/connect@dev --doctor')
    expect(alpha.replace('@alpha', '@dev')).toBe(dev)
  })
})

describe('resolveConnectorChannel', () => {
  it('treats unset, empty and whitespace as unset', () => {
    // A dashboard stores a cleared variable as "", and that must land on the
    // production-safe value rather than on a refusal.
    expect(resolveConnectorChannel(undefined)).toBe('alpha')
    expect(resolveConnectorChannel(null)).toBe('alpha')
    expect(resolveConnectorChannel('')).toBe('alpha')
    expect(resolveConnectorChannel('   ')).toBe('alpha')
  })

  it('accepts a well-formed tag and trims it', () => {
    expect(resolveConnectorChannel('dev')).toBe('dev')
    expect(resolveConnectorChannel(' dev ')).toBe('dev')
    expect(resolveConnectorChannel('next-2')).toBe('next-2')
  })

  it('REFUSES rather than falling back on a malformed value', () => {
    // The whole argument for throwing: a silent fallback would put the
    // production connector in front of a deployment that looks configured.
    expect(() => resolveConnectorChannel('Dev')).toThrow(/not a valid npm/)
    expect(() => resolveConnectorChannel('-dev')).toThrow()
    expect(() => resolveConnectorChannel('9dev')).toThrow()
    expect(() => resolveConnectorChannel('a'.repeat(33))).toThrow()
  })

  it('excludes every shell metacharacter, because the spec is interpolated unquoted', () => {
    // The rendered spec is pasted into a real terminal as `npx <spec> …`.
    // Enumerated rather than described: a pattern change that widened this
    // would otherwise pass a test that only says "rejects bad input".
    for (const bad of [
      'a b', 'a;b', 'a|b', 'a&b', 'a$b', 'a`b', 'a>b', 'a<b', 'a(b', 'a)b', 'a{b', 'a}b',
      'a[b', 'a]b', 'a*b', 'a?b', 'a!b', 'a#b', 'a\\b', 'a/b', 'a@b', 'a:b', 'a"b', "a'b",
      'a\nb', 'a\tb', 'a.b',
    ]) {
      expect(isConnectorChannel(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('a well-formed but WRONG tag is accepted here — the documented limit', () => {
    // `dve` fails later at npx, where the error names the package. Pinned so
    // the limit is a decision on the record rather than an oversight.
    expect(resolveConnectorChannel('dve')).toBe('dve')
  })
})

describe('signerUpdateFallback', () => {
  it('is byte-identical to the pre-#2423 literal at the production channel', () => {
    // Characterization: #2423 says "do not change hint wording beyond the
    // channel token", and these strings sit inside signer refusal messages
    // that users and agents pattern-match on. This is the literal as it stood
    // before the constant was introduced.
    expect(SIGNER_UPDATE_FALLBACK).toBe(
      'Update @haven_ai/signer by rerunning `npx @haven_ai/connect@alpha`, which reinstalls the ' +
        'pinned MCP runtime, then retry the same signing call. Nothing was signed or spent — the ' +
        'quote or payment this version came from is unaffected and does not need to be re-quoted.',
    )
  })

  it('renders another channel by moving only the tag', () => {
    expect(signerUpdateFallback('dev')).toBe(SIGNER_UPDATE_FALLBACK.replace('@alpha', '@dev'))
    expect(signerUpdateFallback('dev')).toContain('npx @haven_ai/connect@dev')
    expect(signerUpdateFallback('dev')).not.toContain('connect@alpha')
  })

  it('SIGNER_UPDATE_FALLBACK is exactly the build channel rendering', () => {
    expect(SIGNER_UPDATE_FALLBACK).toBe(signerUpdateFallback(HAVEN_CONNECTOR_CHANNEL))
  })
})
