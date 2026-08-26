/**
 * Safe `execTransaction` on-chain calls (#994 extraction from
 * routes/safe-exec.ts).
 *
 * Does NOT belong on the `ChainClient` port: the Safe execution ABI and its
 * EIP-712 `SafeTx` type are legacy-rail specific — there is no
 * delegation-rail equivalent to substitute against. Moved here purely to
 * get `ethers` (`Contract`, `TypedDataEncoder`) out of `routes/**`. Every
 * function below is a verbatim relocation of what used to be route-local —
 * no logic changed. `ensurePasskeySignerDeployed` is NOT duplicated here;
 * it's shared with safe-deploy via `safe-proxy-deployer.ts`.
 */
import { Contract, TypedDataEncoder, type Wallet } from 'ethers'

export { ensurePasskeySignerDeployed, getRelayerProviderCode } from './safe-proxy-deployer.js'

const SAFE_EXEC_ABI = [
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'function nonce() view returns (uint256)',
  'function encodeTransactionData(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes)',
  'function checkSignatures(bytes32 dataHash,bytes data,bytes signatures) view',
] as const

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
}

export interface SafeContract {
  nonce(): Promise<bigint>
  encodeTransactionData(
    to: string,
    value: bigint,
    data: string,
    operation: number,
    safeTxGas: bigint,
    baseGas: bigint,
    gasPrice: bigint,
    gasToken: string,
    refundReceiver: string,
    nonce: bigint,
  ): Promise<string>
  checkSignatures(dataHash: string, data: string, signatures: string): Promise<void>
  execTransaction: {
    (
      to: string,
      value: bigint,
      data: string,
      operation: number,
      safeTxGas: bigint,
      baseGas: bigint,
      gasPrice: bigint,
      gasToken: string,
      refundReceiver: string,
      signatures: string,
      overrides?: { gasLimit?: bigint },
    ): Promise<{
      hash: string
      wait(confirms?: number, timeout?: number): Promise<unknown>
    }>
    staticCall(
      to: string,
      value: bigint,
      data: string,
      operation: number,
      safeTxGas: bigint,
      baseGas: bigint,
      gasPrice: bigint,
      gasToken: string,
      refundReceiver: string,
      signatures: string,
    ): Promise<boolean>
    estimateGas(
      to: string,
      value: bigint,
      data: string,
      operation: number,
      safeTxGas: bigint,
      baseGas: bigint,
      gasPrice: bigint,
      gasToken: string,
      refundReceiver: string,
      signatures: string,
    ): Promise<bigint>
  }
}

export function getSafeExecContract(safeAddress: string, relayer: Wallet): SafeContract {
  return new Contract(safeAddress, SAFE_EXEC_ABI, relayer) as unknown as SafeContract
}

export function computeSafeTxHash(body: {
  chain_id: number
  safe_address: string
  to: string
  value: string
  data: string
  operation: 0 | 1
  safe_tx_gas: string
  base_gas: string
  gas_price: string
  gas_token: string
  refund_receiver: string
  nonce: string
}): string {
  return TypedDataEncoder.hash(
    {
      chainId: body.chain_id,
      verifyingContract: body.safe_address,
    },
    SAFE_TX_TYPES,
    {
      to: body.to,
      value: BigInt(body.value),
      data: body.data,
      operation: body.operation,
      safeTxGas: BigInt(body.safe_tx_gas),
      baseGas: BigInt(body.base_gas),
      gasPrice: BigInt(body.gas_price),
      gasToken: body.gas_token,
      refundReceiver: body.refund_receiver,
      nonce: BigInt(body.nonce),
    },
  )
}
