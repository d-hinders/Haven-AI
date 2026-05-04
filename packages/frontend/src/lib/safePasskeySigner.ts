import type { Address, Hex } from 'viem'
import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  zeroHash,
} from 'viem'
import { getSafeWebAuthnSignerFactoryDeployment } from '@safe-global/safe-modules-deployments'
import safeWebAuthnSignerProxyArtifact from '@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerProxy.sol/SafeWebAuthnSignerProxy.json'

import { getChainConfig } from '@/lib/chains'

export interface SafePasskeyConfig {
  factoryAddress: Address
  verifierAddress: Address
  singletonAddress: Address
}

const SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE = safeWebAuthnSignerProxyArtifact.bytecode as Hex

/**
 * Pure CREATE2 prediction. Does NOT make network calls.
 * Mirrors what `SafeWebAuthnSignerFactory.getSigner(x, y, verifier)` returns
 * on-chain (and what `createSigner(...)` would deploy).
 */
export function predictSafePasskeySignerAddress(args: {
  x: `0x${string}`
  y: `0x${string}`
  chainId: number
}): Address {
  const config = getSafePasskeyConfig(args.chainId)
  const initCode = concatHex([
    SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE,
    encodeAbiParameters(
      [
        { name: 'singleton', type: 'address' },
        { name: 'x', type: 'uint256' },
        { name: 'y', type: 'uint256' },
        { name: 'verifiers', type: 'uint176' },
      ],
      [
        config.singletonAddress,
        BigInt(args.x),
        BigInt(args.y),
        BigInt(config.verifierAddress),
      ],
    ),
  ])

  return getContractAddress({
    opcode: 'CREATE2',
    from: config.factoryAddress,
    salt: zeroHash,
    bytecodeHash: keccak256(initCode),
  })
}

export const getSafePasskeySignerAddress = predictSafePasskeySignerAddress

export function getSafePasskeyConfig(chainId: number): SafePasskeyConfig {
  const chain = getChainConfig(chainId)
  const factoryDeployment = getSafeWebAuthnSignerFactoryDeployment({ network: chainId.toString() })
  const factoryAddress = factoryDeployment?.networkAddresses[chainId.toString()]

  if (!factoryAddress) {
    throw new Error(`Unsupported passkey signer chain: ${chainId}`)
  }

  const checksummedFactoryAddress = getAddress(factoryAddress)

  return {
    factoryAddress: checksummedFactoryAddress,
    verifierAddress: chain.passkey.verifier,
    // The factory constructor deploys the singleton first, so its CREATE nonce is always 1.
    singletonAddress: getContractAddress({
      opcode: 'CREATE',
      from: checksummedFactoryAddress,
      nonce: 1n,
    }),
  }
}
