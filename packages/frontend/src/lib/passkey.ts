type Hex = `0x${string}`

const COSE_KEY_KTY = 1
const COSE_KEY_ALG = 3
const COSE_KEY_CRV = -1
const COSE_KEY_X = -2
const COSE_KEY_Y = -3

const COSE_KTY_EC2 = 2
const COSE_ALG_ES256 = -7
const COSE_CRV_P256 = 1

const AUTH_DATA_MIN_LENGTH = 37
const ATTESTED_CREDENTIAL_DATA_FLAG = 0x40

const textDecoder = new TextDecoder()

type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | Map<string | number, CborValue>

interface CborReadResult {
  bytesRead: number
  value: CborValue
}

export interface PasskeyCreationResult {
  credentialId: string
  publicKey: { x: Hex; y: Hex }
  rawAttestationObject: ArrayBuffer
  rawClientDataJSON: ArrayBuffer
}

export interface PasskeyAssertion {
  credentialId: string
  signatureDER: Hex
  authenticatorData: Hex
  clientDataJSON: Hex
}

export class PasskeyUnsupportedError extends Error {
  constructor(message = 'Passkeys require WebAuthn support in a secure browser context.') {
    super(message)
    this.name = 'PasskeyUnsupportedError'
  }
}

export class PasskeyCancelledError extends Error {
  constructor(message = 'Passkey request was cancelled.') {
    super(message)
    this.name = 'PasskeyCancelledError'
  }
}

export async function createPasskey(opts: {
  rpId?: string
  rpName?: string
  userId: Uint8Array
  userName: string
  userDisplayName: string
}): Promise<PasskeyCreationResult> {
  const credentials = getCredentialsContainer()
  const challenge = getRandomBytes(32)

  try {
    const credential = await credentials.create({
      publicKey: {
        challenge: asArrayBuffer(challenge),
        rp: {
          id: opts.rpId ?? getDefaultRpId(),
          name: opts.rpName ?? 'Haven',
        },
        user: {
          id: asArrayBuffer(opts.userId),
          name: opts.userName,
          displayName: opts.userDisplayName,
        },
        pubKeyCredParams: [{ type: 'public-key', alg: COSE_ALG_ES256 }],
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
        attestation: 'none',
      },
    })

    if (!isAttestationCredential(credential)) {
      throw new Error('WebAuthn credential creation returned an unexpected response.')
    }

    const attestationObject = toUint8Array(credential.response.attestationObject)
    const { credentialPublicKey } = extractAttestedCredentialData(attestationObject)

    return {
      credentialId: base64UrlEncode(credential.rawId),
      publicKey: decodeCoseP256PublicKey(credentialPublicKey),
      rawAttestationObject: credential.response.attestationObject.slice(0),
      rawClientDataJSON: credential.response.clientDataJSON.slice(0),
    }
  } catch (error) {
    throw normalizePasskeyError(error)
  }
}

export async function getPasskeyAssertion(opts: {
  rpId?: string
  challenge: Uint8Array
  allowCredentialIds?: string[]
}): Promise<PasskeyAssertion> {
  const credentials = getCredentialsContainer()

  try {
    const credential = await credentials.get({
      publicKey: {
        challenge: asArrayBuffer(opts.challenge),
        rpId: opts.rpId ?? getDefaultRpId(),
        userVerification: 'required',
        allowCredentials: opts.allowCredentialIds?.map((credentialId) => ({
          type: 'public-key',
          id: asArrayBuffer(base64UrlDecode(credentialId)),
        })),
      },
    })

    if (!isAssertionCredential(credential)) {
      throw new Error('WebAuthn assertion returned an unexpected response.')
    }

    return {
      credentialId: base64UrlEncode(credential.rawId),
      signatureDER: bytesToHex(credential.response.signature),
      authenticatorData: bytesToHex(credential.response.authenticatorData),
      clientDataJSON: bytesToHex(credential.response.clientDataJSON),
    }
  } catch (error) {
    throw normalizePasskeyError(error)
  }
}

/**
 * Decode a COSE_Key (RFC 8152) for an EC2 key on the secp256r1 (P-256) curve
 * into 32-byte x/y coordinates. Throws if the key isn't EC2 / P-256.
 */
