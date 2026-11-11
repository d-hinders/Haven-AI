/**
 * #4808 — a payment-status message names a tool the reading agent cannot call.
 *
 * `packages/backend/src/modules/payments/agent-payment-status.ts` returns two
 * `message` strings that name `haven_report_settlement_evidence`, a tool only
 * the hosted MCP registers:
 *
 *   - phase `delivered_unverified`, next action `stop_and_tell_user`;
 *   - phase `payment_submitted`, next action `awaiting_settlement_evidence`.
 *
 * The message reaches the agent verbatim on two client surfaces that cannot
 * report a settlement hash at all — the local MCP's `haven_get_payment_status`
 * handler and the SDK's own `executeTool('get_payment_status')` — so the
 * instruction is unreachable for the agent reading it.
 *
 * Both layers replace `message` whole in those two states, keyed on the
 * STRUCTURED fields (`phase`, `nextAction`) and never on the backend's
 * sentence, so a reworded backend message cannot silently disable the
 * replacement.
 *
 * The replacement names no tool for reporting: the local package stays
 * deliberately smaller than hosted (owner decision 2026-11-10 on #4788), so
 * there is no report tool to name. It says the merchant delivered, that
 * Haven's settlement sweep may still attribute the payment, and to tell the
 * user if it stays unverified.
 *
 * Placement: applied by the two client layers, NEVER inside the shared read.
 * The hosted MCP calls the same SDK helper
 * (`getPaymentStatusWithPostPurchaseAllowance`), and a replacement placed
 * there would silently take the correct instruction away from the hosted
 * agent — whose four backend pins would not notice.
 */
import { AgentPaymentNextAction, AgentPaymentPhase } from './types.js'

/** The structured fields the replacement keys on, plus the message it replaces. */
export interface SettlementEvidenceStatus {
  phase?: string
  nextAction?: string
  message?: string
}

/**
 * The replacement text for one surface. `pollToolName` is the name of the
 * status tool the reading agent can actually call: `haven_get_payment_status`
 * on the local MCP, `get_payment_status` in the SDK's own tool set.
 */
export function settlementEvidenceMessages(pollToolName: string): {
  deliveredUnverified: string
  awaitingSettlementEvidence: string
} {
  return {
    deliveredUnverified:
      'This payment is settled no further than it was: the merchant delivered, but the settlement window and the sweep\'s last chance to verify a settlement have both passed with no verified on-chain evidence. Polling cannot change this — tell the user the goods were delivered but Haven holds no verified settlement evidence for this payment.',
    awaitingSettlementEvidence:
      'The settlement window passed with no verified on-chain evidence for this payment\'s settlement yet. Haven\'s settlement sweep can still attribute it until shortly after this payment\'s expiry — poll ' +
      pollToolName +
      ' once more a couple of minutes past that. If it still shows no evidence, the goods were delivered but Haven holds no verified settlement evidence for this payment; tell the user.',
  }
}

/**
 * Replace `message` whole in the two states, and pass it through unchanged in
 * every other state. Returns a new object in the two replaced states; the
 * input is never mutated.
 */
export function replaceSettlementEvidenceMessage<T extends SettlementEvidenceStatus>(
  status: T,
  pollToolName: string,
): T {
  const messages = settlementEvidenceMessages(pollToolName)
  if (status.phase === AgentPaymentPhase.DeliveredUnverified) {
    return { ...status, message: messages.deliveredUnverified }
  }
  if (status.nextAction === AgentPaymentNextAction.AwaitingSettlementEvidence) {
    return { ...status, message: messages.awaitingSettlementEvidence }
  }
  return status
}
