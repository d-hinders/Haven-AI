import { redirect } from 'next/navigation'

// The Accounting page (SIE export / voucher push) is superseded by the
// non-asserting Reporting feed (#491/#500). Old links redirect.
export default function AccountingRedirect() {
  redirect('/reporting')
}
