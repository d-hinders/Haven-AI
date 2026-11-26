/**
 * @haven_ai/merchant-payments — the payment core shared by the demo merchant
 * and the paywall proxy (#4890; design in docs/architecture/12-merchant-kit.md).
 *
 * It carries the receipt (`x-receipt-json`), the buyer's tax-declaration check,
 * and the Coinbase payment core: the checks made before a payment is verified
 * (`payment-checks`), settlement through Coinbase's facilitator with the chain
 * as judge (`cdp`, `cdp-settlement`), the settle-exactly-once coordinator
 * (`settle-once`) and the consumed-payment store it records into, plus the
 * sale reporter (`sale-report`, #4950) that tells Haven about a settled sale
 * with the merchant's Sales key, and its `merchant_reference`. The code
 * here takes every merchant-specific value as a parameter: it has no built-in
 * seller, product table, chain, USDC address, support contact or VAT rule, and
 * it reads no environment variable.
 */
export * from './receipt.js'
export * from './tax-declaration.js'
export * from './checkout-details.js'
export * from './log-range.js'
export * from './cdp.js'
export * from './payment-checks.js'
export * from './cdp-settlement.js'
export * from './authorization-digest.js'
export * from './consumed-payment-store.js'
export * from './settle-once.js'
export * from './merchant-reference.js'
export * from './sale-report.js'
