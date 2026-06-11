import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  buildGenericSkillMd,
  buildSdkStarterBundle,
  buildSkillBundle,
} from '@/lib/agent-skill-bundle'
import { type HandoffInput } from '@/lib/agent-handoff'

/**
 * Tests for the skill download and the SDK starter.
 *
 * The skill is generic: secret-free and byte-for-byte identical for every
 * agent — identity and budget come from the runtime tools. The SDK starter
 * is the separate, per-agent runnable example and the only artifact allowed
 * to carry env-filled credentials.
 */

const AGENT_A: HandoffInput = {
  agent: {
    id: 'agt_abc123',
    name: 'My Payment Agent',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    chainId: 100,
  },
  policy: {
    allowances: [{ tokenSymbol: 'EURe', amount: '10', resetPeriodMin: 1440 }],
  },
  credentials: {
    apiKey: 'sk_agent_TESTKEY_NEVERREAL',
    delegatePrivateKey: '0xPRIVATEKEY_NEVERREAL',
  },
}

const AGENT_B: HandoffInput = {
  agent: {
    id: 'agt_zzz999',
    name: 'Completely Different Agent',
    delegateAddress: '0x1111111111111111111111111111111111111111',
    safeAddress: '0x2222222222222222222222222222222222222222',
    chainId: 8453,
  },
  policy: {
    allowances: [{ tokenSymbol: 'USDC', amount: '500', resetPeriodMin: 0 }],
  },
  credentials: {
    apiKey: 'sk_agent_OTHERKEY_NEVERREAL',
    delegatePrivateKey: '0xOTHERPRIVATEKEY_NEVERREAL',
  },
}

async function readZip(blob: Blob) {
  const zip = await JSZip.loadAsync(blob as unknown as Parameters<typeof JSZip.loadAsync>[0])
  const folderName = Object.keys(zip.files).find((p) => p.endsWith('/') && !p.slice(0, -1).includes('/'))
  expect(folderName).toBeTruthy()
  async function read(path: string): Promise<string> {
    const entry = zip.file(`${folderName}${path}`)
    if (!entry) throw new Error(`missing entry: ${path}`)
    return entry.async('string')
  }
  return { folderName: folderName!, read, zip }
}

describe('generic skill', () => {
  it('is byte-for-byte identical regardless of agent input (genericness invariant)', () => {
    // buildGenericSkillMd takes no input at all — the strongest version of
    // the invariant. The assertions below pin that nothing per-agent leaks in.
    const skill = buildGenericSkillMd()
    expect(skill).toBe(buildGenericSkillMd())
    for (const input of [AGENT_A, AGENT_B]) {
      expect(skill).not.toContain(input.agent.name)
      expect(skill).not.toContain(input.agent.safeAddress)
      expect(skill).not.toContain(input.agent.delegateAddress)
      expect(skill).not.toContain(input.credentials.apiKey)
      expect(skill).not.toContain(input.credentials.delegatePrivateKey)
      expect(skill).not.toContain(String(input.agent.chainId))
    }
    expect(skill).not.toMatch(/0x[0-9a-fA-F]{40}/)
  })

  it('directs the agent to runtime tools for identity, budget, and payment', () => {
    const skill = buildGenericSkillMd()
    expect(skill).toContain('haven_get_agent')
    expect(skill).toContain('haven_get_allowances')
    expect(skill).toContain('haven_pay')
    expect(skill).toContain('haven_quote_x402')
    expect(skill).toContain('haven_pay_x402_quote')
    expect(skill).toContain('haven_get_payment_status')
    expect(skill).toContain('retry_original_x402_request')
    expect(skill).toContain('pending_approval')
    expect(skill).toMatch(/never.*private keys|private keys.*never/i)
  })

  it('zips as haven-pay/SKILL.md with a fixed filename and no other files', async () => {
    const { blob, filename } = await buildSkillBundle()
    expect(filename).toBe('haven-pay-skill.zip')
    const { folderName, read, zip } = await readZip(blob)
    expect(folderName).toBe('haven-pay/')
    expect(await read('SKILL.md')).toBe(buildGenericSkillMd())
    const fileEntries = Object.values(zip.files).filter((entry) => !entry.dir)
    expect(fileEntries).toHaveLength(1)
  })
})

describe('SDK starter (separate from the skill)', () => {
  it('is named as a starter, never as the skill', async () => {
    const { filename } = await buildSdkStarterBundle(AGENT_A)
    expect(filename).toBe('haven-sdk-starter-my-payment-agent.zip')
    expect(filename).not.toContain('skill')
  })

  it('contains the runnable example and no SKILL.md', async () => {
    const { blob } = await buildSdkStarterBundle(AGENT_A)
    const { read, zip } = await readZip(blob)
    await Promise.all([
      read('README.md'),
      read('.env.example'),
      read('pay.ts'),
      read('package.json'),
    ])
    expect(Object.keys(zip.files).some((path) => path.endsWith('SKILL.md'))).toBe(false)
  })

  it('keeps raw credentials confined to README and .env.example', async () => {
    const { blob } = await buildSdkStarterBundle(AGENT_A)
    const { folderName, zip } = await readZip(blob)

    const secretBearingFiles = new Set(['README.md', '.env.example'])
    for (const [path, entry] of Object.entries(zip.files)) {
      expect(path).not.toContain('sk_agent_TESTKEY_NEVERREAL')
      if (entry.dir) continue
      const relativePath = path.slice(folderName.length)
      const contents = await entry.async('string')
      if (secretBearingFiles.has(relativePath)) {
        expect(contents).toContain('sk_agent_TESTKEY_NEVERREAL')
        expect(contents).toContain('0xPRIVATEKEY_NEVERREAL')
      } else {
        expect(contents).not.toContain('sk_agent_TESTKEY_NEVERREAL')
        expect(contents).not.toContain('0xPRIVATEKEY_NEVERREAL')
      }
    }
  })

  it('pay.ts loads credentials from process.env and throws if missing', async () => {
    const { blob } = await buildSdkStarterBundle(AGENT_A)
    const { read } = await readZip(blob)
    const payTs = await read('pay.ts')
    expect(payTs).toContain('process.env.HAVEN_API_KEY')
    expect(payTs).toContain('process.env.HAVEN_DELEGATE_KEY')
    expect(payTs).toMatch(/throw new Error\([^)]*HAVEN_API_KEY/)
    expect(payTs).toMatch(/throw new Error\([^)]*HAVEN_DELEGATE_KEY/)
  })

  it('README carries the per-agent handoff content', async () => {
    const { blob } = await buildSdkStarterBundle(AGENT_A)
    const { read } = await readZip(blob)
    const readme = await read('README.md')
    expect(readme).toContain('My Payment Agent')
    expect(readme).toContain('agt_abc123')
    expect(readme).toContain('10 EURe per day')
  })
})
