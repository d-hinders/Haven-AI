/**
 * x402 binding-signer identity (#994 extraction from routes/x402.ts and
 * routes/agent-connection-setups.ts).
 *
 * Does NOT belong on the `ChainClient` port: this is a single dedicated
 * off-chain signing key (`X402_BINDING_PRIVATE_KEY`) used to authenticate
 * x402 "expected context" to the edge signer — the same key regardless of
 * which execution rail the paying agent is on, and no RPC call is involved
 * (no provider, no chain read). A per-rail interface would be speculative
 * for something that never varies by rail. Moved here, rather than left
 * inline in two routes, purely to get the direct `ethers` import out of
 * `routes/**` (#994's zero-tolerance `chain-sdk-not-in-routes` rule) and to
 * stop the address-derivation logic from being defined twice.
 */
import { ethers } from 'ethers'
import { buildX402ExpectedMessage, type X402ExpectedContext } from '@haven_ai/sdk'

/**
 * Sign an x402 "expected context" with the dedicated binding-signer key, so
 * the edge signer can verify it against `HAVEN_X402_BINDING_SIGNER`.
 *
 * Deliberately never falls back to `RELAYER_PRIVATE_KEY` — the binding
 * signer must be a dedicated key, not the relayer's.
 */
export async function signX402ExpectedContext(context: X402ExpectedContext): Promise<{
  version: 1 | 2
  message: string
  signature: string
  signer: string
}> {
  const privateKey = process.env.X402_BINDING_PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      'X402_BINDING_PRIVATE_KEY must be set to authenticate x402 expected context. ' +
        'Do not fall back to RELAYER_PRIVATE_KEY — the binding signer must be a dedicated key ' +
        'so that the edge signer can verify it against HAVEN_X402_BINDING_SIGNER.',
    )
  }
  const wallet = new ethers.Wallet(privateKey)
  const message = buildX402ExpectedMessage(context)
  return {
    // Derived from the context, never chosen here: a v2 context carries a
    // typed-data commitment and a v1 one does not. Announcing a version the
    // message does not match is precisely the downgrade the signer rejects.
    version: (context.typedDataHash ? 2 : 1) as 1 | 2,
    message,
    signature: await wallet.signMessage(message),
    signer: wallet.address,
  }
}

/**
 * Resolve the binding signer's public address without needing the private
 * key — `HAVEN_X402_BINDING_SIGNER` overrides the derived address for
 * deployments that hold only the public address here. Read fresh per call:
 * this backs a low-frequency connect-time endpoint, not a hot path.
 */
export function resolveX402BindingSignerAddress(): string | null {
  const explicit = process.env.HAVEN_X402_BINDING_SIGNER?.trim()
  if (explicit) {
    try {
      return ethers.getAddress(explicit)
    } catch {
      console.warn('HAVEN_X402_BINDING_SIGNER is not a valid address; ignoring.')
    }
  }

  const privateKey = process.env.X402_BINDING_PRIVATE_KEY?.trim()
  if (!privateKey) return null
  try {
    return new ethers.Wallet(privateKey).address
  } catch {
    console.warn('X402_BINDING_PRIVATE_KEY is set but invalid; cannot derive the x402 binding signer.')
    return null
  }
}
