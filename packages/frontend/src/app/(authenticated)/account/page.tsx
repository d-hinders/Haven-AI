import { redirect } from 'next/navigation'

export default function AccountRedirectPage() {
  // Legacy single-Safe route. The product is multi-Safe now — always send to /accounts.
  redirect('/accounts')
}
