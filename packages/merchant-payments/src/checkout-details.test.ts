import { describe, expect, it } from 'vitest'
import {
  CHECKOUT_DETAILS_BUDGET_BYTES,
  CHECKOUT_DETAILS_EXTENSION,
  CHECKOUT_DETAILS_FIELDS,
  X_CHECKOUT_DETAILS_HEADER,
  acceptCheckoutDetails,
  checkoutDetailsExtensionEntry,
  isCheckoutDetailsField,
} from './checkout-details.js'

/**
 * #4873: the reader for the `X-Checkout-Details` header, and the challenge
 * entry a merchant advertises. The shape is
 * `docs/architecture/13-checkout-details.md` §2 and §3.
 */

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const BILLING = {
  line1: 'Sveavagen 1',
  line2: '4 tr',
  city: 'Stockholm',
  postCode: '111 57',
  subdivision: 'SE-AB',
  country: 'SE',
}

describe('the wire shape (#4873)', () => {
  it('names the extension, the header and the three fields the design doc fixes', () => {
    expect(CHECKOUT_DETAILS_EXTENSION).toBe('haven-checkout-details')
    expect(X_CHECKOUT_DETAILS_HEADER).toBe('X-Checkout-Details')
    expect([...CHECKOUT_DETAILS_FIELDS]).toEqual(['receipt_email', 'billing_address', 'shipping_address'])
    expect(CHECKOUT_DETAILS_BUDGET_BYTES).toBe(1536)
    expect(isCheckoutDetailsField('receipt_email')).toBe(true)
    expect(isCheckoutDetailsField('phone')).toBe(false)
  })

  it('builds the challenge entry with info and schema, version 1', () => {
    const entry = checkoutDetailsExtensionEntry({
      fields: { receipt_email: { required: false }, billing_address: { required: false } },
    }) as {
      info: { version: number; fields: Record<string, { required: boolean }> }
      schema: { properties: { version: { const: number } } }
    }
    expect(entry.info).toEqual({
      version: 1,
      fields: { receipt_email: { required: false }, billing_address: { required: false } },
    })
    expect(entry.schema.properties.version.const).toBe(1)
  })
})

describe('acceptCheckoutDetails (#4873)', () => {
  it('reads the email and the billing address in full', () => {
    const details = acceptCheckoutDetails({
      header: encode({ version: 1, receipt_email: 'philip@example.se', billing_address: BILLING }),
    })
    expect(details).toEqual({
      receiptEmail: 'philip@example.se',
      billingAddress: BILLING,
    })
  })

  it('omits an absent optional address member rather than sending null or an empty string', () => {
    const details = acceptCheckoutDetails({
      header: encode({
        version: 1,
        billing_address: { line1: 'Sveavagen 1', city: 'Stockholm', country: 'SE' },
      }),
    })
    expect(details?.billingAddress).toEqual({ line1: 'Sveavagen 1', city: 'Stockholm', country: 'SE' })
    expect(Object.keys(details!.billingAddress!)).toEqual(['line1', 'city', 'country'])
  })

  it('reads a shipping address too', () => {
    const details = acceptCheckoutDetails({
      header: encode({ version: 1, shipping_address: { line1: 'Storgatan 2', city: 'Goteborg', country: 'SE' } }),
    })
    expect(details?.shippingAddress).toEqual({ line1: 'Storgatan 2', city: 'Goteborg', country: 'SE' })
  })

  it('treats an absent header as no details', () => {
    expect(acceptCheckoutDetails({ header: undefined })).toBeNull()
    expect(acceptCheckoutDetails({ header: '' })).toBeNull()
  })

  it('treats a header that is not base64url(JSON) as no details', () => {
    expect(acceptCheckoutDetails({ header: 'not-a-header' })).toBeNull()
    expect(acceptCheckoutDetails({ header: Buffer.from('not json', 'utf8').toString('base64url') })).toBeNull()
  })

  it('treats a version other than 1 as unreadable, never as version 1', () => {
    expect(acceptCheckoutDetails({ header: encode({ version: 2, receipt_email: 'a@b.se' }) })).toBeNull()
    expect(acceptCheckoutDetails({ header: encode({ receipt_email: 'a@b.se' }) })).toBeNull()
  })

  it('treats an oversized header as absent', () => {
    const oversized = encode({ version: 1, receipt_email: `${'a'.repeat(CHECKOUT_DETAILS_BUDGET_BYTES)}@b.se` })
    expect(oversized.length).toBeGreaterThan(CHECKOUT_DETAILS_BUDGET_BYTES)
    expect(acceptCheckoutDetails({ header: oversized })).toBeNull()
  })

  it('drops a field that does not have the shape, keeping the ones that do', () => {
    const details = acceptCheckoutDetails({
      header: encode({
        version: 1,
        receipt_email: 'philip@example.se',
        // No city and no country: not an address this shape allows.
        billing_address: { line1: 'Sveavagen 1' },
      }),
    })
    expect(details).toEqual({ receiptEmail: 'philip@example.se' })
  })

  it('drops an email with a display name or a line break', () => {
    expect(acceptCheckoutDetails({ header: encode({ version: 1, receipt_email: 'Philip <philip@example.se>' }) })).toBeNull()
    expect(acceptCheckoutDetails({ header: encode({ version: 1, receipt_email: 'philip@example.se\r\nBcc: x@y.se' }) })).toBeNull()
    expect(acceptCheckoutDetails({ header: encode({ version: 1, receipt_email: 'not-an-email' }) })).toBeNull()
  })

  it('drops an address member over its bound and a country that is not two uppercase letters', () => {
    const details = acceptCheckoutDetails({
      header: encode({
        version: 1,
        billing_address: { line1: 'x'.repeat(71), city: 'Stockholm', country: 'SE' },
        shipping_address: { line1: 'Storgatan 2', city: 'Goteborg', country: 'se' },
      }),
    })
    expect(details).toBeNull()
  })

  it('ignores unknown keys and unknown field names', () => {
    const details = acceptCheckoutDetails({
      header: encode({ version: 1, receipt_email: 'philip@example.se', phone: '+46700000000', extra: { a: 1 } }),
    })
    expect(details).toEqual({ receiptEmail: 'philip@example.se' })
  })

  it('reads only the fields the merchant asked for', () => {
    const header = encode({
      version: 1,
      receipt_email: 'philip@example.se',
      billing_address: BILLING,
      shipping_address: { line1: 'Storgatan 2', city: 'Goteborg', country: 'SE' },
    })
    expect(acceptCheckoutDetails({ header, fields: ['receipt_email'] })).toEqual({ receiptEmail: 'philip@example.se' })
    expect(acceptCheckoutDetails({ header, fields: ['billing_address'] })).toEqual({ billingAddress: BILLING })
    expect(acceptCheckoutDetails({ header, fields: [] })).toBeNull()
  })

  it('treats an object with nothing readable as no details', () => {
    expect(acceptCheckoutDetails({ header: encode({ version: 1 }) })).toBeNull()
    expect(acceptCheckoutDetails({ header: encode({ version: 1, receipt_email: 42 }) })).toBeNull()
    expect(acceptCheckoutDetails({ header: encode([{ version: 1 }]) })).toBeNull()
  })
})