export function decodeCoseP256PublicKey(coseKey: Uint8Array): { x: Hex; y: Hex } {
  const decoded = decodeCbor(coseKey)

  if (!(decoded instanceof Map)) {
    throw new Error('Expected COSE key to decode to a CBOR map.')
  }

  const kty = expectCoseNumber(decoded.get(COSE_KEY_KTY), 'kty')
  const alg = expectCoseNumber(decoded.get(COSE_KEY_ALG), 'alg')
  const crv = expectCoseNumber(decoded.get(COSE_KEY_CRV), 'crv')
  const x = expectCoseBytes(decoded.get(COSE_KEY_X), 'x')
  const y = expectCoseBytes(decoded.get(COSE_KEY_Y), 'y')

  if (kty !== COSE_KTY_EC2) {
    throw new Error(`Expected COSE kty=2 (EC2), received ${kty}.`)
  }

  if (alg !== COSE_ALG_ES256) {
    throw new Error(`Expected COSE alg=-7 (ES256), received ${alg}.`)
  }

  if (crv !== COSE_CRV_P256) {
    throw new Error(`Expected COSE crv=1 (P-256), received ${crv}.`)
  }

  return {
    x: bytesToHex(padCoordinate(x, 'x')),
    y: bytesToHex(padCoordinate(y, 'y')),
  }
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''

  for (const value of input) {
    binary += String.fromCharCode(value)
  }

  return encodeBase64(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const binary = decodeBase64(padded)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

function getCredentialsContainer(): CredentialsContainer {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new PasskeyUnsupportedError()
  }

  return navigator.credentials
}

function getDefaultRpId(): string {
  if (typeof window === 'undefined' || !window.location.hostname) {
    throw new PasskeyUnsupportedError('Unable to resolve a relying party ID outside the browser.')
  }

  return window.location.hostname
}

function getRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new PasskeyUnsupportedError('Web Crypto is required for passkey creation.')
  }

  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

function extractAttestedCredentialData(attestationObject: Uint8Array): {
  credentialId: Uint8Array
  credentialPublicKey: Uint8Array
} {
  const decoded = decodeCbor(attestationObject)

  if (!(decoded instanceof Map)) {
    throw new Error('Expected attestationObject to decode to a CBOR map.')
  }

  const authData = decoded.get('authData')
  if (!(authData instanceof Uint8Array)) {
    throw new Error('Expected attestationObject authData to be bytes.')
  }

  if (authData.length < AUTH_DATA_MIN_LENGTH) {
    throw new Error('Authenticator data is too short to contain attested credential data.')
  }

  const flags = authData[32]
  if ((flags & ATTESTED_CREDENTIAL_DATA_FLAG) === 0) {
    throw new Error('Authenticator data does not include attested credential data.')
  }

  let offset = AUTH_DATA_MIN_LENGTH
  offset += 16 // AAGUID

  if (authData.length < offset + 2) {
    throw new Error('Authenticator data is missing the credential ID length.')
  }

  const credentialIdLength = (authData[offset] << 8) | authData[offset + 1]
  offset += 2

  if (authData.length < offset + credentialIdLength) {
    throw new Error('Authenticator data is truncated before the credential ID.')
  }

  const credentialId = authData.slice(offset, offset + credentialIdLength)
  offset += credentialIdLength

  const credentialPublicKeyResult = readCborItem(authData, offset)
  const credentialPublicKey = authData.slice(offset, offset + credentialPublicKeyResult.bytesRead)

  return { credentialId, credentialPublicKey }
}

function decodeCbor(bytes: Uint8Array): CborValue {
  return readCborItem(bytes, 0).value
}

function readCborItem(bytes: Uint8Array, offset: number): CborReadResult {
  if (offset >= bytes.length) {
    throw new Error('Unexpected end of CBOR data.')
  }

  const initialByte = bytes[offset]
  const majorType = initialByte >> 5
  const additionalInfo = initialByte & 0x1f

  switch (majorType) {
    case 0:
    case 1: {
      const { length, bytesRead } = readCborLength(bytes, offset, additionalInfo)
      const value = majorType === 0 ? length : -1 - length
      return { value, bytesRead }
    }
    case 2: {
      const { length, bytesRead } = readCborLength(bytes, offset, additionalInfo)
      const start = offset + bytesRead
      const end = start + length
      ensureRange(bytes, start, end)
      return { value: bytes.slice(start, end), bytesRead: bytesRead + length }
    }
    case 3: {
      const { length, bytesRead } = readCborLength(bytes, offset, additionalInfo)
      const start = offset + bytesRead
      const end = start + length
      ensureRange(bytes, start, end)
      return { value: textDecoder.decode(bytes.slice(start, end)), bytesRead: bytesRead + length }
    }
    case 4: {
      const { length, bytesRead } = readCborLength(bytes, offset, additionalInfo)
      let cursor = offset + bytesRead
      const items: CborValue[] = []

      for (let i = 0; i < length; i += 1) {
        const item = readCborItem(bytes, cursor)
        items.push(item.value)
        cursor += item.bytesRead
      }

      return { value: items, bytesRead: cursor - offset }
    }
    case 5: {
      const { length, bytesRead } = readCborLength(bytes, offset, additionalInfo)
      let cursor = offset + bytesRead
      const map = new Map<string | number, CborValue>()

      for (let i = 0; i < length; i += 1) {
        const keyResult = readCborItem(bytes, cursor)
        cursor += keyResult.bytesRead
        const valueResult = readCborItem(bytes, cursor)
        cursor += valueResult.bytesRead

        if (typeof keyResult.value !== 'string' && typeof keyResult.value !== 'number') {
          throw new Error('Unsupported CBOR map key type.')
        }

        map.set(keyResult.value, valueResult.value)
      }

      return { value: map, bytesRead: cursor - offset }
    }
    case 7:
      return readCborSimpleValue(bytes, offset, additionalInfo)
    default:
      throw new Error(`Unsupported CBOR major type ${majorType}.`)
  }
}

