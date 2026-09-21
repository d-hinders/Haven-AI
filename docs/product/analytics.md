---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/scripts/screenshot.mjs
  - packages/frontend/src/__tests__/screenshot-fixture.test.ts
  - packages/frontend/src/app/(authenticated)/analytics/AnalyticsClient.tsx
  - packages/frontend/src/components/analytics/MerchantsTable.tsx
  - packages/frontend/src/components/analytics/SpendSection.tsx
  - packages/frontend/src/components/ui/StackedBarChart.tsx
  - packages/frontend/src/components/ui/AreaChart.tsx
  - packages/frontend/src/components/charts/chart-scale.ts
  - packages/frontend/src/components/ui/StatTile.tsx
  - packages/frontend/src/components/analytics/AgentsTable.tsx
  - packages/frontend/src/lib/analytics-format.ts
  - packages/frontend/src/lib/analytics-series.ts
  - packages/frontend/src/components/analytics/BalanceSection.tsx
  - packages/backend/src/routes/analytics-overview.ts
  - packages/backend/src/infra/repositories/analytics.ts
  - packages/backend/src/modules/mpp/budget-precheck.ts
  - packages/backend/src/routes/machine-payments.ts
last-verified: "2026-09-21"
---

# Analytics

The Analytics screen is the single place that answers "what did my agents
spend, where did it go, and what did it cost me" over a chosen range. It is a
read-only mirror of what other screens control: nothing here moves money or
changes what an agent may do — those live on the agent screens and in agent
rules. This doc says what each figure means, where it comes from, and what the
page deliberately does not do, so a reader can tell an honest zero from a
missing number.

