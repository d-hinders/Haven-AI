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
 * serialisation with low-s and v = 27/28, same recovery verdicts, and the same
 * refusals (high-s twin, wrong lengths) — with three stated strict-direction
 * exceptions, see `hexBytes`. Raw ECDSA over the hash — never the EIP-191
 * prefixed digest.
 */

/** secp256k1 order / 2 — a signature with s above this is the malleable twin ethers rejects. */
const HALF_N = BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0')

/**
 * Stricter than ethers, never looser: the lowercase `0x` prefix and the exact
 * byte length are required. Ethers accepts an uppercase `0X` prefix on a
 * signature and the 64-byte EIP-2098 compact form, and is inconsistent on a
 * private key (`Wallet` accepts unprefixed and refuses `0X`; `SigningKey` does
 * the reverse); every such form is refused here — the divergences are pinned
 * in `edge-signing.test.ts` with ethers control assertions, and every
 * well-formed input is byte-equivalent.
 */
function hexBytes(value: string, bytes: number, what: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(value) || value.length !== 2 + bytes * 2) {
    throw new Error(`${what} must be a 0x-prefixed ${bytes}-byte hex string`)
  }
  return value.slice(2)
}

export function addressFromKey(privateKey: string): string {
  try {
    // Same gate as signHash: a key that derives an address must also sign.
    return privateKeyToAddress(`0x${hexBytes(privateKey, 32, 'private key')}`)
  } catch (err) {
    throw new HavenSigningError(
      `Invalid private key: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function signHash(privateKey: string, hash: string): string {
  try {
    const { r, s, recovery } = secp256k1.sign(hexBytes(hash, 32, 'hash'), hexBytes(privateKey, 32, 'private key'), { lowS: true })
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
    const sig = hexBytes(signature, 65, 'signature')
    const hashHex = hexBytes(hash, 32, 'hash')
    // Reject the high-s malleable twin, as ethers does — one signature per message.
    if (BigInt(`0x${sig.slice(64, 128)}`) > HALF_N) return false
    const yParityOrV = Number.parseInt(sig.slice(128), 16)
    const recoveryBit = yParityOrV === 0 || yParityOrV === 27 ? 0 : yParityOrV === 1 || yParityOrV === 28 ? 1 : -1
    if (recoveryBit < 0) return false
    const publicKey = secp256k1.Signature.fromCompact(sig.slice(0, 128))
      .addRecoveryBit(recoveryBit)
      .recoverPublicKey(hashHex)
      .toHex(false)
    const recovered = publicKeyToAddress(`0x${publicKey}`)
    return recovered.toLowerCase() === expectedAddress.toLowerCase()
  } catch {
    return false
  }
}
