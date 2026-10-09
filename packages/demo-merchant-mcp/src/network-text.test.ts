import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { generateInvoice, renderInvoiceText } from './invoice.js'
import { networkDisplayName, networkLogLabel } from './products.js'
import { buildMerchantMcpServer } from './server.js'
import type { X402PaymentProcessor } from './x402.js'

// #3834: the merchant names its ACTUAL network in every copy. Mainnet strings
// are pinned as literals (byte-for-byte unchanged, #1550); Base Sepolia names
// itself and marks the testnet, in both languages.

const MAINNET = 8453
const SEPOLIA = 84532

async function connect(chainId: number): Promise<Client> {
  const server = buildMerchantMcpServer({
    merchantAddress: '0x1111111111111111111111111111111111111111',
    baseUrl: 'http://localhost:0',
    buildPaymentRequired: (() => {
      throw new Error('not used')
    }) as unknown as X402PaymentProcessor['buildPaymentRequired'],
    chainId,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
}

async function listText(client: Client, locale: 'en' | 'sv'): Promise<string> {
  const res = (await client.callTool({ name: 'list_products', arguments: { locale } })) as {
    content: Array<{ text: string }>
  }
  return res.content[0].text
}

const INVOICE_PARAMS = {
  invoiceNumber: 'FAK-2026-00099',
  productId: 'storage_50gb' as const,
  buyerAddress: '0x2222222222222222222222222222222222222222',
  authorizationNonce: `0x${'ab'.repeat(32)}`,
  txHash: `0x${'cd'.repeat(32)}` as const,
  settlement: 'settled_onchain' as const,
  payerRole: 'agent_delegate' as const,
}

describe('network display names (single source: CHAINS)', () => {
  it('names each chain per language; mainnet is the bare name', () => {
    expect(networkDisplayName(MAINNET, 'en')).toBe('Base')
    expect(networkDisplayName(MAINNET, 'sv')).toBe('Base')
    expect(networkDisplayName(SEPOLIA, 'en')).toBe('Base Sepolia testnet')
    expect(networkDisplayName(SEPOLIA, 'sv')).toBe('Base Sepolia testnät')
  })

  it('startup-log labels are unchanged', () => {
    expect(networkLogLabel(MAINNET)).toBe('Base mainnet')
    expect(networkLogLabel(SEPOLIA)).toBe('Base Sepolia testnet')
  })
})

describe('invoice network text', () => {
  it('mainnet: betalningssatt and both renders are byte-identical to the pre-#3834 text', () => {
    const inv = generateInvoice({ ...INVOICE_PARAMS, chainId: MAINNET })
    expect(inv.json.betalningssatt).toBe('Kryptovaluta (USDC på Base)')
    expect(renderInvoiceText(inv.json, 'X', 'en', MAINNET)).toContain('  Payment method:    Cryptocurrency (USDC on Base)\n')
    expect(renderInvoiceText(inv.json, 'X', 'sv', MAINNET)).toContain('Kryptovaluta (USDC på Base)')
  })

  it('Base Sepolia: betalningssatt and both renders name the testnet', () => {
    const inv = generateInvoice({ ...INVOICE_PARAMS, chainId: SEPOLIA })
    expect(inv.json.betalningssatt).toBe('Kryptovaluta (USDC på Base Sepolia testnät)')
    const en = renderInvoiceText(inv.json, 'X', 'en', SEPOLIA)
    expect(en).toContain('  Payment method:    Cryptocurrency (USDC on Base Sepolia testnet)\n')
    expect(en).not.toContain('USDC on Base)')
    const sv = renderInvoiceText(inv.json, 'X', 'sv', SEPOLIA)
    expect(sv).toContain('Kryptovaluta (USDC på Base Sepolia testnät)')
    expect(sv).not.toContain('USDC på Base)')
  })
})

describe('tool descriptions and list_products footers', () => {
  it('mainnet: descriptions and both footers are byte-identical to today', async () => {
    const client = await connect(MAINNET)
    const tools = (await client.listTools()).tools
    expect(tools.find((t) => t.name === 'buy_vpn')!.description).toContain(
      'Buy a NordShield VPN subscription. Payment via x402 (USDC on Base). settlement_method is optional',
    )
    expect(tools.find((t) => t.name === 'buy_cloud_storage')!.description).toContain(
      'Buy CloudNest cloud storage. Payment via x402 (USDC on Base). settlement_method is optional',
    )
    expect(await listText(client, 'en')).toContain(
      "Payment happens via x402 (USDC on Base) and must be signed by the buyer's wallet or agent runtime.",
    )
    expect(await listText(client, 'sv')).toContain(
      'Betalning sker via x402 (USDC på Base) och måste signeras av köparens wallet eller agentruntime.',
    )
  })

  it('Base Sepolia: descriptions and both footers name the testnet', async () => {
    const client = await connect(SEPOLIA)
    const tools = (await client.listTools()).tools
    for (const name of ['buy_vpn', 'buy_cloud_storage']) {
      const d = tools.find((t) => t.name === name)!.description!
      expect(d).toContain('Payment via x402 (USDC on Base Sepolia testnet).')
      expect(d).not.toContain('USDC on Base)')
    }
    const en = await listText(client, 'en')
    expect(en).toContain('Payment happens via x402 (USDC on Base Sepolia testnet) and must be signed')
    expect(en).not.toContain('USDC on Base)')
    const sv = await listText(client, 'sv')
    expect(sv).toContain('Betalning sker via x402 (USDC på Base Sepolia testnät) och måste signeras')
    expect(sv).not.toContain('USDC på Base)')
  })
})
