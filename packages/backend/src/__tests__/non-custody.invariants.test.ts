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

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
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

  // Invariant 3 — "no signer capable of spending". Two server-side signers
  // exist, and the list is exhaustive on purpose: adding a third is a
  // non-custody decision, not an implementation detail.
  //
  //   infra/relayer.ts        — the gas-only relayer (pinned below).
  //   modules/passport/receipt.ts — signs L0 verification receipts (#974). It is a
  //     MESSAGE signer: no provider, no transaction, and its key is dedicated
  //     (PASSPORT_RECEIPT_SIGNING_KEY, never the relayer's). The next test
  //     enforces that confinement rather than taking this comment's word for it.
  it('instantiates exactly two server-side signers — and no others', () => {
    const withSigner = productionFiles().filter((f) => /new Wallet\(/.test(readFileSync(f, 'utf8')))
    expect(withSigner.map(rel).sort()).toEqual(['infra/relayer.ts', 'modules/passport/receipt.ts'])
  })

  it('keeps the receipt signer message-only — no provider, no transaction', () => {
    // What makes a second signer acceptable: it can prove Haven said something,
    // and it can do nothing else. A provider or a sendTransaction call here
    // would turn a public assertion key into one that touches the chain — the
    // exact reason it must not be the relayer key in the first place.
    const receipt = readFileSync(join(SRC, 'modules', 'passport', 'receipt.ts'), 'utf8')
    expect(receipt).toMatch(/signMessage/)
    expect(receipt).not.toMatch(/sendTransaction|\.connect\(|getProvider|JsonRpcProvider/)
    // And it is fed a dedicated key, never the relayer's.
    expect(receipt).not.toMatch(/RELAYER_PRIVATE_KEY|relayerPrivateKeyForChain|getRelayer/)
  })

  it('keeps the relayer a gas-only signer (derived from the relayer gas key)', () => {
    const relayer = readFileSync(join(SRC, 'infra', 'relayer.ts'), 'utf8')
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
describe('non-custody invariants — delegation rail (#831, mapping: docs/security/delegation-rail-security-model.md §2)', () => {
  it('creates no viem key-based signers server-side', () => {
    const offenders = productionFiles().filter((f) =>
      /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders.map(rel), 'viem signer from key material — see Red Line #1/#2').toEqual([])
  })

  const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8')

  // Invariant 5-d — every account the rail derives (delegate, treasury,
  // provisioning) is constructed WATCH-ONLY and refuses to sign, loudly.
  it('keeps delegation-rail account owners watch-only (refuse, loudly)', () => {
    for (const [file, marker] of [
      ['delegation-rail.ts', 'non-custody: the backend cannot sign as the agent delegate'],
      ['hybrid-provisioning.ts', 'non-custody: provisioning is watch-only and cannot sign'],
    ] as const) {
      const src = read('rails', file)
      expect(src, `${file} watch-only marker`).toContain(marker)
      for (const method of ['signMessage', 'signTransaction', 'signTypedData']) {
        expect(src, `${file} binds ${method} to refusal`).toMatch(new RegExp(`${method}: refuse`))
      }
    }
  })

  // Invariant 7-d — redemptions and treasury ops carry CLIENT signatures
  // only: submit takes the signature as an argument; nothing in production
  // source calls the kit's signing entry points.
  it('submits redemptions/treasury ops with a caller-provided signature only', () => {
    const rail = read('rails', 'delegation-rail.ts')
    expect(rail).toMatch(/submitRedemption\(\s*\n?\s*prepared[\s\S]{0,120}signature:\s*Hex/)
    const signers = productionFiles().filter((f) =>
      /\bsignDelegation\s*\(|\bsignUserOperation\s*\(/.test(readFileSync(f, 'utf8')),
    )
    expect(
      signers.map(rel),
      'kit signing entry points take a PRIVATE KEY — client-side only (#824 invariant 12)',
    ).toEqual([])
  })

  // Invariant 8-d — the authority lifecycle (compile / grant / revoke
  // routes) is pure construction plus bookkeeping: no signer construction,
  // no relayer reach.
  it('keeps delegation lifecycle modules signer-free and relayer-free', () => {
    for (const file of [
      join('rails', 'delegation-policy.ts'),
      join('rails', 'delegation-contracts.ts'),
      join('routes', 'agent-delegations.ts'),
      join('routes', 'hybrid-accounts.ts'),
    ]) {
      const src = readFileSync(join(SRC, file), 'utf8')
      expect(src, `${file} must not construct signers`).not.toMatch(
        /new Wallet\(|privateKeyToAccount|signingKey/,
      )
      expect(src, `${file} must not reach for the relayer`).not.toMatch(/getRelayerWallet/)
    }
  })

  // Invariant 11 (NEW, #824) — Haven's codebase contains NO path to the
  // account's UUPS upgrade surface: upgrade authority is the account's own
  // signers, never code Haven ships.
  it('contains no UUPS upgrade call path', () => {
    const offenders = productionFiles().filter((f) =>
      /upgradeToAndCall|upgradeTo\s*\(|proxiableUUID/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders.map(rel), 'UUPS upgrade authority = account signers ONLY').toEqual([])
  })

  // Invariant 12 (NEW, #824) — delegations are client-signed only: the
  // EIP-712 payload leaves the backend unsigned (delegationSigningPayload),
  // and no production code holds a key that could sign one (see 7-d for the
  // call-site scan; this pins the payload shape).
  it('ships delegation signing payloads unsigned, for the owner to sign', () => {
    const policy = read('rails', 'delegation-policy.ts')
    expect(policy).toMatch(/delegationSigningPayload/)
    const route = read('routes', 'agent-delegations.ts')
    expect(route).toMatch(/signing_payload/)
    // The activate step receives the signature from the client:
    expect(route).toMatch(/signature.*required/i)
  })

  // Invariant 13 (NEW, #888/#890) — signer-management (enroll/remove backup)
  // is client-signed: the route PREPARES addKey/removeKey/transferOwnership
  // ops and returns an unsigned payload; the signature arrives from the
  // client, and no production code holds a key that could authorize a signer
  // change. Every account-authority change is signed by an EXISTING signer.
  it('prepares signer changes for the owner to sign — Haven signs none', () => {
    // #1081 moved the logic into a shared module so the agent-scoped and
    // account-scoped surfaces cannot drift. The invariant is unchanged; it is
    // now asserted where the logic lives, and over BOTH entry points.
    const core = read('rails', 'hybrid-signer-actions.ts')
    // The prepare step returns a payload, never a signature:
    expect(core).toMatch(/signature_scheme/)
    // The submit step requires a client signature and pins it to the op:
    expect(core).toMatch(/signature is required/i)
    expect(core).toMatch(/does not match the requested signer change/)
    // Nothing in the shared core can produce a signature:
    expect(core).not.toMatch(/privateKeyToAccount|new Wallet\(|signMessage\(|signTypedData\(/)

    // Both surfaces reach it, and neither re-implements it:
    const agentRoute = read('routes', 'agent-delegations.ts')
    expect(agentRoute).toMatch(/account-signers\/prepare/)
    expect(agentRoute).toMatch(/account-signers\/submit/)
    const accountRoute = read('routes', 'hybrid-accounts.ts')
    expect(accountRoute).toMatch(/signers\/prepare/)
    expect(accountRoute).toMatch(/signers\/submit/)
    for (const route of [agentRoute, accountRoute]) {
      expect(route).toMatch(/hybrid-signer-actions\.js/)
    }

    // The config loader that the deploy/sign paths rebuild from is a pure
    // read — no signing surface:
    const cfg = read('rails', 'hybrid-account-config.ts')
    expect(cfg).not.toMatch(/privateKeyToAccount|new Wallet\(|signMessage|signTypedData\(/)
  })

  // Invariant 10-d — sponsorship pays gas only, on this rail too.
  it('gives the delegation-rail paymaster no value-transfer surface', () => {
    const rail = read('rails', 'delegation-rail.ts')
    expect(rail).toMatch(/paymaster:\s*pimlico/)
    expect(rail).not.toMatch(/paymasterTokens|payInERC20|tokenPaymaster/i)
  })
})