The page renders from one endpoint, `GET /analytics/overview`
(`range=7d|30d|90d`, `currency=usd|eur|sek`, `tz=<IANA zone>`), so every tile on
the page describes the same range, the same currency and the same set of
payments — one loading state, one "based on N payments" basis. The endpoint
(#2946), the page shell (#2947), the chart primitives (#2948) and their wiring
(#2949, #3051) have all shipped; this doc describes what renders.

## What each figure means

**Spent.** The total booked value of confirmed agent payments in the range, in
the display currency. The tile says "based on N payments"; that N is the
number of confirmed rows summed. When payments are submitted but their
settlement evidence has not arrived, the tile names them ("M awaiting
settlement evidence are not counted") instead of silently shrinking N.

**Refused.** How many payment attempts agents tried to make that were refused
in the range, and — when they differ — how many attempts those refusals
represent. The amount shown is the attempted amount. The page never says
"saved": a refusal is a payment that did not happen, and treating every
attempted amount as money saved would flatter the number. The tile carries
only that basis; the two caveats that apply to the whole page — the day the
refusal ledger starts recording, and the price-cap refusals the ledger never
sees — are one line under the tile grid, not in the tile (#3204: joined into
the tile they ran five to seven lines and made it twice its neighbours'
height). The change chips on every tile write their percentage in the
display currency's locale, so a `kr` figure sits beside `+15,9 %`, not
`+15.9%`.

**Budget used.** What each agent's own budget allows and how much of it is
gone. The used amount is read from the chain per delegation, in token units,
against that delegation's own period — not from a Haven-side running total.
The tile's headline is the band count ("2 of 3 agents above 75% of their
period budget"); per-agent detail lives in the agents table.

**Fees paid to Haven.** What Haven has charged, in the display currency.
While fee charging is switched off, the tile says so plainly ("No fees yet —
Haven is not charging fees") rather than rendering a bare 0. The API reports
whether the flag is on so the tile cannot go stale in either direction.

**Spend over time.** One bar per day *with activity* in the range — a day
with no payment and no refusal is not drawn, so the axis is the days that
carry a figure, not the calendar — stacked by agent, in the display currency;
a marker cap above a bar means the guardrails refused at least one payment
that day (the tooltip and the data table say how many; the legend names the
cap beside the agent rows whenever a day in the range has one). The bars are the same
booked values the Spent tile sums, bucketed server-side in the page's time
zone. Agents are ordered by spend, then id, and an agent that appears on the
chart keeps one colour across the chart, its legend and the swatch beside its
spend figure in the agents table above it. The window starts and ends at the
moment the page loads, not at midnight, so a bar on the window's first or
last local day covers part of a day: it is striped and named as partial (the
note under the chart says which end), never dropped or stretched. On a wide
screen a day's detail opens as a two-line callout — the day, its refusal
count and its total, then each agent's share as a chip — anchored over that
bar, kept inside
the plot at either edge; when the bar (or its refusal cap) is tall enough to
reach under the callout, the callout drops below the bar's top instead — its
bottom just above the axis when the bar can hold it, otherwise just above
the legend, over the date labels beneath it; between the two, the slot that
hides the fewest neighbouring bars' tops wins — so the bar's top, its
height against its neighbours and any refusal cap stay visible while it is
open. The callout takes no pointer, so hovering the next bar through it
moves the detail on; a tap pins a day, and a second tap on it, or Escape,
releases it — on touch too, where no pointer ever leaves. A bar too short
for either drop (it would cover the whole bar to save a sliver) keeps the
resting callout and loses its top instead. On a narrow screen the detail
is a panel below the plot.
Below three days of data the chart is not drawn (see the sparse rule below)
— a line through one point agrees with every trend.

**Top merchants.** The recipients your agents paid most, ranked by spent.
A merchant's label is resolved by the API in a fixed order: your contact's
name for that address, else the name on the payment's receipt, else the
address itself. Each row also shows payments, paying agents (up to three,
then "and N more"), and first and last seen in the range. A row links into
the transaction history for that merchant; until the merchant filter exists
there, it links to the transaction history unfiltered — the row never links
somewhere that shows something else.

**Balance over time.** The total value of the tokens in your Haven account,
as Haven's daily snapshots recorded it at each day's end, in the display
currency. This is a record of what was held, not a live portfolio valuation.
Under the SEK display currency, days snapshotted before the SEK column
existed (migration 090) are omitted from the series rather than drawn as
zero — the page distinguishes a day with no SEK figure from a day that was
actually worth nothing. The chart does not start at zero: its floor is
padded just under the range's lowest day (6 % of the range, never a share
of the balance itself) and its ticks are computed over that range
(`chartScaleRange`), so a 300 kr movement on a 12 000 kr balance spans most
of the plot's height and the gridline labels bracket the data — 12 300 /
12 400 / 12 500 / 12 600 for a 12 342–12 641 series — rather than sitting
below the floor (#3204: the ticks came from the zero-based bar-chart scale,
so no gridline reached the plot, the labels were positioned under the card,
and the line read as flat). Tick labels are compact (no öre/cents) and the
phone treatment widens the label gutter to 128 of the drawing's 640 units
(≈56 px of label room at 390 — the gutter less its 6-unit inset, on the
300 px drawing — measured against `12 600 kr` at 53 px; the spend chart's
78 gave ≈34 px and the label's end spilled into the plot), so the widest
supported tick sits clear of the line. A tick the gutter cannot hold (a
320 px phone) is anchored by its right edge, so any overflow grows left
into the card padding, never into the plot. The narrower plot also moved
the first two date labels to a word-space apart at 390 ("11 Jun 18 Jun" read
as one run): the balance chart anchors its start label at its left edge,
so the shared label rule gives that chart's first pair two label-widths —
a 30-day range at 390 labels days 1, 15, 22 and 30, a 90-day range days
1, 37, 55 and 90. The spend chart centres every label on its bar and keeps
its weekly labels; the product's 7/30/90-day ranges are unchanged on
desktop. A flat series pads by ±2 so every
integer tick stays distinct (±1 stepped by 0,5 and printed one label twice
without the öre). The annotation and
the tooltip print the amount once, in the display currency's own format
("gained 298,43 kr"), never with the currency code appended again.

## Which payments count, and why

A payment is counted exactly when its status is `confirmed`. The reason is
mechanical, not editorial: the fiat value on a payment row is booked once, by
the step that confirms the payment. Rows in earlier statuses
(`pending_signature`, `submitted`, `failed`, `expired`) carry no booked value,
so summing them would either report money that has not moved or force a
conversion the product has deliberately not performed.

`submitted` rows get their own sentence on the page rather than silence. An
erc7710 payment whose hash was never reported back stays `submitted` —
settlement recording is fail-closed — so "N payments awaiting settlement
evidence are not counted" is the honest form: named, with the reason they are
not in the sum.

## Where the numbers come from

- **Currency basis.** Figures are shown in the currency preference from
  Settings. Values are booked at confirmation and never re-converted at
  display time: the EUR, USD and SEK pages are three sums over three booked
  columns, not one sum and an exchange rate. A payment's booked value does
  not move after confirmation. Under the SEK display currency, a payment
  whose book-time SEK value could not be captured or backfilled is counted
  in the payment basis but contributes nothing to the SEK sums — the page's
  basis line can therefore exceed what the SEK figures sum to, and that is
  the honest reading, not a defect.
- **Day buckets.** Days are bucketed server-side in the time zone the page
  sends (the browser's zone, validated as a real IANA zone; `UTC` on any
  failure to send one), so a payment at 00:30 Stockholm time lands in the
  30th's bucket for a Stockholm user, not in the 29th's. The response echoes
  the zone it used, and the page renders dates in the user's zone.
- **Previous-period deltas.** Computed server-side over the previous period
  of the same length, on exactly the same definitions — a delta is never
  taken against a differently-scoped number.
- **Refusals.** Recorded in the `payment_refusals` ledger, which exists from
  migration 086 (14 September 2026). A range reaching before that date simply
  has no refusal rows for the days before it — the page shows an honest empty
  there, and neither it nor the API claims a coverage floor it cannot read.
  Refusals are recorded with attempts. One kind of refusal never reaches the
  ledger, and the page says so rather than letting the count imply it: a
  price cap. Your agent's own runtime may apply one before asking Haven (no
  request, so no row), and the hosted prepare step applies the agent's stated
  cap against the live quote too — that refusal is by policy not written
  either. A budget refusal the hosted MCP raises while preparing a purchase
  IS recorded and counted (the hosted prepare step writes its own refusal
  row for the budget branch, not for the cap branch). A payment a rate limit
  holds back is throttling, not a refusal, and it is not counted as one.
- **Sponsored gas.** Haven relays agent payments, and the relay's network fee
  is paid by Haven. The page shows this as a count — "Haven sponsored N
  operations' gas" — of relayed operations on value-bearing chains. It is
  deliberately a count, not a fiat figure: gas is not booked per payment in
  the display currency, and an invented conversion would disagree with every
  other number on the page.

## What the page deliberately does not do

- It does not move money, approve anything, or change agent authority. It is
  a reading surface; its only actions are navigation.
- It does not re-value. Every figure is a booked value or a snapshot value;
  the page never applies a live exchange rate or a token price.
- It does not count unsettled payments, and it does not hide them — see the
  status rule above.
- It does not attribute gas to individual agents. Sponsored gas is counted
  for the whole account, because the relay ledger attributes some operations
  to the account itself (deploys, user-level operations) rather than to any
  agent, and a per-agent split would silently drop those rows.
- It is not an accounting record. The accounting feed and your accountant own
  the books; Analytics is a spending overview, and its numbers are not
  bookings.
- It does not show the refusal the ledger never sees — a price cap your
  agent's own runtime applies. Its count is only ever refusals the ledger
  recorded, which since the hosted prepare step gained its writer includes the
  budget refusals raised there — not the cap refusals raised at the same step.

## In the demo

After a purchase lands, the Analytics screen is the "so what did that cost?"
beat: open it, show the payment in Spent and the merchant in Top merchants,
and narrate that the same screen shows refusals and budget use without any
action taken. The demo choreography lives in
[mobile-demo.md](./mobile-demo.md); the screen needs the route (#2947) and
the endpoint (#2946) before it can appear in a demo run.

## Capturing and testing this screen

Three screenshot-harness scenarios are registered for this screen in
`packages/frontend/scripts/screenshot.mjs`:

- `analytics-populated` — the endpoint answers a populated overview whose
  merchants include a contact-labelled row, a receipt-named row and an
  address-only row, so all three label resolutions are on the capture.
- `analytics-empty` — the endpoint answers the all-zero overview (no
  payments, agents, merchants or balance rows in range): the page's own
  empty state for an account with nothing in the range, not an error.
- `analytics-error` — the endpoint answers `503` via the harness's
  `ScenarioHttpError`, so the capture shows the page's failure path.

The fixture keys they serve are pinned by
`packages/frontend/src/__tests__/screenshot-fixture.test.ts`, which fails if
the harness and the test fixture drift apart — including the wire types: the
fixture's fiat fields are the numeric strings slice B's endpoint books, and a
revert to JS numbers goes red. The `/analytics` route (#2947) and the
merchants and balance sections (#2949) have both landed, so all three
scenarios capture against the real page:
`npm run screenshot -- --scenario=analytics-populated,analytics-empty,analytics-error`
produces the desktop and 390px captures, both themes.
