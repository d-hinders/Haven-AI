# Haven — Research

Forward-looking investigations and decision aids. Unlike `docs/architecture/`
(how Haven works *today*), these explore where a part of the system *could*
go — options, trade-offs, and recommendations, often paired with a prototype
spec. They are decision inputs, not current contracts.

| Doc | Question it answers |
|---|---|
| [Smart-account-native x402 settlement](x402-smart-account-settlement.md) | Can we remove the delegate funding leg so the Safe pays the merchant directly? Rail options (Permit2, EIP-1271/7598, ERC-7710), recommendation, and a testnet prototype spec. ([#431](https://github.com/d-hinders/Haven-AI/issues/431)) |
| [`haven` CLI sketch](haven-cli.md) | What a terminal-native parallel to the dashboard looks like — command surface, the user-auth + custody boundary (read / backend-manage / sign-handoff tiers), architecture over the existing SDK + JWT API, and a phasing. |
| [Bookkeeping-ready export (Fortnox / SIE)](bookkeeping-ready-export.md) | How to turn settled agent payments into verifikat-grade accounting records — book-time SEK capture, a canonical accounting record, and a rail-agnostic exporter (SIE 4I first, then Fortnox API). The "agent-era Fortnox" moat made concrete. |
| [Make non-custody provable](non-custody-verification.md) | Turn the CASP/MiCA guardrails into CI invariants that prove the perimeter on every PR, plus a "verify your control" dashboard surface — strengthening the existing non-custodial model by making it demonstrable. No new authority or fund movement. |
| [Fortnox non-asserting feed (spike)](fortnox-non-asserting-feed.md) | How to feed a settled agent payment into Fortnox as a draft/source document (no asserted VAT/accounts) — supplier invoice vs file inbox vs draft voucher, with a recommendation and the open questions a sandbox round-trip must settle. (#494, epic #491) |
