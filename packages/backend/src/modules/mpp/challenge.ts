/**
 * `mpp_demo` retirement refusal (#1328). The legacy internal MPP demo flow —
 * `POST /demo/mpp/*` and the `POST /machine-payments/authorize` path that
 * authorized against it — is retired outright: zero external customers,
 * agents are directed to the deployed x402 merchant flow instead (mirrors
 * the #834 session-rail retirement's fail-closed pattern). This file used to
 * hold `validateMppDemoChallenge`, an authorization boundary pinning the
 * demo's exact price/chain/asset/expiry (#997); that boundary is now moot
 * because nothing is authorized here anymore — `mppDemoRetired()` is the
 * single producer of the refusal, called BEFORE any read or write, so a
 * retired-flow request touches the database only for agent authentication.
 *
 * Historical `mpp_demo` payment/receipt/evidence/status rows remain readable
 * through the generic `/machine-payments/*` reads (status, receipts,
 * evidence, reconciliation) — this file has no bearing on those; it only
 * ever gated the authorize-time write path.
 */
export function mppDemoRetired(): { statusCode: 410; body: { error: string } } {
  return {
    statusCode: 410,
    body: {
      error:
        'The mpp_demo flow is retired — no new legacy MPP demo challenge can be authorized. ' +
        'Use the deployed x402 merchant flow instead (haven_quote_x402 / haven_pay_x402_quote, ' +
        'or POST /x402/authorize).',
    },
  }
}
