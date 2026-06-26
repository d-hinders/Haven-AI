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
})
