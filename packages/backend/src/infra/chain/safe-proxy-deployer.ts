/**
 * Safe proxy deployment on-chain calls (#994 extraction from
 * routes/safe-deploy.ts, shared with routes/safe-exec.ts for the passkey
 * signer factory deploy both routes need).
 *
 * Does NOT belong on the `ChainClient` port: CREATE2 address prediction,
 * the Safe `setup()` calldata shape, and the passkey signer factory are all
 * specific to the legacy rail's own contracts — there is no delegation-rail
 * equivalent to substitute against, so a generic interface would be
 * speculative. Moved here purely to get `ethers` (`Contract`, `Interface`,
 * `getCreate2Address`, `keccak256`, `solidityPacked`,
 * `solidityPackedKeccak256`, `ZeroAddress`, `getAddress`) out of
 * `routes/**`. Every function below is a verbatim relocation of what used
 * to be route-local — no logic changed.
 */
import {
  Contract,
  Interface,
  ZeroAddress,
  getAddress,
  getCreate2Address,
  keccak256,
  solidityPacked,
  solidityPackedKeccak256,
  type Wallet,
} from 'ethers'
import { withRelayerSendLock } from '../relayer.js'

const SAFE_SETUP_ABI = [
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
] as const

const PROXY_FACTORY_ABI = [
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function proxyCreationCode() view returns (bytes)',
  'event ProxyCreation(address proxy, address singleton)',
] as const

const PASSKEY_SIGNER_FACTORY_ABI = [
  'function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address signer)',
] as const

const SAFE_SETUP_IFACE = new Interface(SAFE_SETUP_ABI)
const PROXY_FACTORY_IFACE = new Interface(PROXY_FACTORY_ABI)

interface SafeProxyFactoryContract {
  createProxyWithNonce(singleton: string, initializer: string, saltNonce: bigint): Promise<{
    hash: string
    wait(): Promise<{ logs: Array<{ address?: string; topics?: string[]; data?: string }> } | null>
  }>
  proxyCreationCode(): Promise<string>
}

interface PasskeySignerFactoryContract {
  createSigner(x: bigint, y: bigint, verifiers: bigint): Promise<{
    hash: string
    wait(): Promise<unknown>
  }>
}

/** `SAFE_SETUP_IFACE.encodeFunctionData('setup', ...)` for a single-owner (the passkey signer), threshold-1 Safe. */
export function encodeSafeSetupCalldata(args: { owner: string; fallbackHandler: string }): string {
  return SAFE_SETUP_IFACE.encodeFunctionData('setup', [
    [args.owner],
    1n,
    ZeroAddress,
    '0x',
    args.fallbackHandler,
    ZeroAddress,
    0n,
    ZeroAddress,
  ])
}

export function predictSafeProxyAddress(args: {
  factoryAddress: string
  singletonAddress: string
  initializer: string
  saltNonce: bigint
  proxyCreationCode: string
}): string {
  const deploymentData = solidityPacked(
    ['bytes', 'uint256'],
    [args.proxyCreationCode, BigInt(args.singletonAddress)],
  )
  const salt = solidityPackedKeccak256(
    ['bytes32', 'uint256'],
    [keccak256(args.initializer), args.saltNonce],
  )

  return getCreate2Address(
    args.factoryAddress,
    salt,
    keccak256(deploymentData),
  )
}

export function extractSafeAddressFromReceipt(
  factoryAddress: string,
  receipt: { logs: Array<{ address?: string; topics?: string[]; data?: string }> },
): string {
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== factoryAddress.toLowerCase()) {
      continue
    }

    try {
      const parsed = PROXY_FACTORY_IFACE.parseLog({
        topics: log.topics ?? [],
        data: log.data ?? '0x',
      })
      if (parsed?.name === 'ProxyCreation') {
        return getAddress(parsed.args[0])
      }
    } catch {
      // Ignore unrelated logs from the same tx.
    }
  }

  throw new Error('Safe deployment transaction succeeded but ProxyCreation event not found')
}

/** `provider.getCode` for the relayer's own provider — '0x' when unconfigured, matching the pre-#994 inline check. */
export async function getRelayerProviderCode(relayer: Wallet, address: string): Promise<string> {
  const provider = relayer.provider
  return provider ? await provider.getCode(address) : '0x'
}

export function getProxyFactoryContract(factoryAddress: string, relayer: Wallet): SafeProxyFactoryContract {
  return new Contract(factoryAddress, PROXY_FACTORY_ABI, relayer) as unknown as SafeProxyFactoryContract
}

function getPasskeySignerFactoryContract(
  factoryAddress: string,
  relayer: Wallet,
): PasskeySignerFactoryContract {
  return new Contract(factoryAddress, PASSKEY_SIGNER_FACTORY_ABI, relayer) as unknown as PasskeySignerFactoryContract
}

/**
 * Deploy the passkey signer contract if it isn't already deployed — shared
 * by safe-deploy (new Safe) and safe-exec (an existing Safe whose signer
 * somehow wasn't deployed yet).
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
