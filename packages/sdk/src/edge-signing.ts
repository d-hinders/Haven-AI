import { secp256k1 } from '@noble/curves/secp256k1'
import { privateKeyToAddress, publicKeyToAddress } from 'viem/accounts'
import { serializeSignature, type Hex } from 'viem'
import { HavenSigningError } from './types.js'

/**
 * #3173: the three key helpers the edge signer needs, without ethers.
 *
 * `./signer.ts` implements the same three on ethers, and the SDK barrel pulls
 * ethers in for them (and for `provider.ts` / `receipt.ts`). The edge signer
 * already ships viem, and viem signs with `@noble/curves` underneath — these
 * use the same curve library directly, synchronously (viem's own `sign` is
 * async), so `@haven_ai/sdk/edge` stays ethers-free and a signer session stops
 * paying for module init it never uses. Byte-equivalence with the ethers forms
 * is pinned in `edge-signing.test.ts`: same address, same 65-byte `r‖s‖v`
 * serialisation with low-s and v = 27/28, same recovery verdicts. Raw ECDSA
 * over the hash — never the EIP-191 prefixed digest.
 */

function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
}

export function addressFromKey(privateKey: string): string {
  try {
    return privateKeyToAddress(privateKey as Hex)
  } catch (err) {
    throw new HavenSigningError(
      `Invalid private key: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function signHash(privateKey: string, hash: string): string {
  try {
    const { r, s, recovery } = secp256k1.sign(strip0x(hash), strip0x(privateKey), { lowS: true })
    // viem serialises the trailing byte from yParity (0/1 → 27/28), the same
    // `v` ethers' `Signature.serialized` writes.
    return serializeSignature({
      r: `0x${r.toString(16).padStart(64, '0')}`,
      s: `0x${s.toString(16).padStart(64, '0')}`,
      yParity: recovery,
    })
  } catch (err) {
    throw new HavenSigningError(
      `Failed to sign hash: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function verifySignature(hash: string, signature: string, expectedAddress: string): boolean {
  try {
    const sig = strip0x(signature)
    if (sig.length !== 130) return false
    const yParityOrV = Number.parseInt(sig.slice(128), 16)
    const recoveryBit = yParityOrV === 0 || yParityOrV === 27 ? 0 : yParityOrV === 1 || yParityOrV === 28 ? 1 : -1
    if (recoveryBit < 0) return false
    const publicKey = secp256k1.Signature.fromCompact(sig.slice(0, 128))
      .addRecoveryBit(recoveryBit)
      .recoverPublicKey(strip0x(hash))
      .toHex(false)
    const recovered = publicKeyToAddress(`0x${publicKey}`)
    return recovered.toLowerCase() === expectedAddress.toLowerCase()
  } catch {
    return false
  }
}
