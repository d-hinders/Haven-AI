import { redirect } from 'next/navigation'

// #2859: the feed page moved to /accounting and the module is named Accounting
// throughout. This redirect is the reverse of the one that stood here before —
// /accounting used to forward to /reporting, because the non-asserting feed
// (#491) superseded the asserting export (#462) while keeping its old name.
// Old links, bookmarks and the pre-rename runbook keep working.
export default function ReportingRedirect() {
  redirect('/accounting')
}
