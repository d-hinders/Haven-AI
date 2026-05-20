import { describe, it, expect } from 'vitest'
import {
  buildHandoff,
  buildDotenv,
  type HandoffInput,
} from '@/lib/agent-handoff'

/**
 * Tests for the agent credential handoff generator.
 *
 * Focused on behaviour an external user actually depends on — not exact copy.
 * Use substring assertions, not full snapshots, so cosmetic edits don't churn.
 */

const BASE_INPUT: HandoffInput = {
  agent: {
    id: 'agt_abc123',
    name: 'My Payment Agent',
    description: 'Pays for x402 APIs',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    safeName: 'Treasury Safe',
    chainId: 100,
  },
  policy: {
    allowances: [
      { tokenSymbol: 'EURe', amount: '10', resetPeriodMin: 1440 },
    ],
  },
  credentials: {
    apiKey: 'sk_agent_TESTKEY_NEVERREAL',
    delegatePrivateKey: '0xPRIVATEKEY_NEVERREAL',
  },
}

function withInput(overrides: Partial<HandoffInput>): HandoffInput {
  return {
    ...BASE_INPUT,
    ...overrides,
    agent: { ...BASE_INPUT.agent, ...(overrides.agent ?? {}) },
    policy: { ...BASE_INPUT.policy, ...(overrides.policy ?? {}) },
    credentials: { ...BASE_INPUT.credentials, ...(overrides.credentials ?? {}) },
  }
}

describe('buildDotenv', () => {
  it('emits API key, agent identity, wallet address, and chain id', () => {
    const env = buildDotenv(BASE_INPUT)
    expect(env).toContain('HAVEN_AGENT_ID=agt_abc123')
    expect(env).toContain('HAVEN_API_KEY=sk_agent_TESTKEY_NEVERREAL')
    expect(env).toContain('HAVEN_DELEGATE_ADDRESS=0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b')
    expect(env).toContain('HAVEN_WALLET_ADDRESS=0xbf35beb0f587db2527b64e58d61f78bbf840860f')
    expect(env).toContain('HAVEN_SAFE_ADDRESS=0xbf35beb0f587db2527b64e58d61f78bbf840860f')
    expect(env).toContain('HAVEN_CHAIN_ID=100')
  })

  it('includes the delegate key when present', () => {
    const env = buildDotenv(BASE_INPUT)
    expect(env).toContain('HAVEN_DELEGATE_KEY=0xPRIVATEKEY_NEVERREAL')
  })

  it('omits the delegate key when the user brought their own', () => {
    const env = buildDotenv(
      withInput({ credentials: { ...BASE_INPUT.credentials, delegatePrivateKey: null } }),
    )
    expect(env).not.toContain('HAVEN_DELEGATE_KEY=0xPRIVATEKEY_NEVERREAL')
    expect(env).toContain('# HAVEN_DELEGATE_KEY=<private key for 0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b>')
  })

  it('includes HAVEN_API_URL only when apiBaseUrl is provided', () => {
    expect(buildDotenv(BASE_INPUT)).not.toContain('HAVEN_API_URL')
    const env = buildDotenv(withInput({ apiBaseUrl: 'https://api.example.com' }))
    expect(env).toContain('HAVEN_API_URL=https://api.example.com')
  })
})

describe('buildHandoff — identity & metadata', () => {
  it('renders agent name, id, addresses, and chain', () => {
    const { markdown } = buildHandoff(BASE_INPUT)
    expect(markdown).toContain('My Payment Agent')
    expect(markdown).toContain('agt_abc123')
    expect(markdown).toContain('0xbf35beb0f587db2527b64e58d61f78bbf840860f')
    expect(markdown).toContain('0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b')
    expect(markdown).toContain('Treasury Safe')
    expect(markdown).toContain('chain id `100`')
  })

  it('uses current Haven language for wallet and credential identity', () => {
    const { markdown } = buildHandoff(BASE_INPUT)
    expect(markdown).toContain('Haven wallet')
    expect(markdown).toContain('Credential address')
    expect(markdown).not.toContain('Safe account')
    expect(markdown).not.toContain('AllowanceModule')
  })

  it('resolves a known chainId to its display name', () => {
    const { markdown } = buildHandoff(BASE_INPUT)
    // Gnosis is chainId 100 — exact display label may evolve, but it
    // must not be the bare "chain 100" fallback.
    expect(markdown).not.toMatch(/Network:\s*chain 100/)
  })

  it('falls back gracefully on unknown chain ids', () => {
    expect(() =>
      buildHandoff(withInput({ agent: { ...BASE_INPUT.agent, chainId: 999_999 } })),
    ).not.toThrow()
    const { markdown } = buildHandoff(
      withInput({ agent: { ...BASE_INPUT.agent, chainId: 999_999 } }),
    )
    expect(markdown).toContain('chain 999999')
  })

  it('produces a slug-based filename without secrets', () => {
    const { filename } = buildHandoff(BASE_INPUT)
    expect(filename).toMatch(/^skill-haven-agent-my-payment-agent\.md$/)
    expect(filename).not.toContain('sk_agent')
    expect(filename).not.toContain('0x')
  })
})

