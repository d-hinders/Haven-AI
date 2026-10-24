---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/scripts/screenshot.mjs
  - packages/frontend/src/__tests__/screenshot-fixture.test.ts
  - packages/frontend/src/app/(authenticated)/analytics/AnalyticsClient.tsx
  - packages/frontend/src/components/analytics/EmptyStates.tsx
  - packages/frontend/src/hooks/useAnalyticsOverview.ts
  - packages/frontend/src/components/analytics/MerchantsTable.tsx
  - packages/frontend/src/components/analytics/SpendSection.tsx
  - packages/frontend/src/components/ui/StackedBarChart.tsx
  - packages/frontend/src/components/ui/AreaChart.tsx
  - packages/frontend/src/components/charts/chart-scale.ts
  - packages/frontend/src/components/ui/StatTile.tsx
  - packages/ui/src/StatTile.tsx
  - packages/frontend/src/components/analytics/AgentsTable.tsx
  - packages/frontend/src/lib/analytics-format.ts
  - packages/frontend/src/lib/analytics-series.ts
  - packages/frontend/src/lib/analytics-range.ts
  - packages/frontend/src/components/ui/FacetMenu.tsx
  - packages/frontend/src/components/ui/PeriodPicker.tsx
  - packages/frontend/src/components/analytics/BalanceSection.tsx
  - packages/backend/src/routes/analytics-overview.ts
  - packages/backend/src/infra/repositories/analytics.ts
  - packages/backend/src/modules/mpp/budget-precheck.ts
  - packages/backend/src/routes/machine-payments.ts
