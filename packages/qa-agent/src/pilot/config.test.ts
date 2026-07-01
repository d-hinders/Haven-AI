import { describe, expect, it } from 'vitest'
import { loadPilotRigConfig } from './config.js'

const KEY = `0x${'11'.repeat(32)}`
const BUNDLER = 'https://api.pimlico.io/v2/84532/rpc?apikey=test'

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PILOT_OWNER_PRIVATE_KEY: KEY, PILOT_BUNDLER_URL: BUNDLER, ...overrides }
}

describe('loadPilotRigConfig', () => {
  it('parses a minimal env and applies testnet defaults', () => {
    const cfg = loadPilotRigConfig(env())
    expect(cfg.ownerPrivateKey).toBe(KEY)
    expect(cfg.bundlerUrl).toBe(BUNDLER)
    expect(cfg.rpcUrl).toBe('https://sepolia.base.org')
    expect(cfg.safe7579AdapterAddress).toMatch(/^0x7579/)
    expect(cfg.erc7579LaunchpadAddress).toMatch(/^0x7579/)
    expect(cfg.saltNonce).toBe(0n)
  })

  it('aggregates every missing required var into one error', () => {
    expect(() => loadPilotRigConfig({})).toThrow(/PILOT_OWNER_PRIVATE_KEY[\s\S]*PILOT_BUNDLER_URL/)
  })

  it('rejects a malformed private key', () => {
    expect(() => loadPilotRigConfig(env({ PILOT_OWNER_PRIVATE_KEY: '0x1234' }))).toThrow(
      /32-byte hex private key/,
    )
  })

  it('rejects a malformed address override', () => {
    expect(() => loadPilotRigConfig(env({ PILOT_SAFE7579_ADAPTER: 'not-an-address' }))).toThrow(
      /PILOT_SAFE7579_ADAPTER/,
    )
  })

  it('parses PILOT_SALT_NONCE and rejects non-integers', () => {
    expect(loadPilotRigConfig(env({ PILOT_SALT_NONCE: '7' })).saltNonce).toBe(7n)
    expect(() => loadPilotRigConfig(env({ PILOT_SALT_NONCE: 'seven' }))).toThrow(/PILOT_SALT_NONCE/)
  })
})
