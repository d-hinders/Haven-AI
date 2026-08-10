import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  computeSignerConsentHash,
  ensureSignerConsent,
  renderSignerConsentBlock,
  SIGNER_ACK_ENV,
  type SignerConsentInput,
} from './consent.js'

function captureWriter() {
  const chunks: string[] = []
  return {
    out: {
      write(chunk: string) {
        chunks.push(chunk)
        return true
      },
    },
    text: () => chunks.join(''),
  }
}

const input: SignerConsentInput = {
  delegateAddress: '0x000000000000000000000000000000000000dEaD',
  safeAddress: '0x000000000000000000000000000000000000Cafe',
  agentId: 'agt_test',
  chainId: 100,
  network: 'Gnosis Chain',
  toolNames: ['haven_x402_sign_header', 'haven_sign'],
}

describe('signer consent gate', () => {
  it('computes a stable hash regardless of tool ordering', () => {
    expect(computeSignerConsentHash(input)).toBe(
      computeSignerConsentHash({ ...input, toolNames: [...input.toolNames].reverse() }),
    )
  })

  it('changes the hash when delegate, wallet, or chain changes', () => {
    const baseHash = computeSignerConsentHash(input)
    expect(
      computeSignerConsentHash({
        ...input,
        delegateAddress: '0x000000000000000000000000000000000000bEEF',
      }),
    ).not.toBe(baseHash)
    expect(
      computeSignerConsentHash({
        ...input,
        safeAddress: '0x000000000000000000000000000000000000bEEF',
      }),
    ).not.toBe(baseHash)
    expect(computeSignerConsentHash({ ...input, chainId: 8453 })).not.toBe(baseHash)
  })

  it('renders signer-specific consent copy without a live allowance summary', () => {
    const hash = computeSignerConsentHash(input)
    const block = renderSignerConsentBlock(input, hash)
    expect(block).toContain('Haven edge signer - first-launch consent')
    expect(block).toContain(input.delegateAddress)
    expect(block).toContain("read-only fetch of a pending payment's signing")
    expect(block).toContain('never sends the key')
    expect(block).toContain('cannot show a live allowance summary')
    expect(block).toContain('haven_sign')
    expect(block).toContain(`${SIGNER_ACK_ENV}=${hash}`)
  })

  it('makes missing wallet metadata explicit', () => {
    const withoutWallet: SignerConsentInput = {
      delegateAddress: input.delegateAddress,
      toolNames: input.toolNames,
    }
    const block = renderSignerConsentBlock(
      withoutWallet,
      computeSignerConsentHash(withoutWallet),
    )
    expect(block).toContain('Haven wallet:     not provided to this signer')
  })

  it('refuses and prints when no acknowledgement is present', async () => {
    const writer = captureWriter()
    const decision = await ensureSignerConsent(input, { env: {}, out: writer.out })
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('no_acknowledgement')
    expect(writer.text()).toContain('Consent hash:')
  })

  it('accepts an env-var hash match without printing the block', async () => {
    const writer = captureWriter()
    const hash = computeSignerConsentHash(input)
    const decision = await ensureSignerConsent(input, {
      env: { [SIGNER_ACK_ENV]: hash },
      out: writer.out,
    })
    expect(decision).toMatchObject({ ok: true, reason: 'env_var_match', hash })
    expect(writer.text()).toBe('')
  })

  it('rejects HAVEN_SIGNER_ACK=skip like any other hash mismatch', async () => {
    const writer = captureWriter()
    const decision = await ensureSignerConsent(input, {
      env: { [SIGNER_ACK_ENV]: 'skip' },
      out: writer.out,
    })
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('env_var_mismatch')
    expect(writer.text()).toContain(decision.hash)
  })

  it('refuses on env-var mismatch and surfaces the expected hash', async () => {
    const writer = captureWriter()
    const decision = await ensureSignerConsent(input, {
      env: { [SIGNER_ACK_ENV]: 'deadbeef' },
      out: writer.out,
    })
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('env_var_mismatch')
    expect(writer.text()).toContain(decision.hash)
  })

  it('uses and writes the signer sidecar ack file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-ack-'))
    const credentialsPath = join(dir, 'agent.json')
    await writeFile(credentialsPath, '{}', 'utf8')
    try {
      const writer = captureWriter()
      const decision = await ensureSignerConsent(input, {
        env: {},
        credentialsPath,
        writeAck: true,
        out: writer.out,
      })
      expect(decision).toMatchObject({ ok: true, reason: 'wrote_ack_file' })

      const sidecar = JSON.parse(await readFile(`${credentialsPath}.signer-ack.json`, 'utf8'))
      expect(sidecar.ack).toBe(decision.hash)

      const secondWriter = captureWriter()
      const second = await ensureSignerConsent(input, {
        env: {},
        credentialsPath,
        out: secondWriter.out,
      })
      expect(second).toMatchObject({ ok: true, reason: 'ack_file_match' })
      expect(secondWriter.text()).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('consent surface version (#1263)', () => {
  it('an acknowledgement from the pre-network surface does not carry over', () => {
    // The v1 hash formula (before SIGNER_CONSENT_SURFACE_VERSION existed) —
    // a user who acked "does not call the Haven API" must be re-prompted
    // once under the corrected text, because the capability itself changed.
    const input = {
      delegateAddress: '0x' + 'ab'.repeat(20),
      toolNames: ['haven_sign'] as const,
    }
    const v1Style = createHash('sha256')
      .update(`${input.delegateAddress.toLowerCase()}||||\n${[...input.toolNames].sort().join(',')}`)
      .digest('hex')
      .slice(0, 16)
    expect(computeSignerConsentHash({ ...input, toolNames: [...input.toolNames] })).not.toBe(v1Style)
  })
})
