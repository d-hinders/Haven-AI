#!/usr/bin/env node
/**
 * #4853: reconcile settled joke payments against Stripe.
 *
 * Lists the settled payments to the Stripe deposit address that have no
 * PaymentIntent, and records them. Only EIP-3009 transfers of the product's
 * exact price are recorded; any other transfer to the address is listed as
 * "not recorded" and left alone.
 *
 * This file is a thin wrapper: the logic lives in `src/stripe-reconcile.ts`
 * and `src/reconcile-cli.ts`, under the money-path list, because it creates
 * live PaymentIntents. Build first (`npm run build -w packages/demo-merchant-mcp`).
 *
 * Run it inside the merchant service's environment, as a one-off command using
 * that service's variables — never with the key exported to a local shell:
 *
 *   npm run reconcile:stripe -w packages/demo-merchant-mcp -- \
 *     --from-block 12345678 --to-block 12349999
 *
 * The report carries transaction hashes and PaymentIntent IDs only.
 */
import { main } from '../dist/reconcile-stripe.js'

process.exitCode = await main(process.argv.slice(2))
