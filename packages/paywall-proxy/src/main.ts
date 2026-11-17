/**
 * Starting the proxy: read the environment once, validate everything, open the
 * payments database (refusing to start when another process holds it), build
 * the Coinbase facilitator client and the chain reader, then listen. Any
 * problem is reported by name, never by secret value, and the process does not
 * come up half-configured.
 */
import { createServer, type Server } from 'node:http'
import {
  createCdpChainReader,
  createCdpFacilitator,
  createViemChainReadClient,
  type CdpSettlementConfig,
} from '@haven_ai/merchant-payments'
import { loadConfig, secretValues, type ProxyConfig } from './config.js'
import { createProxyHandler } from './handler.js'
import { createLogger, installConsoleRedaction, type LogFn } from './log.js'
import { loadProductsFile, type Product } from './products.js'
import { openSqliteConsumedPaymentStore, type SqliteConsumedPaymentStore } from './sqlite-store.js'

export interface RunningProxy {
  server: Server
  config: ProxyConfig
  products: readonly Product[]
  store: SqliteConsumedPaymentStore
  port: number
  close(): Promise<void>
}

export interface StartOverrides {
  /** Tests inject the facilitator and the chain reader; the real ones are built from the credentials and RPC URL. */
  cdp?: CdpSettlementConfig
  fetchImpl?: typeof fetch
  log?: LogFn
  settleResolveMs?: number
  settlePollMs?: number
  now?: () => Date
}

export async function startProxy(env: Readonly<Record<string, string | undefined>>, overrides: StartOverrides = {}): Promise<RunningProxy> {
  const config = loadConfig(env)
  const products = loadProductsFile(config.productsFile)
  const log = overrides.log ?? createLogger(secretValues(config))
  const restoreConsole = installConsoleRedaction(secretValues(config))

  let store: SqliteConsumedPaymentStore
  try {
    store = openSqliteConsumedPaymentStore(config.paymentsDb, { takeoverAfterMs: config.upstreamTimeoutMs + 30_000 })
  } catch (err) {
    restoreConsole()
    throw err
  }
  try {
    const cdp: CdpSettlementConfig = overrides.cdp ?? {
      facilitator: await createCdpFacilitator(config.cdp),
      chain: createCdpChainReader(createViemChainReadClient(config.rpcUrl, config.chain.chainId), {
        usdcAddress: config.chain.usdcAddress,
      }),
    }
    const handler = createProxyHandler({
      config,
      products,
      store,
      cdp,
      log,
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      ...(overrides.settleResolveMs !== undefined ? { settleResolveMs: overrides.settleResolveMs } : {}),
      ...(overrides.settlePollMs !== undefined ? { settlePollMs: overrides.settlePollMs } : {}),
      ...(overrides.now ? { now: overrides.now } : {}),
    })
    const server = createServer((req, res) => {
      void handler(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : config.port
    log('started', {
      port,
      network: config.chain.network,
      network_label: config.chain.label,
      pay_to: config.payTo,
      operator: config.operatorName,
      products: products.map((p) => p.id),
      base_path: config.basePath,
      // Sales reporting (#4898) and receipts (#4913) are not built yet.
      sales_reporting: 'off',
      receipt: 'off',
    })
    return {
      server,
      config,
      products,
      store,
      port,
      close: () =>
        new Promise<void>((resolve) => {
          const finish = (): void => {
            store.close()
            restoreConsole()
            resolve()
          }
          if (!server.listening) return finish()
          server.close(finish)
          server.closeAllConnections()
        }),
    }
  } catch (err) {
    store.close()
    restoreConsole()
    throw err
  }
}
