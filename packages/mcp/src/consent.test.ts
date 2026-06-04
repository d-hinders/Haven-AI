import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeConsentHash,
  consentInputFromClient,
  ensureConsent,
  renderConsentBlock,
  type ConsentInput,
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

const input: ConsentInput = {
  apiKeyPrefix: 'sk_agent_ab',
  apiUrl: 'https://haven.example',
  agentId: 'agt_test',
  safeAddress: '0xSafe',
  delegateAddress: '0xDelegate',
  chainId: 100,
  toolNames: ['haven_get_agent', 'haven_pay_x402_quote'],
  allowanceSummary: [
    { token: 'USDC', amount: '50.000000', resetMinutes: 1440 },
  ],
}

describe('consent gate', () => {
  it('computes a stable hash regardless of tool / allowance ordering', () => {
    const a = computeConsentHash(input)
    const b = computeConsentHash({
      ...input,
      toolNames: [...input.toolNames].reverse(),
      allowanceSummary: [...input.allowanceSummary].reverse(),
    })
    expect(a).toBe(b)
  })

  it('changes the hash when the credential or surface changes', () => {
    const baseHash = computeConsentHash(input)
    expect(computeConsentHash({ ...input, apiKeyPrefix: 'sk_agent_zz' })).not.toBe(baseHash)
    expect(
      computeConsentHash({
        ...input,
        allowanceSummary: [{ token: 'USDC', amount: '999.000000', resetMinutes: 1440 }],
      }),
    ).not.toBe(baseHash)
    expect(
      computeConsentHash({ ...input, toolNames: ['haven_get_agent'] }),
    ).not.toBe(baseHash)
  })

  it('changes the hash when the Haven wallet, delegate, or chain changes', () => {
    // Regression for PR #176 review P2: a credential swap with identical
    // token/amount/reset summary must invalidate the prior acknowledgement.
    const baseHash = computeConsentHash(input)
    expect(computeConsentHash({ ...input, safeAddress: '0xOtherSafe' })).not.toBe(baseHash)
    expect(computeConsentHash({ ...input, delegateAddress: '0xOtherDelegate' })).not.toBe(baseHash)
    expect(computeConsentHash({ ...input, chainId: 137 })).not.toBe(baseHash)
    expect(computeConsentHash({ ...input, apiUrl: 'https://other.example' })).not.toBe(baseHash)
    expect(computeConsentHash({ ...input, agentId: 'agt_other' })).not.toBe(baseHash)
  })

  it('normalises address casing so cosmetic credential edits do not re-prompt', () => {
    const baseHash = computeConsentHash(input)
    const upper = computeConsentHash({
      ...input,
      safeAddress: input.safeAddress?.toUpperCase(),
      delegateAddress: input.delegateAddress?.toUpperCase(),
    })
    expect(upper).toBe(baseHash)
  })

  it('renders wallet, delegate, and chain in the consent block', () => {
    const hash = computeConsentHash(input)
    const block = renderConsentBlock(input, hash)
    expect(block).toContain('Haven wallet (Safe): 0xSafe')
    expect(block).toContain('Delegate (local signer): 0xDelegate')
    expect(block).toContain('Chain ID:  100')
    expect(block).toContain('Haven API: https://haven.example')
    expect(block).toContain('Agent ID:  agt_test')
  })

  it('accepts an env-var hash match without printing the block', async () => {
    const writer = captureWriter()
    const hash = computeConsentHash(input)
    const decision = await ensureConsent(input, {
      env: { HAVEN_MCP_ACK: hash },
      out: writer.out,
    })
    expect(decision).toMatchObject({ ok: true, reason: 'env_var_match', hash })
    expect(writer.text()).toBe('')
  })

  it('accepts HAVEN_MCP_ACK=skip', async () => {
    const writer = captureWriter()
    const decision = await ensureConsent(input, {
      env: { HAVEN_MCP_ACK: 'skip' },
      out: writer.out,
    })
    expect(decision.ok).toBe(true)
    expect(decision.reason).toBe('env_var_skip')
    expect(writer.text()).toBe('')
  })

  it('refuses and prints when no acknowledgement is present', async () => {
    const writer = captureWriter()
    const decision = await ensureConsent(input, { env: {}, out: writer.out })
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('no_acknowledgement')
    const text = writer.text()
    expect(text).toContain('Haven MCP server — first-launch consent')
    expect(text).toContain('haven_pay_x402_quote')
    expect(text).toContain('USDC')
  })

  it('refuses on env-var mismatch and surfaces the expected hash', async () => {
    const writer = captureWriter()
    const decision = await ensureConsent(input, {
      env: { HAVEN_MCP_ACK: 'deadbeef' },
      out: writer.out,
    })
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('env_var_mismatch')
    expect(writer.text()).toContain(decision.hash)
  })

  it('uses the sidecar ack file when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-ack-'))
    const credentialsPath = join(dir, 'agent.json')
    await writeFile(credentialsPath, '{}', 'utf8')
    try {
      const hash = computeConsentHash(input)
      await writeFile(`${credentialsPath}.ack.json`, JSON.stringify({ ack: hash }), 'utf8')
      const writer = captureWriter()
      const decision = await ensureConsent(input, {
        env: {},
        credentialsPath,
        out: writer.out,
      })
      expect(decision).toMatchObject({ ok: true, reason: 'ack_file_match' })
      expect(writer.text()).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes the sidecar ack file when --ack (writeAck) is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-ack-'))
    const credentialsPath = join(dir, 'agent.json')
    await writeFile(credentialsPath, '{}', 'utf8')
    try {
      const writer = captureWriter()
      const decision = await ensureConsent(input, {
        env: {},
        credentialsPath,
        writeAck: true,
        out: writer.out,
      })
      expect(decision).toMatchObject({ ok: true, reason: 'wrote_ack_file' })

      const sidecar = JSON.parse(await readFile(`${credentialsPath}.ack.json`, 'utf8'))
      expect(sidecar.ack).toBe(decision.hash)
      expect(writer.text()).toContain('Haven MCP server — first-launch consent')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects --ack when no credentials path is set (env-only setups)', async () => {
    const writer = captureWriter()
    const decision = await ensureConsent(input, {
      env: {},
      writeAck: true,
      out: writer.out,
    })
    // Without a credentials path there is nowhere to write the sidecar;
    // fall through to the "refuse" path so the operator picks the env var.
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('no_acknowledgement')
  })

  it('renderConsentBlock surfaces the hash and tool descriptions', () => {
    const hash = computeConsentHash(input)
    const block = renderConsentBlock(input, hash)
    expect(block).toContain(`Consent hash: ${hash}`)
    expect(block).toContain('haven_pay_x402_quote')
    expect(block).toContain('Safe AllowanceModule')
  })

  it('uses credential allowance snapshot when live allowances are not available yet', async () => {
    const seedAllowance = [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }]
    const haven = {
      getAllowances: async () => {
        throw new Error('not active yet')
      },
    }

    const built = await consentInputFromClient(
      haven as never,
      {
        apiKey: 'sk_agent_abcdef',
        agentId: 'agent-1',
        safeAddress: '0xSafe',
        delegateAddress: '0xDelegate',
        chainId: 100,
        allowanceSummary: seedAllowance,
      },
      ['haven_get_agent'],
    )

    expect(built.allowanceSummary).toEqual(seedAllowance)
    expect(built.delegateAddress).toBe('0xDelegate')
    expect(built.chainId).toBe(100)
  })

  it('uses a successful empty live allowance list instead of the setup snapshot', async () => {
    const seedAllowance = [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }]
    const haven = {
      getAllowances: async () => ({
        safeAddress: '0xSafeLive',
        delegateAddress: '0xDelegateLive',
        chainId: 100,
        allowances: [],
      }),
    }

    const built = await consentInputFromClient(
      haven as never,
      {
        apiKey: 'sk_agent_abcdef',
        safeAddress: '0xSafe',
        delegateAddress: '0xDelegate',
        chainId: 100,
        allowanceSummary: seedAllowance,
      },
      ['haven_get_agent'],
    )

    expect(built.allowanceSummary).toEqual([])
    expect(built.safeAddress).toBe('0xSafeLive')
    expect(built.delegateAddress).toBe('0xDelegateLive')
  })

  it('binds consent to live on-chain allowance instead of configured metadata', async () => {
    const haven = {
      getAllowances: async () => ({
        safeAddress: '0xSafe',
        delegateAddress: '0xDelegate',
        chainId: 100,
        allowances: [
          {
            tokenSymbol: 'USDC',
            configuredAmount: '25000000',
            resetPeriodMin: 1440,
            onchain: {
              amount: '5000000',
              resetTimeMin: 60,
            },
          },
        ],
      }),
    }

    const built = await consentInputFromClient(
      haven as never,
      {
        apiKey: 'sk_agent_abcdef',
        safeAddress: '0xSafe',
        delegateAddress: '0xDelegate',
        chainId: 100,
        allowanceSummary: [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }],
      },
      ['haven_get_agent'],
    )

    expect(built.allowanceSummary).toEqual([
      { token: 'USDC', amount: '5000000', resetMinutes: 60 },
    ])
  })
})

describe('consent block — empty allowance', () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('explains the manual-approval path when no allowance is configured', () => {
    const withoutAllowance: ConsentInput = { ...input, allowanceSummary: [] }
    const hash = computeConsentHash(withoutAllowance)
    const block = renderConsentBlock(withoutAllowance, hash)
    expect(block).toContain('On-chain allowance: none configured')
    expect(block).toContain('manual approval')
  })
})
