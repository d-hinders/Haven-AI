/**
 * Entry point: `node dist/index.js`, configured by environment variables
 * (docs/architecture/12-merchant-kit.md §12). Refuses to start, with a message
 * that names what is wrong and never prints a secret, when configuration is
 * missing or invalid.
 */
import { ConfigError } from './config.js'
import { startProxy } from './main.js'
import { ProductsFileError } from './products.js'
import { StoreLockedError } from './sqlite-store.js'

async function run(): Promise<void> {
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
