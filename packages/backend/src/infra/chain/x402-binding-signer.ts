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
  version: 1 | 2 | 3
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
    version: (context.payerDelegate ? 3 : context.typedDataHash ? 2 : 1) as 1 | 2 | 3,
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

/**
 * The #1690 payer-identity fields, gated for a two-phase, signer-first
 * rollout.
 *
 * Including these makes the expected context VERSION 3, which every deployed
 * v1/v2 signer refuses with the version-skew message. The signer capability
 * ships first; this flag flips only once the connector population has it —
 * an OPERATOR action per environment, never an agent's, exactly like
 * TRUST_PROXY_HOPS. Until then every emit site spreads `{}` and the wire is
 * byte-identical to pre-#1690.
 *
 * One helper rather than five inline reads, so the flip cannot be
 * half-applied: either every context carries the payer or none does.
 */
export function x402PayerContextFields(agent: {
  id: string
  delegate_address: string
}): { payerDelegate: string; payerAgentId: string } | Record<string, never> {
  if (process.env.X402_EMIT_PAYER_CONTEXT !== '1') return {}
  return {
    payerDelegate: agent.delegate_address.toLowerCase(),
    payerAgentId: agent.id,
  }
}

/**
 * The same #1690 fields in the snake_case WIRE shape the signer's tool schema
 * validates. Same gate as `x402PayerContextFields`, and the pairing is the
 * contract: whenever the signed context carries the payer, every wire copy of
 * that context must too, or no signer can rebuild the message it verifies.
 */
export function x402PayerWireFields(agent: {
  id: string
  delegate_address: string
}): { payer_delegate: string; payer_agent_id: string } | Record<string, never> {
  if (process.env.X402_EMIT_PAYER_CONTEXT !== '1') return {}
  return {
    payer_delegate: agent.delegate_address.toLowerCase(),
    payer_agent_id: agent.id,
  }
}
