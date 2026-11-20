/**
 * Starting the proxy: read the environment once, validate everything, open the
 * payments database (refusing to start when another process holds it), build
 * the Coinbase facilitator client and the chain reader, then listen. Any
 * problem is reported by name, never by secret value, and the process does not
 * come up half-configured.
 */
import { statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import {
  createCdpChainReader,
  createCdpFacilitator,
  createViemChainReadClient,
  reportSale,
  type CdpSettlementConfig,
  type SaleRecord,
  type SaleReportOutcome,
} from '@haven_ai/merchant-payments'
import { loadConfig, secretValues, type ProxyConfig } from './config.js'
import { createProxyHandler } from './handler.js'
import type { LimitSettings } from './limits.js'
import { createLogger, installConsoleRedaction, type LogFn } from './log.js'
import { loadProductsFile, type Product } from './products.js'
import { createSalesReporter, type SalesReporter } from './sales.js'
import { openSalesOutbox, type SalesOutbox } from './sales-outbox.js'
import { openSqliteConsumedPaymentStore, type SqliteConsumedPaymentStore } from './sqlite-store.js'

export interface RunningProxy {
  server: Server
  config: ProxyConfig
  products: readonly Product[]
  store: SqliteConsumedPaymentStore
  /** The sales reporter, present only when reporting is on (§5). */
  sales?: SalesReporter
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
  /** Tests only: a holder deadline shorter than the config allows. */
  reservationDeadlineMs?: number
  /** Tests only: the deployed proxy uses the design's limits (§7). */
  limits?: Partial<LimitSettings>
  now?: () => Date
  /** Tests only: the reporter's resend waits (§5's 1 s, 4 s and 16 s in the deployment). */
  salesRetryDelaysMs?: readonly number[]
  /** Tests only: one attempt's limit before it counts as a timeout. */
  salesAttemptTimeoutMs?: number
  /** Tests only: the outbox's replay interval (§5's 60 s in the deployment). */
  salesOutboxReplayMs?: number
}

export async function startProxy(env: Readonly<Record<string, string | undefined>>, overrides: StartOverrides = {}): Promise<RunningProxy> {
  const config = loadConfig(env)
  const products = loadProductsFile(config.productsFile)
  const updated = productsFileUpdatedAt(config.productsFile)
  const log = overrides.log ?? createLogger(secretValues(config))
  const restoreConsole = installConsoleRedaction(secretValues(config))

  let store: SqliteConsumedPaymentStore
  try {
    store = openSqliteConsumedPaymentStore(config.paymentsDb, { takeoverAfterMs: config.upstreamTimeoutMs + 30_000 })
  } catch (err) {
    restoreConsole()
    throw err
  }
  let outbox: SalesOutbox | undefined
  try {
    const cdp: CdpSettlementConfig = overrides.cdp ?? {
      facilitator: await createCdpFacilitator(config.cdp),
      chain: createCdpChainReader(createViemChainReadClient(config.rpcUrl, config.chain.chainId), {
        usdcAddress: config.chain.usdcAddress,
      }),
    }
    // §5, §12: the sales reporter and its outbox, only when a merchant key is
    // configured. The outbox's own attempt is the core reporter with no inline
    // resends, so the outbox's 60 s cadence is the retry.
    let sales: SalesReporter | undefined
    if (config.sales !== undefined) {
      const settings = config.sales
      outbox = openSalesOutbox({
        path: settings.outboxPath,
        log,
        ...(overrides.salesOutboxReplayMs !== undefined ? { replayIntervalMs: overrides.salesOutboxReplayMs } : {}),
        send: async (record: SaleRecord, key: string): Promise<SaleReportOutcome> => {
          const outcome = await reportSale({
            havenBaseUrl: settings.havenBaseUrl,
            salesKey: settings.merchantKey,
            record,
            retryDelaysMs: [],
            ...(overrides.salesAttemptTimeoutMs !== undefined
              ? { attemptTimeoutMs: overrides.salesAttemptTimeoutMs }
              : {}),
            log: (event, fields) => log(event, fields),
          })
          // §5: the store's flag records that the sale reached Haven, however it got there.
          if (outcome.outcome === 'accepted') await store.markSaleReported(key)
          return outcome
        },
      })
      sales = createSalesReporter({
        settings,
        chainId: config.chain.chainId,
        store,
        outbox,
        log,
        ...(overrides.salesRetryDelaysMs !== undefined ? { retryDelaysMs: overrides.salesRetryDelaysMs } : {}),
        ...(overrides.salesAttemptTimeoutMs !== undefined
          ? { attemptTimeoutMs: overrides.salesAttemptTimeoutMs }
          : {}),
      })
      outbox.start()
    }
    const handler = createProxyHandler({
      config,
      products,
      ...(updated !== undefined ? { updated } : {}),
      store,
      cdp,
      log,
      ...(sales !== undefined ? { sales } : {}),
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      ...(overrides.settleResolveMs !== undefined ? { settleResolveMs: overrides.settleResolveMs } : {}),
      ...(overrides.settlePollMs !== undefined ? { settlePollMs: overrides.settlePollMs } : {}),
      ...(overrides.reservationDeadlineMs !== undefined ? { reservationDeadlineMs: overrides.reservationDeadlineMs } : {}),
      ...(overrides.limits ? { limits: overrides.limits } : {}),
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
    // §11: a test network with a VAT rule and no seller details starts and
    // sends no receipt; the warning says so, and names no secret.
    for (const warning of config.warnings) log('warning', { message: warning })
    log('started', {
      port,
      network: config.chain.network,
      network_label: config.chain.label,
      pay_to: config.payTo,
      operator: config.operatorName,
      products: products.map((p) => p.id),
      base_path: config.basePath,
      // §12: the public default is named; a configured URL is never printed,
      // because a provider URL can embed a key (#5006).
      rpc: config.rpcUrlDefault ? 'default (public Base Sepolia)' : 'configured',
      sales_reporting: config.salesStatus,
      ...(sales !== undefined ? { sales_outbox_depth: sales.outboxDepth() } : {}),
      receipt: config.receiptStatus,
    })
    return {
      server,
      config,
      products,
      store,
      ...(sales !== undefined ? { sales } : {}),
      port,
      close: () =>
        new Promise<void>((resolve) => {
          const finish = (): void => {
            outbox?.stop()
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
    outbox?.stop()
    store.close()
    restoreConsole()
    throw err
  }
}

/**
 * §4: the discovery document's `updated`, the products file's last change. The
 * file was read a moment ago, so a failure here only drops an optional field.
 */
function productsFileUpdatedAt(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return undefined
  }
}
