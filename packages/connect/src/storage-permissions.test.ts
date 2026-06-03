import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('node:fs/promises', () => fsMocks)

describe('writeCredentialFiles permission warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('warns when credential permissions cannot be restricted', async () => {
    const { writeCredentialFiles } = await import('./storage.js')
    fsMocks.access.mockRejectedValue({ code: 'ENOENT' })
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.rm.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
    fsMocks.chmod.mockRejectedValue(new Error('chmod denied'))

    const warnings: string[] = []
    await writeCredentialFiles({
      baseDir: '/tmp/haven-connect',
      agentId: 'agent-1',
      apiKey: 'sk_agent_secret',
      delegateKey: `0x${'11'.repeat(32)}`,
      apiUrl: 'https://api.haven.example',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
      warn: (message) => warnings.push(message),
    })

    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.join('\n')).toMatch(/chmod 600|chmod 700/)
    expect(warnings.join('\n')).not.toContain('sk_agent_secret')
    expect(warnings.join('\n')).not.toContain('1111111111111111111111111111111111111111111111111111111111111111')
  })

  it('removes the signer credential if identity credential writing fails', async () => {
    const { writeCredentialFiles } = await import('./storage.js')
    fsMocks.access.mockRejectedValue({ code: 'ENOENT' })
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.chmod.mockResolvedValue(undefined)
    fsMocks.rm.mockResolvedValue(undefined)
    fsMocks.writeFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('identity write failed'))

    await expect(writeCredentialFiles({
      baseDir: '/tmp/haven-connect',
      agentId: 'agent-1',
      apiKey: 'sk_agent_secret',
      delegateKey: `0x${'11'.repeat(32)}`,
      apiUrl: 'https://api.haven.example',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
    })).rejects.toThrow('identity write failed')

    expect(fsMocks.rm).toHaveBeenCalledWith('/tmp/haven-connect/agent-1/signer.json', { force: true })
  })
})
