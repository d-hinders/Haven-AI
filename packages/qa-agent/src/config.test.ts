import { describe, it, expect } from 'vitest'
import { loadQaConfig, QaConfigError } from './config.js'

const fullEnv = {
  QA_HAVEN_API_URL: 'https://dev-backend.up.railway.app/',
  QA_AGENT_API_KEY: 'sk_agent_test',
  QA_DELEGATE_PRIVATE_KEY: '0xabc',
  QA_PAYMENT_TO: '0xrecipient',
} as NodeJS.ProcessEnv

describe('loadQaConfig', () => {
  it('loads a valid config and strips the API URL trailing slash', () => {
    const config = loadQaConfig(fullEnv)
    expect(config.apiUrl).toBe('https://dev-backend.up.railway.app')
    expect(config.agentApiKey).toBe('sk_agent_test')
    expect(config.delegateKey).toBe('0xabc')
    expect(config.paymentTo).toBe('0xrecipient')
    expect(config.demoMerchantUrl).toBeUndefined()
  })

  it('includes an optional demo-merchant URL when set', () => {
    const config = loadQaConfig({ ...fullEnv, QA_DEMO_MERCHANT_URL: 'https://dm.example/' })
    expect(config.demoMerchantUrl).toBe('https://dm.example')
  })

  it('throws QaConfigError listing every missing required var', () => {
    expect(() => loadQaConfig({} as NodeJS.ProcessEnv)).toThrow(QaConfigError)
    try {
      loadQaConfig({} as NodeJS.ProcessEnv)
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('QA_HAVEN_API_URL')
      expect(message).toContain('QA_AGENT_API_KEY')
      expect(message).toContain('QA_DELEGATE_PRIVATE_KEY')
      expect(message).toContain('QA_PAYMENT_TO')
    }
  })

  it('treats blank/whitespace values as missing', () => {
    expect(() => loadQaConfig({ ...fullEnv, QA_AGENT_API_KEY: '   ' } as NodeJS.ProcessEnv)).toThrow(
      QaConfigError,
    )
  })

  describe('delegation-rail credentials for the EIP-3009 bridge (#946)', () => {
    it('are absent by default, so the scenario skips rather than fails', () => {
      const config = loadQaConfig(fullEnv)
      expect(config.delegationAgentApiKey).toBeUndefined()
      expect(config.delegationDelegateKey).toBeUndefined()
    })

    it('are loaded when set', () => {
      const config = loadQaConfig({
        ...fullEnv,
        QA_DELEGATION_AGENT_API_KEY: 'sk_agent_delegation',
        QA_DELEGATION_DELEGATE_PRIVATE_KEY: '0xdef',
      })
      expect(config.delegationAgentApiKey).toBe('sk_agent_delegation')
      expect(config.delegationDelegateKey).toBe('0xdef')
    })

    it('are OPTIONAL — a missing pair never fails the whole run', () => {
      // Deliberate: these need a second seeded identity (a delegation-rail
      // agent with an open budget) that an operator provisions. Making them
      // required would break every existing dev run the moment this lands, for
      // a scenario nobody could yet satisfy.
      expect(() =>
        loadQaConfig({ ...fullEnv, QA_DELEGATION_AGENT_API_KEY: 'sk_agent_delegation' }),
      ).not.toThrow()
    })

    it('treats blank values as absent, so a half-set env skips instead of half-running', () => {
      const config = loadQaConfig({
        ...fullEnv,
        QA_DELEGATION_AGENT_API_KEY: '  ',
        QA_DELEGATION_DELEGATE_PRIVATE_KEY: '0xdef',
      })
      expect(config.delegationAgentApiKey).toBeUndefined()
    })
  })
})
