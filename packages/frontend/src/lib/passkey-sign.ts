'use client'

import {
  concatHex,
  encodeAbiParameters,
  hexToBytes,
  pad,
  size,
  toHex,
  type Address,
} from 'viem'
import { getPasskeyAssertion } from '@/lib/passkey'
import type { PasskeySigner } from '@/lib/signer'

// Safe's on-chain WebAuthn verifier expects the JSON tail after `"challenge"`,
// not the parsed object. Current browsers serialize `clientDataJSON` in this
// compact order, so we strip the prefix with a regex and preserve the remaining
// bytes exactly. If a browser changes field order or whitespace, replace this
// with a parse-and-reserialize implementation that preserves the expected tail.
const CLIENT_DATA_FIELDS_RE = /^\{"type":"webauthn.get","challenge":"[A-Za-z0-9\-_]{43}",(.*)\}$/

function decodeClientDataFields(clientDataJSON: `0x${string}`): string {
  const json = new TextDecoder().decode(hexToBytes(clientDataJSON))
  const match = json.match(CLIENT_DATA_FIELDS_RE)
  if (!match) {
    throw new Error('challenge not found in clientDataJSON')
  }
  return match[1]
}

function decodeDerSignature(signatureDER: `0x${string}`): { r: bigint; s: bigint } {
  const bytes = hexToBytes(signatureDER)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const check = (condition: boolean) => {
    if (!condition) {
      throw new Error('invalid signature encoding')
    }
  }

  const readInt = (offset: number): [bigint, number] => {
    check(view.getUint8(offset) === 0x02)
    const length = view.getUint8(offset + 1)
    const start = offset + 2
    const end = start + length
    const valueBytes = bytes.slice(start, end)
    const value = BigInt(toHex(valueBytes))
    return [value, end]
  }

  check(view.getUint8(0) === 0x30)
  check(view.getUint8(1) === view.byteLength - 2)

  const [r, sOffset] = readInt(2)
  const [s] = readInt(sOffset)
  return { r, s }
}

function encodeInnerWebAuthnSignature(args: {
  authenticatorData: `0x${string}`
  clientDataFields: string
  r: bigint
  s: bigint
}): `0x${string}` {
  return encodeAbiParameters(
    [
      { name: 'authenticatorData', type: 'bytes' },
      { name: 'clientDataFields', type: 'string' },
      { name: 'r', type: 'uint256' },
      { name: 's', type: 'uint256' },
    ],
    [
      args.authenticatorData,
      args.clientDataFields,
      args.r,
      args.s,
    ],
  )
}

function encodeSafeContractSignature(signerAddress: Address, innerSignature: `0x${string}`): `0x${string}` {
  return concatHex([
    pad(signerAddress, { size: 32 }),
    toHex(65, { size: 32 }),
    toHex(0, { size: 1 }),
    toHex(size(innerSignature), { size: 32 }),
    innerSignature,
  ])
}

export async function signSafeHashWithPasskey(args: {
  signer: PasskeySigner
  safeTxHash: `0x${string}`
}): Promise<{ signature: `0x${string}` }> {
  const assertion = await getPasskeyAssertion({
    challenge: hexToBytes(args.safeTxHash),
    allowCredentialIds: [args.signer.credentialId],
  })

  const { r, s } = decodeDerSignature(assertion.signatureDER)
  const clientDataFields = decodeClientDataFields(assertion.clientDataJSON)
  const innerSignature = encodeInnerWebAuthnSignature({
    authenticatorData: assertion.authenticatorData,
    clientDataFields,
    r,
    s,
  })

  return {
    signature: encodeSafeContractSignature(args.signer.address, innerSignature),
  }
}
