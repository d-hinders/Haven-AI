/**
 * A mock EIP-1193 browser wallet, for specs that need `WalletButton`'s
 * CONNECTED renderings (#1944).
 *
 * ── Why this is a legitimate fixture and not a doctored render ───────────────
 *
 * The rule this repo works to (`docs/contributing/ship-playbooks/frontend.md`
 * §4, and #1930's `chain_id: 999` refusal) is that a fixture must not reach a
 * state the PRODUCT cannot. This one answers an EXTERNAL SYSTEM — a wallet
 * extension — exactly as `mockHavenApi` answers the backend and
 * `makeAllowanceChainFixture` answers a JSON-RPC node. Every line between the
 * provider and the pixel is production code: wagmi's own `injected()` connector
 * reads `window.ethereum`, `reconnect()` authorises it, RainbowKit's
 * `ConnectButtonRenderer` derives `account`/`chain` from `useAccount()`, and
 * `WalletButton` picks its branch. Nothing is handed to a component by hand.
 *
 * The two states it reaches are the two states a real user reaches by opening
 * their wallet on Base, or on any chain Haven does not offer.
 *
 * ── Why `wagmi.injected.connected` has to be seeded ─────────────────────────
 *
 * `lib/wagmi.ts` calls `injected()` with NO `target`, and a targetless injected
 * connector deliberately refuses to auto-authorise:
 *
 *     if (!parameters.target) {
 *       const connected = await config.storage?.getItem('injected.connected')
 *       if (!connected) return false
 *     }
 *
 * (`@wagmi/core/connectors/injected.js`, `isAuthorized`). That flag is what a
 * previous successful connect leaves behind, so seeding it is seeding the
 * RETURNING-USER state — which is the state a dashboard is normally opened in —
 * rather than bypassing a gate. `wagmi`'s storage prefix is `wagmi.` and its
 * serializer is JSON, hence the exact key/value shapes below.
 *
 * Without it, `reconnect()` skips the connector, `isConnected` stays false, and
 * `WalletButton` renders "Connect wallet" — a green run photographing the wrong
 * branch, which is the failure mode this whole spec family keeps paying for.
 * The specs therefore assert the rendered branch rather than trusting this.
 */
import type { Page } from '@playwright/test'

/** wagmi's default localStorage prefix (`createStorage`'s `key`). */
const WAGMI_STORAGE_PREFIX = 'wagmi'

/**
 * The connected EOA. Deliberately NOT `testSafeAddress` and not the test
 * recipient: the address is what `AddressAvatar`'s gradient is hashed from and
 * what the collapsed control's accessible name is truncated from, so reusing a
 * fixture address that appears elsewhere on the page would make a capture that
 * could not tell "the wallet's address rendered" from "some other address
 * rendered".
 */
export const connectedWalletAddress = '0x3333333333333333333333333333333333333333'

/** `truncateAddress(connectedWalletAddress)` — see `components/haven`. */
export const connectedWalletShortName = '0x3333…3333'

/** Base — a chain `lib/chains.ts` offers, so the connected branch renders. */
export const SUPPORTED_CHAIN_ID_HEX = '0x2105'

/**
 * Ethereum mainnet — a REAL chain that Haven does not offer
 * (`SUPPORTED_CHAIN_IDS` is Base + Base Sepolia). Chosen deliberately over an
 * invented id: #1930 declined to redden `ErrorBoundary` with `chain_id: 999`
 * because a fixture could produce a capture the product cannot, and the same
 * discipline applies here in the opposite direction — a user whose wallet is on
 * Ethereum mainnet is the ordinary way this state happens.
 */
export const UNSUPPORTED_CHAIN_ID_HEX = '0x1'

/**
 * Install the mock wallet BEFORE any app code runs, and mark it as previously
 * authorised so wagmi's mount-time `reconnect()` adopts it.
 *
 * The provider answers only what the connect path asks for and THROWS on
 * anything else, with EIP-1193's `4200 Unsupported Method`. That is the point:
 * a silent `undefined` for an unanticipated method would surface as an
 * unrelated decode failure or an empty render several layers later, which is
 * the shape #1935 built its `gaps` counter to stop being invisible.
 */
export async function installInjectedWallet(
  page: Page,
  options: { chainIdHex: string; address?: string },
): Promise<void> {
  await page.addInitScript(
    ({ address, chainIdHex, prefix }) => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
      const provider = {
        isMetaMask: true,
        async request({ method }: { method: string }) {
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [address]
            case 'eth_chainId':
              return chainIdHex
            case 'net_version':
              return String(Number.parseInt(chainIdHex, 16))
            default:
              throw Object.assign(
                new Error(`injected-wallet fixture: unstubbed JSON-RPC method ${method}`),
                { code: 4200 },
              )
          }
        },
        on(event: string, handler: (...args: unknown[]) => void) {
          const existing = listeners.get(event) ?? []
          existing.push(handler)
          listeners.set(event, existing)
        },
        removeListener(event: string, handler: (...args: unknown[]) => void) {
          listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== handler))
        },
      }
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        configurable: true,
        writable: true,
      })
      // JSON, because that is what wagmi's `createStorage` serializer writes.
      window.localStorage.setItem(`${prefix}.injected.connected`, JSON.stringify(true))
      window.localStorage.setItem(`${prefix}.recentConnectorId`, JSON.stringify('injected'))
    },
    {
      address: options.address ?? connectedWalletAddress,
      chainIdHex: options.chainIdHex,
      prefix: WAGMI_STORAGE_PREFIX,
    },
  )
}
