/**
 * The passkey SIGNER factory deploy, kept for `routes/safe-exec.ts` (#994
 * extraction; trimmed by #1988).
 *
 * This file used to own Safe proxy deployment too — `encodeSafeSetupCalldata`,
 * `predictSafeProxyAddress`, `extractSafeAddressFromReceipt` and
 * `getProxyFactoryContract`. `routes/safe-deploy.ts` was their only caller and
 * it is a 410 tombstone as of epic #1440 slice 5, so they are deleted with it.
 *
 * What remains is reached from `POST /safe/exec`, which deliberately stays
 * OPEN: it is owner-signed Safe execution relayed for gas only, and it is how
 * an owner still moves funds out of an account they hold. A passkey-owned
 * Safe whose signer contract was never deployed cannot verify a signature at
 * all, so `ensurePasskeySignerDeployed` is part of that path, not part of the
 * retired inflow.
 *
 * ⚠️ This half of #1755 is therefore NOT buried by the retirement: the bare
 * `tx.wait()` below is still live and still has no durable outbound record.
 * See #1755 and the #1988 pull request.
 *
 * Does NOT belong on the `ChainClient` port: the passkey signer factory is
 * specific to the legacy rail's own contracts — there is no delegation-rail
 * equivalent to substitute against, so a generic interface would be
 * speculative. It lives here purely to keep `ethers` out of `routes/**`.
 */
import { Contract, type Wallet } from 'ethers'
import { withRelayerSendLock } from '../relayer.js'

const PASSKEY_SIGNER_FACTORY_ABI = [
  'function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address signer)',
] as const

interface PasskeySignerFactoryContract {
  createSigner(x: bigint, y: bigint, verifiers: bigint): Promise<{
    hash: string
    wait(): Promise<unknown>
  }>
}

/** `provider.getCode` for the relayer's own provider — '0x' when unconfigured, matching the pre-#994 inline check. */
export async function getRelayerProviderCode(relayer: Wallet, address: string): Promise<string> {
  const provider = relayer.provider
  return provider ? await provider.getCode(address) : '0x'
}

function getPasskeySignerFactoryContract(
  factoryAddress: string,
  relayer: Wallet,
): PasskeySignerFactoryContract {
  return new Contract(factoryAddress, PASSKEY_SIGNER_FACTORY_ABI, relayer) as unknown as PasskeySignerFactoryContract
}

/**
 * Deploy the passkey signer contract if it isn't already deployed. Reached
 * only from `POST /safe/exec` now that safe-deploy is a tombstone: an existing
 * Safe whose signer contract somehow was never deployed.
 */
export async function ensurePasskeySignerDeployed(args: {
  chainId: number
  relayer: Wallet
  factoryAddress: string
  signerAddress: string
  x: `0x${string}`
  y: `0x${string}`
  verifierAddress: string
}): Promise<void> {
  const code = await getRelayerProviderCode(args.relayer, args.signerAddress)
  if (code !== '0x') {
    return
  }

  const signerFactory = getPasskeySignerFactoryContract(args.factoryAddress, args.relayer)

  // Broadcast under the per-chain send lock so the signer deploy can't race
  // another relayer submission for the same EOA nonce (#692/#718).
  const tx = await withRelayerSendLock(args.chainId, () =>
    signerFactory.createSigner(
      BigInt(args.x),
      BigInt(args.y),
      BigInt(args.verifierAddress),
    ),
  )
  await tx.wait()
}
