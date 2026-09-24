/**
 * The counterfactual HybridDeleGator account address for an owner EOA (#3272).
 *
 * `haven_sign`'s unbound branch (`tools.ts`) signs a `PackedUserOperation`
 * only when its `sender` (== `domain.verifyingContract`) is THIS SIGNER'S OWN
 * delegate account — never any other HybridDeleGator, and never a third
 * party's. Haven provisions that account counterfactually at signup (#970):
 * it may have zero on-chain transactions, so the signer must be able to
 * compute its address OFFLINE, from nothing but the delegate key's own
 * address.
 *
 * This is exactly what `@metamask/smart-accounts-kit`'s
 * `getCounterfactualAccountData` computes for
 * `implementation: 'Hybrid'`, `deployParams: [owner, [], [], []]` (no passkey
 * co-owners — the only shape Haven's signup flow provisions), `deploySalt:
 * '0x'`: CREATE2 of an `ERC1967Proxy(HybridDeleGatorImpl, initialize(owner,
 * [], [], []))` behind the `SimpleFactory`.
 *
 * VENDORED, NOT IMPORTED. `@metamask/smart-accounts-kit` is a devDependency
 * only (see `package.json`) — this package installs on users' machines and
 * must not carry it at runtime. The constants below (the factory and
 * implementation addresses, the `ERC1967Proxy` bytecode) are copied from the
 * kit's pinned environment / `@metamask/delegation-abis`' bytecode export,
 * exactly like `settlement-child.ts` vendors the DelegationManager and caveat
 * enforcer addresses for the same reason. Cross-checked against the kit by
 * `delegate-account.pins.test.ts`, including against the real, on-chain
 * `direct-payment-userop.json` fixture.
 */
import {
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  pad,
  type Address,
} from 'viem'

/**
 * SimpleFactory — deterministically deployed, so Base and Base Sepolia share
 * the address (matches `packages/backend/src/rails/delegation-contracts.ts`'s
 * `simpleFactory` pin for both chains).
 */
export const SIMPLE_FACTORY_ADDRESS: Address = '0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c'

/**
 * HybridDeleGator implementation — matches `delegation-contracts.ts`'s
 * `hybridDeleGatorImpl` pin for both chains.
 */
export const HYBRID_DELEGATOR_IMPLEMENTATION: Address = '0x48dBe696A4D990079e039489bA2053B36E8FFEC4'

/**
 * `ERC1967Proxy` creation bytecode, vendored from
 * `@metamask/delegation-abis`' `bytecode` export (`ERC1967Proxy`, ~2 KB) — the
 * proxy every DeleGator account (Hybrid or otherwise) deploys behind. Every
 * MetaMask smart account on this chain family is one of these, so the
 * bytecode is effectively as stable as the framework's ABI.
 */
const ERC1967_PROXY_BYTECODE =
  '0x60806040526040516103f03803806103f08339810160408190526100229161025e565b61002c8282610033565b5050610341565b61003c82610091565b6040516001600160a01b038316907fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b905f90a280511561008557610080828261010c565b505050565b61008d61017f565b5050565b806001600160a01b03163b5f036100cb57604051634c9c8ce360e01b81526001600160a01b03821660048201526024015b60405180910390fd5b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc80546001600160a01b0319166001600160a01b0392909216919091179055565b60605f80846001600160a01b0316846040516101289190610326565b5f60405180830381855af49150503d805f8114610160576040519150601f19603f3d011682016040523d82523d5f602084013e610165565b606091505b5090925090506101768583836101a0565b95945050505050565b341561019e5760405163b398979f60e01b815260040160405180910390fd5b565b6060826101b5576101b0826101ff565b6101f8565b81511580156101cc57506001600160a01b0384163b155b156101f557604051639996b31560e01b81526001600160a01b03851660048201526024016100c2565b50805b9392505050565b80511561020f5780518082602001fd5b604051630a12f52160e11b815260040160405180910390fd5b634e487b7160e01b5f52604160045260245ffd5b5f5b8381101561025657818101518382015260200161023e565b50505f910152565b5f806040838503121561026f575f80fd5b82516001600160a01b0381168114610285575f80fd5b60208401519092506001600160401b03808211156102a1575f80fd5b818501915085601f8301126102b4575f80fd5b8151818111156102c6576102c6610228565b604051601f8201601f19908116603f011681019083821181831017156102ee576102ee610228565b81604052828152886020848701011115610306575f80fd5b61031783602083016020880161023c565b80955050505050509250929050565b5f825161033781846020870161023c565b9190910192915050565b60a38061034d5f395ff3fe6080604052600a600c565b005b60186014601a565b6050565b565b5f604b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc546001600160a01b031690565b905090565b365f80375f80365f845af43d5f803e8080156069573d5ff35b3d5ffdfea2646970667358221220fd2cc92935c943d341edacaf5318a0b9ab0185ce62ef72e95ab393ef358730c464736f6c63430008170033' as const

/** Minimal `ERC1967Proxy` ABI — only the constructor `encodeDeployData` needs. */
const ERC1967_PROXY_ABI = [
  {
    type: 'constructor',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: '_data', type: 'bytes' },
    ],
    stateMutability: 'payable',
  },
] as const

/**
 * Minimal `HybridDeleGator` ABI — only the `initialize` selector this module
 * needs, with no passkey co-owners (`_keyIds`/`_xValues`/`_yValues` empty).
 */
const HYBRID_DELEGATOR_INITIALIZE_ABI = [
  {
    type: 'function',
    name: 'initialize',
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_keyIds', type: 'string[]' },
      { name: '_xValues', type: 'uint256[]' },
      { name: '_yValues', type: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/** CREATE2 salt Haven provisions every account with (#970) — no salted variants. */
const DEPLOY_SALT = pad('0x', { size: 32 })

/**
 * Derive the counterfactual HybridDeleGator account address for `owner`, with
 * no passkey co-owners — the only shape Haven's signup flow provisions
 * (#970). Pure and offline: no RPC call, no dependency on the account having
 * been deployed. Verified byte-for-byte against
 * `@metamask/smart-accounts-kit`'s `getCounterfactualAccountData` by
 * `delegate-account.pins.test.ts`, including against a real Base Sepolia payload served by the dev backend
 * (`direct-payment-userop.json`).
 */
export function deriveDelegateAccountAddress(owner: Address): Address {
  const initData = encodeFunctionData({
    abi: HYBRID_DELEGATOR_INITIALIZE_ABI,
    functionName: 'initialize',
    args: [owner, [], [], []],
  })
  const proxyCreationCode = encodeDeployData({
    abi: ERC1967_PROXY_ABI,
    args: [HYBRID_DELEGATOR_IMPLEMENTATION, initData],
    bytecode: ERC1967_PROXY_BYTECODE,
  })
  return getContractAddress({
    bytecode: proxyCreationCode,
    from: SIMPLE_FACTORY_ADDRESS,
    opcode: 'CREATE2',
    salt: DEPLOY_SALT,
  })
}
