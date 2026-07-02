import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Non-custody perimeter invariants (design: docs/research/non-custody-verification.md).
 *
 * These tests turn the CASP/MiCA guardrails
 * (docs/regulatory/casp-risk-guardrails.md) into checks that PROVE the perimeter
 * on every PR. A failure here means a change would weaken a hard custody
 * invariant — stop and get the legal/product review the guardrails require,
 * rather than "fixing" the test.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS = join(SRC, 'db', 'migrations')

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Production source: everything under src/ except tests. */
function productionFiles(): string[] {
  return walkTs(SRC).filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'))
}

function rel(f: string): string {
  return relative(SRC, f)
}

describe('non-custody invariants', () => {
  // Invariant 1 — Red Line #1/#2: Haven stores no key material.
  it('stores no private keys, seed phrases, or mnemonics (no such columns)', () => {
    const forbidden = /\b(private_key|privatekey|secret_key|seed_phrase|mnemonic)\b/i
    const offenders: string[] = []
    for (const file of walkTs(MIGRATIONS)) {
      if (forbidden.test(readFileSync(file, 'utf8'))) offenders.push(rel(file))
    }
    expect(offenders, 'migration defines a key/seed column — see Red Line #1/#2').toEqual([])
  })

  // Invariant 2 — Red Line #3: agent secrets are identity, hashed at rest.
  it('stores agent secrets hashed (api_key_hash exists)', () => {
    const migrations = walkTs(MIGRATIONS).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(migrations).toMatch(/api_key_hash/)
  })

  // Invariant 3 — "no signer capable of spending": exactly one server-side
  // signer (the relayer, which only pays gas).
  it('instantiates exactly one server-side signer — the gas-only relayer', () => {
    const withSigner = productionFiles().filter((f) => /new Wallet\(/.test(readFileSync(f, 'utf8')))
    expect(withSigner.map(rel)).toEqual(['lib/relayer.ts'])
  })

  it('keeps the relayer a gas-only signer (derived from the relayer gas key)', () => {
    const relayer = readFileSync(join(SRC, 'lib', 'relayer.ts'), 'utf8')
    // Per-chain relayer keys (#640/#678): the deploy/exec signer resolves via
    // relayerPrivateKeyForChain(chainId) — RELAYER_PRIVATE_KEY_<chainId> with a
    // global RELAYER_PRIVATE_KEY fallback. Both are relayer *gas* keys, so the
    // invariant (relayer derived only from a relayer gas key) still holds.
    expect(relayer).toMatch(/relayerPrivateKeyForChain\(/)
  })

  // Invariant 4 — Red Line #1/#2: Haven never generates key material server-side.
  it('never generates private keys server-side', () => {
    const keygen = /createRandom|generatePrivateKey|Wallet\.fromPhrase|fromMnemonic|HDNodeWallet/
    const offenders = productionFiles().filter((f) => keygen.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel), 'server-side key generation — see Red Line #1/#2').toEqual([])
  })
})

/**
 * Session-key rail invariants (#736, ADR #719 Stage 2).
 *
 * The ERC-4337 rail must keep the same perimeter as the legacy rail: Haven
 * constructs, the customer signs. These pins assert the specific mechanisms —
 * a failure means a change would give the backend signing authority over the
 * session path. Stop and get the review the guardrails require.
 */
describe('non-custody invariants — session-key rail (#736)', () => {
  const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8')

  // Invariant 5 — the Safe "owner" the rail derives accounts from cannot sign.
  it('keeps the session rail owner watch-only (refuses to sign, loudly)', () => {
    const sessionRail = read('lib', 'session-rail.ts')
    expect(sessionRail).toMatch(/watchOnlyOwner\(/)
    expect(sessionRail).toContain('non-custody: the backend cannot sign as the Safe owner')
    // Every owner sign method must be bound to the refusal — no real signer.
    for (const method of ['signMessage', 'signTransaction', 'signTypedData']) {
      expect(sessionRail).toMatch(new RegExp(`${method}: refuse`))
    }
  })

  // Invariant 6 — no viem key-derived signer anywhere in production source.
  // (The ethers equivalent is pinned by "exactly one server-side signer".)
  it('creates no viem key-based signers server-side', () => {
    const offenders = productionFiles().filter((f) =>
      /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders.map(rel), 'viem signer from key material — see Red Line #1/#2').toEqual([])
  })

  // Invariant 7 — session UserOps carry CLIENT signatures only: the submit
  // step takes the signature as an argument and stamps it in; nothing in the
  // rail produces one.
  it('submits session UserOps with a caller-provided signature only', () => {
    const sessionRail = read('lib', 'session-rail.ts')
    expect(sessionRail).toMatch(/sessionSignature:\s*Hex/)
  })

  // Invariant 8 — session config (enable / remove / rotate) is pure
  // construction: no signing, and never submitted by the relayer. The owner
  // signs these payloads (the /safe-exec pattern).
  it('keeps session-config modules signer-free and relayer-free', () => {
    for (const file of ['session-policies.ts', 'session-rotation.ts', 'execution-rail.ts']) {
      const src = read('lib', file)
      expect(src, `${file} must not sign`).not.toMatch(
        /signMessage|signTransaction|signTypedData|signingKey|new Wallet\(/,
      )
      expect(src, `${file} must not reach for the relayer`).not.toMatch(/getRelayerWallet/)
    }
  })

  // Invariant 9 — the bundler credential (URL embeds the API key) has exactly
  // one production choke point, keeping it auditable and un-loggable by
  // construction elsewhere.
  it('reads the bundler credential in exactly one place', () => {
    const holders = productionFiles().filter((f) =>
      /SESSION_RAIL_BUNDLER_URL/.test(readFileSync(f, 'utf8')),
    )
    expect(holders.map(rel)).toEqual(['lib/execution-rail.ts'])
  })

  // Invariant 10 — the paymaster sponsors GAS, never value: no ERC-20 value
  // ever routes through the paymaster config; the rail's only transfer
  // construction is the intent's own `transfer(to, amount)` calldata.
  it('gives the paymaster no value-transfer surface', () => {
    const sessionRail = read('lib', 'session-rail.ts')
    // The paymaster is wired as a sponsorship client only — assert the config
    // never passes token/value fields to it.
    expect(sessionRail).toMatch(/paymaster:\s*pimlico/)
    expect(sessionRail).not.toMatch(/paymasterTokens|payInERC20|tokenPaymaster/i)
  })
})
