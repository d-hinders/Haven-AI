import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { loadCredentials } from './credentials.js'

describe('loadCredentials', () => {
  it('loads snake_case Haven credential files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, JSON.stringify({
      api_key: 'sk_agent_test',
      delegate_key: '0xdelegate',
      agent_id: 'agent-1',
      safe_address: '0xSafe',
      api_url: 'https://haven.example',
    }))

    await expect(loadCredentials(file)).resolves.toEqual({
      apiKey: 'sk_agent_test',
      delegateKey: '0xdelegate',
      agentId: 'agent-1',
      safeAddress: '0xSafe',
      apiUrl: 'https://haven.example',
    })
  })

  it('refuses to start without a delegate key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, JSON.stringify({ api_key: 'sk_agent_test' }))

    await expect(loadCredentials(file)).rejects.toThrow('delegate_key')
  })
})
