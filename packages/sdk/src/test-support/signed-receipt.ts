/**
 * #3723 — a REAL signed erc7710 receipt bundle for handler-level tests: the
 * delegate key signs the DelegationManager EIP-712 digest rebuilt from the
 * bundle's own `signHash` + `onChain.chainId`, exactly the math
 * `verifyPaymentReceipt` performs. So `verifyPaymentReceipt(bundle)` returns
 * `{ verified: true, verifiedOver: 'delegation_digest' }` with the DEFAULT
 * ECDSA recovery — the first positive handler-level verify fixture on the
 * MCP runtimes (no stdio-originated payment is erc7710 live: `haven_send` is
 * direct and the stdio x402 path is the eip3009 bridge).
 *
 * Published on the `@haven_ai/sdk/test-support` subpath like the UserOp
 * builder: a sibling package's tests cannot import this file by relative
 * path. Test fixtures, not a signing API: nothing the SDK or signer runs
 * imports it.
 */
import { Wallet } from 'ethers'
import { concatHex, encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem'
import { DELEGATION_MANAGER } from '../settlement-child.js'
import { RECEIPT_VERSION, type PaymentReceipt } from '../receipt.js'

/** A fixed delegate key so fixtures are deterministic across runs. */
export const RECEIPT_DELEGATE_KEY = `0x${'77'.repeat(32)}` as const
/** A distinct key, for signer_mismatch fixtures. */
export const OTHER_RECEIPT_KEY = `0x${'88'.repeat(32)}` as const

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
)

/** Same rebuild the verifier does — mirrored here so drift turns the positive test red. */
function delegationDigest(signHash: string, chainId: number): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toBytes('DelegationManager')),
        keccak256(toBytes('1')),
        BigInt(chainId),
        DELEGATION_MANAGER as Hex,
      ],
    ),
  )
  return keccak256(concatHex(['0x1901', domainSeparator, signHash as Hex]))
}

export interface SignedErc7710Options {
  /** Defaults to `RECEIPT_DELEGATE_KEY`; pass `OTHER_RECEIPT_KEY` for a forged bundle. */
  delegateKey?: string
  signHash?: string
  chainId?: number
  paymentId?: string
}

/**
 * A signed erc7710 bundle whose `authorization.signature` recovers to the
 * delegate over the delegation digest — `verifyPaymentReceipt` verifies it
 * offline with the default recovery.
 */
export function signedErc7710Receipt(options: SignedErc7710Options = {}): PaymentReceipt {
  const chainId = options.chainId ?? 84532 // Base Sepolia — a chain the SDK pins
  const signHash = options.signHash ?? (`0x${'5e'.repeat(32)}` as const)
  const delegate = new Wallet(options.delegateKey ?? RECEIPT_DELEGATE_KEY)
  const signature = delegate.signingKey.sign(delegationDigest(signHash, chainId)).serialized
  return {
    version: RECEIPT_VERSION,
    paymentId: options.paymentId ?? 'pay_3723',
    payment: {
      token: 'USDC',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '0.50',
      amountSek: '5.25',
      recipient: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      account: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      chainId,
      settledAt: '2026-10-07T10:00:00.000Z',
      resourceUrl: 'https://merchant.example/resource',
    },
    authorization: {
      delegate: delegate.address,
      signHash,
      signature,
      signatureScheme: 'eip712_delegation',
    },
    onChain: { txHash: `0x${'cd'.repeat(32)}`, chainId },
  }
}
