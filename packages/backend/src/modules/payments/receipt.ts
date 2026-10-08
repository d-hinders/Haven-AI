import { findSettledPaymentReceiptRow } from '../../infra/repositories/payment-intents.js'
import { buyerPartyFromJoin, type BuyerJoinColumns } from '../../infra/repositories/owner-company-details.js'
import { config } from '../../config.js'
import { withParties } from '../../openapi/party-model.js'
import {
  RECEIPT_VERSION,
  verifyPaymentReceipt,
  type PaymentReceipt,
  type ReceiptVerification,
} from '@haven_ai/sdk'

/**
 * Backend wiring for verifiable payment receipts (non-custody design P2, #479).
 *
 * The receipt shape and the independent verifier live in `@haven_ai/sdk` (so
 * agents/users can verify client-side with zero Haven trust); this module only
 * adds the DB-specific assembly. Re-exported here for callers in the backend.
 */
export { RECEIPT_VERSION, verifyPaymentReceipt }
export type { PaymentReceipt, ReceiptVerification }

export interface PaymentReceiptRow extends Partial<BuyerJoinColumns> {
  id: string
  account_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_human: string
  delegate_address: string
  sign_hash: string
  signature: string | null
  tx_hash: string | null
  confirmed_at: string | null
  resource_url: string | null
  amount_sek: string | null
  /** #2960: `machine_metadata.delegate_account_address` — absent (undefined) on rows read by older callers, null for intents authorized before #2960. */
  delegate_account_address?: string | null
  /**
   * #3418: the rail the intent ran on — `delegation`, `direct`, or null
   * (legacy AllowanceModule / rows read by older callers). Optional so rows
   * read by the pre-#3418 SQL keep typing.
   */
  execution_rail?: string | null
  /**
   * #3418: `machine_metadata.settlement_scheme` — `erc7710`, `eip3009`, or
   * null (direct / retired rails / rows without the metadata).
   */
  settlement_scheme?: string | null
  /**
   * #3770: the owning agent's evidence-only delivery verdict, joined from
   * `machine_payment_delivery_reports`. Null while unreported; additive on
   * the receipt (`payment.deliveryQuality`) and ignored by the verifier,
   * which reads only `authorization`.
   */
  delivery_quality?: string | null
  delivery_note?: string | null
  delivery_reported_at?: string | null
}

/**
 * Pure mapping DB row → receipt bundle.
 *
 * #2907: `payment.account` is an additive same-value twin of `payment.safe`
 * — `account` is free on this shape (no other field on `payment` already
 * claims that name, unlike `sign_data.components`, where `account` already
 * means the delegate account and a twin there is named `payer_account`
 * instead). `PaymentReceipt` is a published `@haven_ai/sdk` type
 * (byte-identical, no source change in this slice), so the literal is built
 * with the extra field and widened with a type assertion rather than
 * changing the SDK interface. Verification is unaffected: `verifyPaymentReceipt`
 * recovers the signer from the STORED `authorization.signHash` — it never
 * recomputes a hash over `payment`, so an additive field here changes nothing
 * about what a signature covers.
 *
 * #2960: `payment.parties` is additive the same way — `verifyPaymentReceipt`
 * reads only `receipt.authorization`, never `payment`, so this changes
 * nothing about what is verified. `delegate_account` is `row.delegate_account_address`
 * (`machine_metadata.delegate_account_address`, written at authorize on both
 * delegation-rail legs) — null on rows authorized before #2960.
 */
/**
 * #3418: which digest the delegate signed, derived from the row (additive,
 * optional on the published `PaymentReceipt`, so a type assertion widens the
 * literal the same way `account`/`parties` already do).
 *
 * `machine_metadata.settlement_scheme = 'erc7710'` → `'eip712_delegation'`
 * (the settlement child's struct hash is `sign_hash`; the verifier rebuilds
 * the EIP-712 digest). Any other delegation row — the eip3009 funding leg —
 * → `'eip712_userop'` (an ERC-4337 userOpHash the bundle does not carry).
 * Direct and retired rails leave it absent (raw-signed `sign_hash`).
 *
 * The value only selects which digest the verifier rebuilds; a lying one
 * cannot make a forged signature verify, because recovery must still return
 * `authorization.delegate`.
 */
function signatureSchemeFor(row: PaymentReceiptRow): 'eip712_delegation' | 'eip712_userop' | undefined {
  if (row.settlement_scheme === 'erc7710') return 'eip712_delegation'
  if (row.execution_rail === 'delegation') return 'eip712_userop'
  return undefined
}

export function buildPaymentReceipt(row: PaymentReceiptRow): PaymentReceipt {
  const signatureScheme = signatureSchemeFor(row)
  return {
    version: RECEIPT_VERSION,
    paymentId: row.id,
    payment: withParties(
      {
        token: row.token_symbol,
        tokenAddress: row.token_address,
        amount: row.amount_human,
        amountSek: row.amount_sek,
        recipient: row.to_address,
        safe: row.account_address,
        account: row.account_address,
        chainId: row.chain_id,
        settledAt: row.confirmed_at,
        resourceUrl: row.resource_url,
        // #3770: additive — the agent's own delivery verdict, when reported.
        // `verifyPaymentReceipt` reads only `authorization`, so this changes
        // nothing about what a signature covers (same rule as `parties`).
        // camelCase like the rest of the bundle; null while unreported.
        deliveryQuality:
          row.delivery_quality == null
            ? null
            : {
                quality: row.delivery_quality as 'ok' | 'unusable' | 'partial',
                note: row.delivery_note ?? null,
                reportedAt: row.delivery_reported_at ?? null,
              },
      },
      {
        account_address: row.account_address,
        delegate_address: row.delegate_address,
        delegate_account_address: row.delegate_account_address ?? null,
        merchant_address: row.to_address,
        // #3332: additive, flag-gated — see `buyerPartyFromJoin`'s own doc.
        buyer_details: buyerPartyFromJoin(
          {
            buyer_legal_name: row.buyer_legal_name ?? null,
            buyer_country: row.buyer_country ?? null,
            buyer_org_number: row.buyer_org_number ?? null,
            buyer_vat_number: row.buyer_vat_number ?? null,
            buyer_vies_status: row.buyer_vies_status ?? null,
            buyer_vies_checked_at: row.buyer_vies_checked_at ?? null,
          },
          config.ownerCompanyDetailsEnabled,
        ),
      },
    ) as PaymentReceipt['payment'],
    authorization: {
      delegate: row.delegate_address,
      signHash: row.sign_hash,
      signature: row.signature,
      // #3418: additive — a type assertion widens the literal, exactly like
      // `payment.account` above. Only selects which digest the verifier
      // rebuilds; recovery must still return `delegate`.
      ...(signatureScheme === undefined ? {} : { signatureScheme }),
    } as PaymentReceipt['authorization'],
    onChain: { txHash: row.tx_hash, chainId: row.chain_id },
  }
}

/** Load a settled payment's receipt for the owning agent. Null if not found. */
export async function getPaymentReceipt(
  paymentId: string,
  agentId: string,
): Promise<PaymentReceipt | null> {
  const row = await findSettledPaymentReceiptRow(paymentId, agentId)
  return row ? buildPaymentReceipt(row) : null
}
