/**
 * #4890: the `eth_getLogs` window logic moved to `@haven_ai/merchant-payments`
 * (`log-range.ts`), shared with the paywall proxy. Re-exported here for the
 * one importer that still names this path (`stripe-reconcile.test.ts`).
 */
export {
  DEFAULT_LOG_SPAN_BLOCKS,
  LogWindows,
  parseLogRangeLimit,
  parseMaxBlockRange,
  type LogWindowsOptions,
} from '@haven_ai/merchant-payments'