describe('buildHandoff — credentials', () => {
  it('embeds the API key in the markdown body', () => {
    const { markdown } = buildHandoff(BASE_INPUT)
    expect(markdown).toContain('sk_agent_TESTKEY_NEVERREAL')
  })

  it('embeds the delegate private key when Haven generated it', () => {
    const { markdown } = buildHandoff(BASE_INPUT)
    expect(markdown).toContain('0xPRIVATEKEY_NEVERREAL')
  })

  it('omits the private key when the user brought their own', () => {
    const { markdown } = buildHandoff(
      withInput({ credentials: { ...BASE_INPUT.credentials, delegatePrivateKey: null } }),
    )
    expect(markdown).not.toContain('0xPRIVATEKEY_NEVERREAL')
    // Should still tell the user where to point their own key:
    expect(markdown).toContain('0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b')
  })
})

describe('buildHandoff — policy', () => {
  it('lists each allowance with its reset period', () => {
    const { markdown } = buildHandoff(
      withInput({
        policy: {
          ...BASE_INPUT.policy,
          allowances: [
            { tokenSymbol: 'EURe', amount: '10', resetPeriodMin: 1440 },
            { tokenSymbol: 'USDC', amount: '5', resetPeriodMin: 60 },
          ],
        },
      }),
    )
    expect(markdown).toContain('10 EURe per day')
    expect(markdown).toContain('5 USDC per hour')
  })

  it('handles empty allowances without crashing', () => {
    const { markdown } = buildHandoff(
      withInput({ policy: { ...BASE_INPUT.policy, allowances: [] } }),
    )
    expect(markdown).toContain('none configured')
  })

  it('mentions the manual approval queue as the over-limit escape hatch', () => {
    const { markdown } = buildHandoff(BASE_INPUT)
    // Policy lives entirely on-chain now; the only "escape hatch" for
    // payments above the allowance is the owner-approval queue.
    expect(markdown.toLowerCase()).toMatch(/approval/)
    expect(markdown.toLowerCase()).toMatch(/queue|dashboard/)
  })
})

describe('buildHandoff — paid API support', () => {
  it('documents x402 and machine-payment fetch support', () => {
    const { markdown } = buildHandoff(BASE_INPUT)
    expect(markdown).toContain('haven.fetch')
    expect(markdown).toContain('standard x402')
    expect(markdown).toContain('machine-payment')
  })

  it('explains queued approval errors from over-budget payments', () => {
    const { markdown } = buildHandoff(BASE_INPUT)
    expect(markdown).toContain('HavenPaymentStateError')
    expect(markdown).toContain('get_payment_status')
    expect(markdown).toContain('retry_original_x402_request')
    expect(markdown).toMatch(/Do not rewrite the SDK or retry/i)
  })
})

describe('buildHandoff — revoke link', () => {
  it('uses the provided appBaseUrl', () => {
    const { markdown } = buildHandoff(
      withInput({ appBaseUrl: 'https://app.example.com' }),
    )
    expect(markdown).toContain('https://app.example.com/agents')
  })

  it('strips trailing slashes from appBaseUrl before appending /agents', () => {
    const { markdown } = buildHandoff(
      withInput({ appBaseUrl: 'https://app.example.com///' }),
    )
    expect(markdown).toContain('https://app.example.com/agents')
    expect(markdown).not.toContain('app.example.com//')
  })

  it('falls back to a host that resolves when appBaseUrl is omitted', () => {
    // Regression test: previously fell back to https://app.haven.xyz, which
    // is an unowned domain that returns NXDOMAIN. Anything we ship as a
    // fallback must at least be a host that DNS resolves to a real server.
    const { markdown } = buildHandoff(BASE_INPUT)
    expect(markdown).not.toContain('app.haven.xyz')
    expect(markdown).toMatch(/https?:\/\/[^/\s]+\/agents/)
  })
})

describe('buildHandoff — SDK example', () => {
  it('uses haven.pay({ ... }) shape regardless of key mode', () => {
    const generated = buildHandoff(BASE_INPUT).markdown
    const byo = buildHandoff(
      withInput({ credentials: { ...BASE_INPUT.credentials, delegatePrivateKey: null } }),
    ).markdown
    for (const md of [generated, byo]) {
      expect(md).toContain('haven.pay({')
      expect(md).toContain('@haven_ai/sdk')
    }
  })

  it('keeps the BYO-key quickstart honest about the missing private key', () => {
    const { markdown } = buildHandoff(
      withInput({ credentials: { ...BASE_INPUT.credentials, delegatePrivateKey: null } }),
    )
    expect(markdown).toContain('Set HAVEN_DELEGATE_KEY before making payments')
    expect(markdown).toContain('HAVEN_DELEGATE_ADDRESS=')
  })
})
