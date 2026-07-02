import { describe, expect, it } from 'vitest'
import { base, baseSepolia } from 'viem/chains'
import { decodeFunctionData } from 'viem'
import {
  ERC20_ABI,
  chainForId,
  encodeUsdcTransferCall,
  watchOnlyOwner,
  wrapSessionSignature,
} from './session-rail.js'

const TO = ('0x' + 'cc'.repeat(20)) as `0x${string}`
const PERMISSION_ID = ('0x' + '11'.repeat(32)) as `0x${string}`
const SIG = ('0x' + '22'.repeat(65)) as `0x${string}`

describe('chainForId', () => {
  it('maps supported chain ids', () => {
    expect(chainForId(8453)).toBe(base)
    expect(chainForId(84532)).toBe(baseSepolia)
  })

  it('throws on an unsupported chain id', () => {
    expect(() => chainForId(1)).toThrow(/unsupported chainId 1/)
  })
})

describe('encodeUsdcTransferCall', () => {
  it('encodes an ERC-20 transfer to the recipient and amount', () => {
    const data = encodeUsdcTransferCall(TO, 40_000n)
    expect(data.slice(0, 10)).toBe('0xa9059cbb') // transfer(address,uint256)
    const { functionName, args } = decodeFunctionData({ abi: ERC20_ABI, data })
    expect(functionName).toBe('transfer')
    expect((args[0] as string).toLowerCase()).toBe(TO)
    expect(args[1]).toBe(40_000n)
  })
})

describe('wrapSessionSignature', () => {
  it('produces distinct encodings per signature and per permissionId', () => {
    const a = wrapSessionSignature(PERMISSION_ID, SIG)
    const b = wrapSessionSignature(PERMISSION_ID, SIG)
    const c = wrapSessionSignature(PERMISSION_ID, ('0x' + '33'.repeat(65)) as `0x${string}`)
    const d = wrapSessionSignature(('0x' + '44'.repeat(32)) as `0x${string}`, SIG)
    expect(a).toBe(b) // deterministic
    expect(a).not.toBe(c) // signature is bound in
    expect(a).not.toBe(d) // permissionId is bound in
    expect(a.startsWith('0x')).toBe(true)
  })
})

describe('watchOnlyOwner (non-custody)', () => {
  const owner = watchOnlyOwner(('0x' + 'ab'.repeat(20)) as `0x${string}`)

  it('exposes the address for account derivation', () => {
    expect(owner.address.toLowerCase()).toBe('0x' + 'ab'.repeat(20))
  })

  it('refuses to sign — the backend must never hold the owner key', async () => {
    await expect(owner.signMessage({ message: 'x' })).rejects.toThrow(/non-custody/)
    await expect(
      owner.signTypedData({ types: {}, primaryType: 'X', message: {} } as never),
    ).rejects.toThrow(/non-custody/)
  })
})