function readCborLength(
  bytes: Uint8Array,
  offset: number,
  additionalInfo: number,
): { bytesRead: number; length: number } {
  if (additionalInfo < 24) {
    return { length: additionalInfo, bytesRead: 1 }
  }

  const lengthBytes = 1 << (additionalInfo - 24)
  if (additionalInfo < 24 || additionalInfo > 27) {
    throw new Error(`Unsupported CBOR additional info ${additionalInfo}.`)
  }

  const start = offset + 1
  const end = start + lengthBytes
  ensureRange(bytes, start, end)

  let length = 0
  for (let i = start; i < end; i += 1) {
    length = (length * 256) + bytes[i]
  }

  return { length, bytesRead: 1 + lengthBytes }
}

function readCborSimpleValue(bytes: Uint8Array, offset: number, additionalInfo: number): CborReadResult {
  switch (additionalInfo) {
    case 20:
      return { value: false, bytesRead: 1 }
    case 21:
      return { value: true, bytesRead: 1 }
    case 22:
      return { value: null, bytesRead: 1 }
    default:
      throw new Error(`Unsupported CBOR simple value ${additionalInfo}.`)
  }
}

function ensureRange(bytes: Uint8Array, start: number, end: number): void {
  if (start > bytes.length || end > bytes.length) {
    throw new Error('Unexpected end of CBOR data.')
  }
}

function expectCoseNumber(value: CborValue | undefined, label: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Expected COSE ${label} to be a number.`)
  }

  return value
}

function expectCoseBytes(value: CborValue | undefined, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`Expected COSE ${label} to be bytes.`)
  }

  return value
}

function padCoordinate(bytes: Uint8Array, label: string): Uint8Array {
  if (bytes.length > 32) {
    throw new Error(`Expected COSE ${label} to be at most 32 bytes, received ${bytes.length}.`)
  }

  if (bytes.length === 32) {
    return bytes
  }

  const padded = new Uint8Array(32)
  padded.set(bytes, 32 - bytes.length)
  return padded
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): Hex {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return `0x${Array.from(input, (value) => value.toString(16).padStart(2, '0')).join('')}`
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength)
  new Uint8Array(buffer).set(value)
  return buffer
}

function isAttestationCredential(
  credential: Credential | null,
): credential is PublicKeyCredential & { response: AuthenticatorAttestationResponse } {
  return Boolean(
    credential
      && credential instanceof PublicKeyCredential
      && 'attestationObject' in credential.response,
  )
}

function isAssertionCredential(
  credential: Credential | null,
): credential is PublicKeyCredential & { response: AuthenticatorAssertionResponse } {
  return Boolean(
    credential
      && credential instanceof PublicKeyCredential
      && 'signature' in credential.response,
  )
}

function normalizePasskeyError(error: unknown): Error {
  if (error instanceof PasskeyUnsupportedError || error instanceof PasskeyCancelledError) {
    return error
  }

  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return new PasskeyCancelledError()
  }

  if (error instanceof Error) {
    return error
  }

  return new Error('Unknown passkey error.')
}

function encodeBase64(binary: string): string {
  if (typeof btoa === 'function') {
    return btoa(binary)
  }

  return Buffer.from(binary, 'binary').toString('base64')
}

function decodeBase64(base64: string): string {
  if (typeof atob === 'function') {
    return atob(base64)
  }

  return Buffer.from(base64, 'base64').toString('binary')
}
