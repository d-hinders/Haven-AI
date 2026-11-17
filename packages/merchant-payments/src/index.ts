/**
 * @haven_ai/merchant-payments — the payment core shared by the demo merchant
 * and the paywall proxy (#4890; design in docs/architecture/12-merchant-kit.md).
 *
 * This first slice carries the receipt (`x-receipt-json`) and the buyer's
 * tax-declaration check. The code here takes every merchant-specific value as
 * a parameter: it has no built-in seller, product table, chain, support
 * contact or VAT rule, and it reads no environment variable.
 */
export * from './receipt.js'
export * from './tax-declaration.js'
