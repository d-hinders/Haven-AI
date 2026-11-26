/**
 * #4946: the buyer join fragment selects EXACTLY the six buyer columns.
 *
 * `OWNER_COMPANY_DETAILS_JOIN_COLUMNS` is joined onto the `owner_company_details`
 * row, which since #4870 also holds the owner's receipt email and both
 * addresses. The buyer-block tests in `machine-payments.test.ts`,
 * `payment-intents.test.ts` and `evidence-buyer-flag.test.ts` pin the MAPPER
 * (`buyerPartyFromJoin` builds a fixed six-key object), so a column added to
 * this fragment would reach the raw row and those tests would stay green —
 * the #4943 review measured it (50 tests green with two extra columns). This
 * test pins the fragment itself: every selected expression, under any alias.
 */
import { describe, expect, it } from 'vitest'
import { OWNER_COMPANY_DETAILS_JOIN_COLUMNS } from '../owner-company-details.js'

const EXPECTED: ReadonlyArray<readonly [column: string, alias: string]> = [
  ['legal_name', 'buyer_legal_name'],
  ['country', 'buyer_country'],
  ['org_number', 'buyer_org_number'],
  ['vat_number', 'buyer_vat_number'],
  ['vies_status', 'buyer_vies_status'],
  ['vies_checked_at', 'buyer_vies_checked_at'],
]

function selectedExpressions(fragment: string): string[] {
  return fragment
    .split(',')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part.length > 0)
}

describe('OWNER_COMPANY_DETAILS_JOIN_COLUMNS (#4946)', () => {
  it('selects exactly the six buyer columns, each under its buyer_ alias', () => {
    expect(selectedExpressions(OWNER_COMPANY_DETAILS_JOIN_COLUMNS)).toEqual(
      EXPECTED.map(([column, alias]) => `ocd.${column} AS ${alias}`),
    )
  })

  it('never reads the receipt email or an address, under any alias', () => {
    for (const column of ['receipt_email', 'billing_address', 'shipping_address']) {
      expect(OWNER_COMPANY_DETAILS_JOIN_COLUMNS).not.toMatch(new RegExp(`\\b${column}\\b`))
    }
    expect(OWNER_COMPANY_DETAILS_JOIN_COLUMNS).not.toMatch(/ocd\.\*/)
  })
})
