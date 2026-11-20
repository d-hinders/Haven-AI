/**
 * Entry point: `node dist/index.js`, configured by environment variables
 * (docs/architecture/12-merchant-kit.md §12). Refuses to start, with a message
 * that names what is wrong and never prints a secret, when configuration is
 * missing or invalid.
 *
 * Two subcommands:
 *
 * - `check` (#5008): before any real traffic, tell a developer whether the
 *   deployment will work — settings, products file, RPC, Coinbase key, Sales
 *   key, store and outbox — one line per check, non-zero when any fails. It
 *   runs with the proxy stopped and makes no call that can move money.
 * - `report-sale <tx-hash>` (#4898): send a past settled call to Haven again,
 *   for a sale whose record was cleared or never recorded. It is named in the
 *   README, and it needs the proxy stopped because it opens `PAYMENTS_DB` (§6:
 *   one process per store).
 */
import { runCheckCommand } from './check.js'
import { ConfigError } from './config.js'
import { startProxy } from './main.js'
import { ProductsFileError } from './products.js'
import { runReportSaleCommand } from './report-sale.js'
import { StoreLockedError } from './sqlite-store.js'

const USAGE =
  'Usage: haven-paywall-proxy [check | report-sale <tx-hash> [--vat-treatment SE_25|REVERSE_CHARGE] [--new-reference]]'

async function run(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'check') {
    process.exitCode = await runCheckCommand(args, process.env)
    return
  }
  if (command === 'report-sale') {
    process.exitCode = await runReportSaleCommand(args, process.env)
    return
  }
  if (command !== undefined) {
    console.error(`Unknown command "${command}". ${USAGE}`)
    process.exitCode = 2
    return
  }

  let proxy
  try {
    proxy = await startProxy(process.env)
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ProductsFileError || err instanceof StoreLockedError) {
      console.error(err.message)
    } else {
      // The class only: an upstream or driver message is not ours to print next to a key.
      console.error(`The proxy cannot start (${err instanceof Error ? err.name : 'UnknownError'}).`)
    }
    process.exit(1)
  }
  const stop = (): void => {
    void proxy.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

void run()
