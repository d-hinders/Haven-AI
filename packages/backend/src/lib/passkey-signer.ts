import {
  AbiCoder,
  ZeroHash,
  concat,
  getAddress,
  getCreate2Address,
  getCreateAddress,
  keccak256,
} from 'ethers'
import { getChain } from './chains.js'

export interface SafePasskeyConfig {
  factoryAddress: string
  verifierAddress: string
  singletonAddress: string
}

// Extracted from the live v0.2.1 SafeWebAuthnSignerFactory deployment's embedded proxy literal.
// The npm package currently ships @safe-global/safe-passkey@0.2.0 bytecode, which predicts the
// wrong signer addresses for the deployed factory.
const SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE = '0x610100346100ad57601f6101b538819003918201601f19168301916001600160401b038311848410176100b2578084926080946040528339810103126100ad578051906001600160a01b03821682036100ad5760208101516040820151606090920151926001600160b01b03841684036100ad5760805260a05260c05260e05260405160ec90816100c98239608051816082015260a05181604d015260c051816027015260e0518160010152f35b600080fd5b634e487b7160e01b600052604160045260246000fdfe7f000000000000000000000000000000000000000000000000000000000000000060b63601527f000000000000000000000000000000000000000000000000000000000000000060a03601527f000000000000000000000000000000000000000000000000000000000000000036608001523660006080376000806056360160807f00000000000000000000000000000000000000000000000000000000000000005af43d600060803e60b1573d6080fd5b3d6080f3fea26469706673582212201660515548d15702d720bbc046b457ca85e941a4559ab9f9518488e4c82e5ee964736f6c634300081a0033'

/**
 * Pure CREATE2 prediction. Mirrors the frontend implementation in
 * packages/frontend/src/lib/safePasskeySigner.ts. Both must agree.
 */
export function predictSafePasskeySignerAddress(args: {
  x: `0x${string}`
  y: `0x${string}`
  chainId: number
}): string {
  const config = getSafePasskeyConfig(args.chainId)
  const initCode = concat([
    SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE,
    AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256', 'uint256', 'uint176'],
      [
        config.singletonAddress,
        BigInt(args.x),
        BigInt(args.y),
        // The factory source casts Verifiers.unwrap(...) to uint256, but ABI-encoding a uint176
        // produces the same 32-byte word because the value is left-padded either way.
        BigInt(config.verifierAddress),
      ],
    ),
  ])

  return getCreate2Address(
    config.factoryAddress,
    ZeroHash,
    keccak256(initCode),
  )
}

export function getSafePasskeyConfig(chainId: number): SafePasskeyConfig {
  const chain = getChain(chainId)
  const factoryAddress = getAddress(chain.passkey.factoryAddress)

  return {
    factoryAddress,
    verifierAddress: chain.passkey.verifier,
    // The factory constructor deploys the singleton first, so its CREATE nonce is always 1.
    singletonAddress: getCreateAddress({
      from: factoryAddress,
      nonce: 1,
    }),
  }
}