last-verified: "2026-10-24"
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
(`range=7d|30d|90d`, `currency=usd|eur|sek`, `tz=<IANA zone>`, and `agentId`
when the Agent facet is set), so every tile on
the page describes the same range, the same currency and the same set of
payments — one loading state, one payment basis (`basis.payments_counted`, the
figure the Payments tile shows). The endpoint
(#2946), the page shell (#2947), the chart primitives (#2948) and their wiring
(#2949, #3051) have all shipped; this doc describes what renders.

## Choosing the window

The header carries the one `PeriodPicker` the list controls ship (#4110,
#4116) — presets only, **Last 7 days / Last 30 days / Last 90 days** (the same
wording the `PeriodPicker` trigger shows, from `periodPresetLabels`), no All time and no
custom range, because the endpoint takes a rolling `range`, not dates. The
choice lives in two places, read once in that order on every mount:

- **The URL is the source when it carries `?period=`.** A shared link opens on
  the window it names, on any device.
- **Otherwise the device's stored choice applies** (`haven.analytics.range`),
  which is a returning reader's default. A value the endpoint would answer 400
  to is ignored on either surface — one bad string in a link or a store falls
  back to the default without an error, never a page of failure copy.

Picking a period writes both: the stored key for this device (as since #2947)
and the URL, with a `replaceState` — no history entry per change — so a reload
or a shared link reopens the window on screen. The values on the wire stay the
endpoint's `7d` / `30d` / `90d` (`analytics-range.test.ts` rejects a bare `7`).

## The Agent facet (#4333)

Beside the `PeriodPicker` sits an **Agent** facet — the list-controls
`FacetMenu`, single-select, "All agents" first — writing `?agentId=`, the same
key `/transactions` reads, so an agent page can link `/analytics?agentId=<id>`
and the filter lands already set. The facet is a URL state, not a device
preference: the range keeps `haven.analytics.range`, the agent does not. Its
options come from the agents LIST (`useAgents`), never the overview's filtered
response, so the facet cannot vanish the moment an agent is picked. A stale or
foreign id — the endpoint's 404 (#4332) — clears the filter with a one-line
notice ("That agent isn't available"), never the page error: a page that
showed the unfiltered report without saying so would look like the link
worked. With an agent set, every agent-scoped section narrows; the Payments
tile names the agent instead of counting agents, the Refused tile gains a
Review link to that agent's refused attempts, and the balance section says
"Balance isn't filtered by agent" (the series is per-user; see the epic).

## What each figure means

**Spent.** The total booked value of confirmed agent payments in the range, in
the display currency, net of funds swept back from an agent's delegate
address in the same window (a funding leg the merchant refused and the
sweep returned is not spend, #3755). Under the figure sits the previous window's spent, as an
AMOUNT: "vs $280.10 the 30 days before" — an absolute comparison the endpoint
already reported (`totals.spent_previous`), not a percentage pill
(`percentChange` is gone with the delta chips; a ratio of two booked totals is
a derivation the response did not make).

**Payments.** The count of confirmed payments in the range, captioned "by N of
M agents" — the agents the window's payments came from, out of the agents the
response lists — or the agent's own name when the facet narrows the page.

**Refused.** How many payment attempts agents tried to make that were refused
in the range, with the attempts those refusals represent under the count
(`N attempts` on the tile, always shown). When the page is filtered to one agent,
the tile adds a **Review** link to that agent's refused attempts
(`/agents/<id>?tab=activity&status=refused`, #4323); with all agents shown the
link is absent, because there is no page-level refused list to review. The
page never says "saved": a refusal is a payment that did not happen. The two
recording caveats — the day the refusal ledger starts recording, and the
price-cap refusals the ledger never sees — moved into an ⓘ hint on the tile's
label (#4333): a tooltip elaborating on the count the reader is already
looking at, not a footnote line making the tile twice its neighbours' height.

**Agents near their budget.** "N/M" — of the agents WITH budgets, how many
are above 75% of a period budget (the band count the endpoint reports); with
no budget in the window the tile reads "—" and says so. The
old "Budget used 0/5" headline is retired: a band count without its
denominator's context read as a budget figure. Per-agent detail lives in the
agents table.

**Agents table.** It lists every agent that is not revoked, even one with no
activity in the range, since its budget column still informs. A revoked agent
is listed only when it had a confirmed payment or a refusal in the range, or
still holds an active budget (revoking flips only the agent's status, so that
budget can still be spent and the Agents-near-their-budget tile counts it)
(#3540). Its columns (#4333): the agent's Monogram and name (a revoked agent
gets the shared "Revoked" badge, not a truncated row), **Spent** with "N% of
spend" under it (the former Share column merged into the figure it was a share
of), Payments, **Refused** as a link to that agent's refused attempts,
**Budget** through the shared caption helper — whose symbol-decimals fallback
(#4333) fixes the "0.00 of 0.00" caption a symbol-only row used to read —
**Top merchant** by name with a merchant monogram (an unresolved one reads
"Unknown recipient", the full address in its tooltip — no cell renders a
`0x…` address AS a label), and **Last paid**. The whole row links to the
agent.

**Fees paid to Haven.** What Haven has charged, in the display currency. The
tile EXISTS only while the fee flag is on — a fifth tile beside the four. While fee
charging is switched off the tile is absent rather than rendering "No fees
yet": its one job (saying the product charges nothing) is done by the absence,
and a $0.00 would report "nothing charged this period", a different fact. The
gas-sponsored count rides the tile when there is one to carry it.

**Spend over time.** One slot for EVERY local calendar date the window
touches — empty days included (#4334), so the axis reads as time rather than
as a scatter of the days that happened to carry a figure; a 7-day window
draws 8 or 7 slots (N+1 unless the window ends exactly at local midnight),
a 30-day one 31 or 30, a 90-day one 91 or 90 — stacked by agent, in the
display currency; a small grey mark UNDER a day's slot means the guardrails
refused at least one payment that day, and a day with refusals and no spend
still shows it (the tooltip and the data table say how many; the legend
names the mark "Refused" beside the agent rows whenever a day in the range
has one). The bars are the same
booked values the Spent tile sums, bucketed server-side in the page's time
zone; the y-ticks take their fraction digits from the tick step (#4334) —
four decimals when the step is under a cent, so a sub-cent peak reads
"$0.0010 … $0.0040" instead of "$0, $0", none for whole-unit steps. X labels
sit at fixed intervals (weekly on 30 days) and never overlap; on 90 days the
bars are thin, and that is accepted — the chart never scrolls horizontally.
Agents are ordered by spend, then id, and an agent's fill is its own
avatar tint — the colour of its monogram in the agents table above the
chart — so it holds across ranges and ranks (#4331). The window starts and ends at the
moment the page loads, not at midnight, so a bar on the window's first or
last local day covers part of a day: it is striped and named as partial (the
note under the chart says which end, and only claims stripes that are
drawn — a partial day with no spend is an empty slot, named partial in the
tooltip and the table), never dropped or stretched. On a wide
screen a day's detail opens as a two-line callout — the day, its refusal
count and its total, then each agent's share as a chip — anchored over that
bar, kept inside
the plot at either edge; when the bar is tall enough to
reach under the callout, the callout drops below the bar's top instead — its
bottom just above the axis when the bar can hold it, otherwise just above
the legend, over the date labels beneath it; between the two, the slot that
hides the fewest neighbouring bars' tops or refusal marks wins — so the bar's
top, its height against its neighbours and the marks under the slots stay
visible while it is
open. The callout takes no pointer, so hovering the next bar through it
moves the detail on; a tap pins a day, and a second tap on it, or Escape,
releases it — on touch too, where no pointer ever leaves. A bar too short
for either drop (it would cover the whole bar to save a sliver) keeps the
resting callout and loses its top instead. On a narrow screen the detail
is a panel below the plot.
A period with NO activity renders the section's empty state, and the
balance chart's floor (`MIN_CHARTABLE_DAYS`) still applies to it alone —
since #4333 the sections render whenever the window has any activity, each
keeping its own guard, and
the tiles and tables stay (a line through one point agrees with every trend,
but a total over one day is still the total over that day).

**Top merchants.** The recipients your agents paid most, ranked by spent.
A merchant's label is resolved by the API in a fixed order: the host of the
x402 resource its most recent payment in the range called, else the name of
one of your own accounts at that address (address-only, across chains; the
oldest account wins a shared address), else your contact's name for that
address, else the name on the payment's receipt, else nothing — the row
shows "Unknown recipient" where the transaction history says "New
recipient", with the naming step as a KIND line under the name: "Your
account" (own account), "Paid API" (x402 host), or the short address for an
unknown recipient (#4333). The Address COLUMN is gone — the address is
metadata, carried in the unknown recipient's tooltip and the mobile row's
disclosure, never as a label. Each row also carries `filter_address`, the
address the transaction history's search matches: the "View in Transactions"
link targets `/transactions?search=<filter_address>&direction=out&period=<
current>` — plus `&agentId=<id>` when the Agent facet is set (#4333) — so the
history opens already narrowed to that recipient. Each row also shows
payments, paying agents as TEXT (up to three, then "and N more"; a monogram
stack would be a new pattern where one line reads fine), and **Last paid**
in the same relative voice the agents table uses.

**Balance over time.** The total value of the tokens in all your accounts,
as Haven's daily snapshots recorded it at each day's end, in the display
currency — the subtitle says "all your accounts", and when the Agent facet is
set it adds "Balance isn't filtered by agent": the series is per-user and is
deliberately not narrowed (#4333). This is a record of what was held, not a
live portfolio valuation. The endpoint's delta annotation reads "**Net
change**" with a SIGNED amount ("Net change +298,43 kr") — a fall is not a
spend and a rise is not a gain; the balance moves for reasons the spend chart
does not draw (#4333).
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
("Net change +298,43 kr", signed, #4333), never with the currency code appended again.

## Which payments count, and why

A payment is counted exactly when its status is `confirmed`. The reason is
mechanical, not editorial: the fiat value on a payment row is booked once, by
the step that confirms the payment. Rows in earlier statuses
(`pending_signature`, `submitted`, `failed`, `expired`) carry no booked value,
so summing them would either report money that has not moved or force a
conversion the product has deliberately not performed.

`submitted` rows are not counted. An erc7710 payment whose hash was never
reported back stays `submitted` — settlement recording is fail-closed. The
endpoint still reports how many there are (`basis.unsettled_submitted`), and
a window that holds only such payments is not drawn as the no-activity empty
state. The page no longer prints a sentence naming them: #4333 dropped the
"N payments awaiting settlement evidence are not counted" footnote with the
tile rework, and its PR noted the owner may want it back.

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
- **Previous-period figures.** Computed server-side over the previous period
  of the same length, on exactly the same definitions — the Spent tile's
  comparison is never taken against a differently-scoped number.
- **Refusals.** Recorded in the `payment_refusals` ledger, which exists from
  migration 086 (14 September 2026). A range reaching before that date simply
  has no refusal rows for the days before it. The API reports the ledger's
  floor — the earliest day with refusal rows (`basis.refusals_recorded_from`,
  #3013) — and the Refused tile's ⓘ hint names that date, so an early window
  reads as a coverage caveat, not a clean zero.
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
  operations' gas" — of relayed operations on value-bearing chains, as the
  footnote of the Fees tile, so it is not shown while fee charging is off. It is
  deliberately a count, not a fiat figure: gas is not booked per payment in
  the display currency, and an invented conversion would disagree with every
  other number on the page.

## What the page deliberately does not do

- It does not move money, approve anything, or change agent authority. It is
  a reading surface; its only actions are navigation.
- It does not re-value. Every figure is a booked value or a snapshot value;
  the page never applies a live exchange rate or a token price.
- It does not count unsettled payments — see the status rule above.
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
  unresolved row (`kind: 'unknown'`, shown as "Unknown recipient"), so the
  capture shows names and the unknown case side by side.
- `analytics-empty` — the endpoint answers the all-zero overview (no
  payments, agents, merchants or balance rows in range) while the agents list
  still names the harness's agents, so the capture is the no-activity empty
  state ("No agent activity in this range") — not an error. The new-user
  state ("No agent activity yet") needs an empty agents list, which no
  scenario serves; `AnalyticsClient.test.tsx` covers it.
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

Re-verified 2026-09-30 for #3195 (PR #3176's round-3 items), scope = the
*Currency basis* paragraph above and the front-matter stamp: #3195 moved the
ONE per-currency locale rule into `lib/format.ts`'s `currencyLocale`, and this
doc's covered `lib/analytics-format.ts` (`analyticsCurrencyLocale`) now
delegates to it rather than carrying a byte-identical copy of the ternary —
no rendered voice changed, which the `lib/__tests__/analytics-format.test.ts`
byte-level pins prove. In the same scope pass: the *Currency basis* paragraph
(whose SEK sums wording came from the 2026-09-20 #3127 round-3 edits) was
re-read against the analytics endpoint and is still accurate — the page
requests `currency=sek` and renders the endpoint's booked figures, no client
derivation. The stamp this bump replaces was set by #3205 (2026-09-21), which
did not touch the SEK passages; they were never explicitly re-verified since
they landed until this pass. Nothing else in this file was re-read.

Re-verified 2026-10-24 (#4372 part C, at dev `795c50fc7`), end to end, after
#4331, #4332 (#4373) and #4333 (#4380). Changed: the endpoint's parameters
include `agentId`; Spent is net of delegate sweeps in the same window (#3755,
the inline ratio in `TOTALS_SPEND_SQL`/`BY_DAY_SPEND_SQL`/`PER_AGENT_SPEND_SQL`); the Refused tile always shows its attempts; Agents near
their budget renders "N/M" and "—" without budgets; the Fees tile is a fifth
tile; an agent's chart fill is its avatar tint and the agents table carries no
swatch (#4331); the page no longer prints the unsettled-payments sentence
(#4380 dropped `UnsettledEvidenceFootnote`), while the endpoint still reports
the count and the empty-window rule still treats it as activity; the API
reports the refusal ledger's floor (`basis.refusals_recorded_from`, #3013);
the sponsored-gas count rides the Fees tile; the populated fixture's third
merchant is an unresolved row (`kind: 'unknown'`); review round 1 found two
more stale claims and corrected them: there is no "based on N payments" basis
line (`analytics.visual.spec.ts:197`), and `analytics-empty` captures the
no-activity state, because `/agents` still answers the harness's agents
(`analytics.visual.spec.ts:230`); `covers:` gains `packages/ui/src/StatTile.tsx`.
Re-checked without change:
`?period=` and `haven.analytics.range` with `replaceState`; the Agent facet
from `useAgents`, its 404 notice and the agent-scoped Review link; the
Payments caption; the agents-table columns and the #3540 inclusion rule; the
merchant naming order (`counterparty-name.ts`), its kind lines and the
`/transactions?search=…` target; the balance copy and "Net change"; the
`tz` default and 400; `MIN_CHARTABLE_DAYS = 3`; migration 086's date.
"Spend over time" beyond the colour sentence is unchanged here: #4334
(claimed by @PhilipEriksson) rewrites that paragraph.
