import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { buildSkillBundle } from '@/lib/agent-skill-bundle'
import { type HandoffInput } from '@/lib/agent-handoff'

/**
 * Tests for the agent skill-bundle generator.
 *
 * The skill bundle is a zip we hand to external developers — it lands on
 * disk and the user follows the README to wire it into their agent. These
 * tests check the shape and key contents, not exact wording.
 */

const BASE_INPUT: HandoffInput = {
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

async function readBundle(input: HandoffInput) {
  const { blob, filename } = await buildSkillBundle(input)
  // JSZip accepts Blob directly — jsdom's Blob lacks arrayBuffer() in this
  // version, so we hand the Blob over and let JSZip's reader sort it out.
  const zip = await JSZip.loadAsync(blob as unknown as Parameters<typeof JSZip.loadAsync>[0])
  // All bundle contents live under a single top-level folder.
  const folderName = Object.keys(zip.files).find((p) => p.endsWith('/') && !p.slice(0, -1).includes('/'))
  expect(folderName).toBeTruthy()
  async function read(path: string): Promise<string> {
    const entry = zip.file(`${folderName}${path}`)
    if (!entry) throw new Error(`missing entry: ${path}`)
    return entry.async('string')
  }
  return { filename, folderName: folderName!, read, zip }
}

function expectNoRawSecrets(value: string) {
  expect(value).not.toContain('sk_agent_TESTKEY_NEVERREAL')
  expect(value).not.toContain('0xPRIVATEKEY_NEVERREAL')
}

describe('buildSkillBundle — structure', () => {
  it('produces a slug-named zip with no secrets in the filename', async () => {
    const { filename } = await readBundle(BASE_INPUT)
    expect(filename).toBe('haven-skill-my-payment-agent.zip')
    expect(filename).not.toContain('sk_agent')
    expect(filename).not.toContain('0x')
  })

  it('contains the expected files', async () => {
    const { read } = await readBundle(BASE_INPUT)
    // Each call throws if the entry is missing — calling them all is the test.
    await Promise.all([
      read('SKILL.md'),
      read('README.md'),
      read('.env.example'),
      read('pay.ts'),
      read('package.json'),
    ])
  })

  it('package.json is valid JSON with a slugged name and a single dep', async () => {
    const { read } = await readBundle(BASE_INPUT)
    const pkg = JSON.parse(await read('package.json'))
    expect(pkg.name).toBe('haven-skill-my-payment-agent')
    expect(pkg.dependencies).toHaveProperty('@haven_ai/sdk')
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe('module')
  })
})

describe('buildSkillBundle — credential plumbing', () => {
  it('embeds credentials in .env.example and README, not SKILL.md or pay.ts', async () => {
    const { read } = await readBundle(BASE_INPUT)
    const envFile = await read('.env.example')
    const readme = await read('README.md')
    const skillMd = await read('SKILL.md')
    const payTs = await read('pay.ts')

    // Where credentials should appear:
    expect(envFile).toContain('sk_agent_TESTKEY_NEVERREAL')
    expect(envFile).toContain('0xPRIVATEKEY_NEVERREAL')
    expect(readme).toContain('sk_agent_TESTKEY_NEVERREAL')
    expect(readme).toContain('0xPRIVATEKEY_NEVERREAL')

    // Where they must not — pay.ts reads from process.env, and SKILL.md is a
    // tool description that may be read by every agent invocation.
    expect(skillMd).not.toContain('sk_agent_TESTKEY_NEVERREAL')
    expect(skillMd).not.toContain('0xPRIVATEKEY_NEVERREAL')
    expect(payTs).not.toContain('sk_agent_TESTKEY_NEVERREAL')
    expect(payTs).not.toContain('0xPRIVATEKEY_NEVERREAL')
  })

  it('keeps raw credentials confined to the intentionally secret-bearing files', async () => {
    const { filename, folderName, read, zip } = await readBundle(BASE_INPUT)

    expectNoRawSecrets(filename)
    expectNoRawSecrets(folderName)

    const secretBearingFiles = new Set(['README.md', '.env.example'])
    for (const [path, entry] of Object.entries(zip.files)) {
      expectNoRawSecrets(path)
      if (entry.dir) continue

      expect(path.startsWith(folderName)).toBe(true)
      const relativePath = path.slice(folderName.length)
      const contents = await entry.async('string')
      if (secretBearingFiles.has(relativePath)) {
        expect(contents).toContain('sk_agent_TESTKEY_NEVERREAL')
        expect(contents).toContain('0xPRIVATEKEY_NEVERREAL')
      } else {
        expectNoRawSecrets(contents)
      }
    }
  })

  it('pay.ts loads credentials from process.env and throws if missing', async () => {
    const { read } = await readBundle(BASE_INPUT)
    const payTs = await read('pay.ts')
    expect(payTs).toContain('process.env.HAVEN_API_KEY')
    expect(payTs).toContain('process.env.HAVEN_DELEGATE_KEY')
    expect(payTs).toMatch(/throw new Error\([^)]*HAVEN_API_KEY/)
    expect(payTs).toMatch(/throw new Error\([^)]*HAVEN_DELEGATE_KEY/)
  })

  it('keeps SKILL.md aligned with current Haven agent rules and fetch support', async () => {
    const { read } = await readBundle(BASE_INPUT)
    const skillMd = await read('SKILL.md')

    expect(skillMd).toContain('Haven wallet')
    expect(skillMd).toContain('Credential address')
    expect(skillMd).toContain('Sign Haven payment requests locally')
    expect(skillMd).toContain('within the user\'s agent rules')
    expect(skillMd).toContain('haven.fetch()')
    expect(skillMd).toContain('get_payment_status')
    expect(skillMd).toContain('retry_original_x402_request')
    expect(skillMd).not.toContain('on behalf of the user')
    expect(skillMd).not.toContain('server-side policy')
    expect(skillMd).not.toContain('AllowanceModule')
  })
})

describe('buildSkillBundle — revoke link', () => {
  it('uses the provided appBaseUrl in SKILL.md', async () => {
    const { read } = await readBundle({ ...BASE_INPUT, appBaseUrl: 'https://app.example.com' })
    const skillMd = await read('SKILL.md')
    expect(skillMd).toContain('https://app.example.com/agents')
  })

  it('falls back to a host that resolves when appBaseUrl is omitted', async () => {
    // Regression: SKILL.md previously hardcoded https://app.haven.xyz/agents
    // (an unowned domain returning NXDOMAIN), shipping a dead revoke link to
    // every user who downloaded a bundle. The fallback must resolve, and the
    // unowned host must never appear.
    const { read } = await readBundle(BASE_INPUT)
    const skillMd = await read('SKILL.md')
    expect(skillMd).not.toContain('app.haven.xyz')
    expect(skillMd).toMatch(/https?:\/\/[^/\s]+\/agents/)
  })

  it('strips trailing slashes from appBaseUrl', async () => {
    const { read } = await readBundle({ ...BASE_INPUT, appBaseUrl: 'https://app.example.com///' })
    const skillMd = await read('SKILL.md')
    expect(skillMd).toContain('https://app.example.com/agents')
    expect(skillMd).not.toContain('app.example.com//')
  })
})

describe('buildSkillBundle — README parity with handoff doc', () => {
  it('the README is the same artefact buildHandoff produces', async () => {
    const { read } = await readBundle(BASE_INPUT)
    const readme = await read('README.md')
    // Sanity: contains the same identity and policy content the handoff doc
    // promises. We rely on agent-handoff.test.ts for fine-grained coverage.
    expect(readme).toContain('My Payment Agent')
    expect(readme).toContain('agt_abc123')
    expect(readme).toContain('10 EURe per day')
  })
})
