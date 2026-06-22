# GTM — Sweden target list

Working list of Swedish companies whose **machine / automated outbound spend** we
could move onto Haven (budgeted on-chain wallets per agent/automation + the
non-asserting bookkeeping feed). Living doc — add rows and enrich the tracking
columns as you qualify.

The strategy behind this list (positioning, motion, why Sweden, revenue map) lives
in [`README.md`](./README.md); the call script, screen-out, and messaging live in
[`outreach-playbook.md`](./outreach-playbook.md).

## How to use this list

Each row carries both *qualification* and *execution* fields:

- **Fit signal** — what to confirm in the first call (the fit hypothesis).
- **Lead hook** — which value to open with (see the revenue map in
  [`README.md`](./README.md#revenue-map--icp--hook--revenue)).
- **Reg-fit** — the regulatory screen. `Own-spend ✓` = the company pays its *own*
  suppliers/APIs within its own limits (in scope). `Confirm` = verify in the call
  that the need is **not** paying out / disbursing on others' behalf (payout/PSP =
  out of scope; see [`outreach-playbook.md`](./outreach-playbook.md) screen-out).
- **Contact / signal** — warm intro path + latest funding/news (fill as you qualify).
- **Owner** — who on our side drives it.
- **Next action** — the next concrete step.

## ICP (who qualifies)

A Swedish company that **already pays for services programmatically / recurringly**
— API calls, data, compute, ad spend, traffic, SMS, infra — today on shared cards
or invoices, and would benefit from giving each agent/automation a budgeted wallet
with on-chain guardrails plus automatic bookkeeping.

**Qualifying signal (sort on this):**
1. Do they pay programmatically for services today? (API / data / compute / traffic) → yes = fit.
2. Is it on shared cards / API keys with no per-system budget? → that's the pain.
3. Fortnox / SIE bookkeeping + want an auto-feed? → the reporting add-on hook.

**Do NOT target** (regulatory line — see `docs/regulatory/casp-risk-guardrails.md`):
companies whose need is to **pay out to third parties / disburse on others' behalf**
(marketplace payouts, PSP flows) — that's transfer-service / CASP territory. Haven
is the company's **own** Safe paying its **own** suppliers/APIs within approved
limits. Keep the pitch there.

## Targets

| Company | Segment | Fit signal (qualify in call) | Lead hook | Reg-fit | Contact / signal | Owner | Next action |
|---|---|---|---|---|---|---|---|
| Lovable | A · AI agent-builder | Agents provision/call 3rd-party APIs + infra per user | Budgeted wallet; reference logo | Own-spend ✓ | — | — | Qualify |
| Legora | A · AI agent-builder | Legal agents pay-per-query for case-law/research APIs; confirm which spend is metered vs flat-licensed | Budgeted wallet + receipt per payment | Own-spend ✓ | Series D ~$5.6B, ~$100M ARR; acquired Qura (Apr 2026) | — | Enter via platform/FinOps team — enterprise procurement, high reference value |
| Epiminds | A · AI agent-builder | "Lucy" + 20+ agents; confirm metered API/model/compute spend (not just fiat ad budgets) | Budgeted wallet for agents' own API/compute spend + feed | Confirm — own accounts/budget, not client disbursement | Lightspeed-led $6.6M seed (Oct 2025); 240+ brands onboarded | — | Qualify — lead with agents' own API/compute spend; ad-channel spend is fiat, not our rail |
| Paraglide AI | A · AI agent-builder (finance) | AR/collections agents in finance inboxes | Guardrails + bookkeeping feed (finance values both) | Confirm — not disbursement | — | — | Qualify |
| Sana | A · AI agent-builder | Enterprise agents call paid connectors/data | Budgeted per-agent connector spend | Own-spend ✓ | Acquired by Workday (Mar 2026); 100+ connectors, SOC2/ISO/EU-residency | — | Enter via Sana Sthlm agent/platform team — not Workday central procurement |
| Trustly | B · Payments/crypto-native | Payments-native; understands rails | On-chain caps for stablecoin machine spend | Confirm — not payout/PSP | — | — | Qualify |
| Brite Payments | B · Payments-native | Instant-payments native | On-chain caps; fast technical buy-in | Confirm — not payout/PSP | — | — | Qualify |
| Zimpler | B · Payments-native | Payments-native | Stablecoin machine-spend + reporting | Confirm — not payout/PSP | — | — | Qualify |
| Safello | B · Crypto-native | On-chain treasury already | Stablecoin spend for tools/data | Confirm — not exchange/transfer svc | — | — | Qualify |
| Goobit (BTCX) | B · Crypto-native | On-chain treasury | Early adopter for x402 flows | Confirm — not exchange/transfer svc | — | — | Qualify |
| Funnel.io | C · Martech/data | Heavy ad/data API volumes | Per-automation budget vs shared cards + feed | Own-spend ✓ | — | — | Qualify |
| Bannerflow | C · Adtech | Programmatic ad/creative API spend | Per-system budgeted spend | Own-spend ✓ | — | — | Qualify |
| Epidemic Sound | C · Media/data | Large data/API + automation spend | Budgeted machine spend + bookkeeping feed | Own-spend ✓ | — | — | Qualify |
| Detectify | C · Security | Scanners incur recurring API/compute cost | Guardrailed machine spend across scan infra | Own-spend ✓ | — | — | Qualify |
| Validio | C · Data | Data-quality pipelines, API/compute spend | Per-pipeline budget | Own-spend ✓ | — | — | Qualify |
| Bisnode (D&B Nordic) | C · Data/enrichment | Enrichment API consumption | Budgeted enrichment spend + receipts | Own-spend ✓ | — | — | Qualify |
| Sinch | C · Comms/CPaaS | Pays carrier/data APIs per call | Per-service budget + verifiable receipts | Own-spend ✓ | — | — | Qualify |
| 46elks | C · Comms | SMS/voice API spend | Budgeted machine spend | Own-spend ✓ | — | — | Qualify |
| Truecaller | C · Comms/data | Large data-API consumption | Per-system budget | Own-spend ✓ | — | — | Qualify |
| Mentimeter | C · Dev/SaaS | 3rd-party API-heavy product | Budgeted programmatic spend | Own-spend ✓ | — | — | Qualify |
| Evolution | D · iGaming | Huge data/odds/KYC/feed API volume; payments-mature | Machine spend across supplier APIs, on-chain caps + auto bookkeeping | Own-spend ✓ (own supplier APIs, not player payouts) | — | — | Qualify |
| Kindred | D · iGaming | Heavy feed/KYC API spend | As above | Own-spend ✓ (not player payouts) | — | — | Qualify |
| LeoVegas | D · iGaming | Feed/data API spend | As above | Own-spend ✓ (not player payouts) | — | — | Qualify |
| Betsson | D · iGaming | Feed/data API spend | As above | Own-spend ✓ (not player payouts) | — | — | Qualify |
| Hero Gaming | D · iGaming | Feed/data API spend | As above | Own-spend ✓ (not player payouts) | — | — | Qualify |
| Juni | E · Fintech (e-com banking) | E-commerce co with heavy tool spend; spend-control buyer | Spend control for agents/machines — partner or customer | Confirm — not disbursement/PSP | — | — | Qualify |
| Anyfin | E · Fintech | AI/automation + finance | Guardrails + reporting feed | Confirm — not disbursement/PSP | — | — | Qualify |
| Rocker | E · Fintech | Spend/finance product | Partner or customer angle | Confirm — not disbursement/PSP | — | — | Qualify |
| Voi | F · Ops automation | Scripts pay map/data/SMS/compute APIs | Budgeted automation spend + bookkeeping feed | Own-spend ✓ | — | — | Qualify |
| Budbee / Instabox | F · Logistics automation | Logistics API + automation spend | Budgeted automation spend + feed | Own-spend ✓ | — | — | Qualify |
| Mathem | F · E-commerce/ops | Automation + 3rd-party API spend | Budgeted machine spend + feed | Own-spend ✓ | — | — | Qualify |
| Einride | F · Autonomous freight | Operational/automation spend | Per-system budget | Own-spend ✓ | — | — | Qualify |
| Storytel | F · Media/ops | Automation + API spend | Budgeted spend + feed | Own-spend ✓ | — | — | Qualify |

## Prioritisation

Start with **Tier A** (agents that already spend) — Epiminds and Paraglide
(money in the core loop), Lovable and Legora (volume + reference value). Then
**Tier B** (crypto-native = lowest adoption friction). C–F broaden the wedge
beyond AI: the pitch there is "budgeted wallet for machine spend, today stuck on
shared cards," with the bookkeeping feed as the second hook.

### Cadence / sequencing

Run a focused wave at a time rather than blasting the whole list — qualified depth
beats coverage for a design-partner motion.

1. **Wave 1 — Tier A.** The sharpest fit (spend already in the core loop) and the
   most reference value. Goal: 2–3 design partners reaching a first real (non-demo)
   agent payment. Lead with the budgeted wallet; demo live (see
   [`outreach-playbook.md`](./outreach-playbook.md)).
2. **Wave 2 — Tier B.** Lowest technical friction; fast buy-in validates the
   stablecoin machine-spend angle. Apply the `Confirm — not payout/PSP` screen first.
3. **Wave 3 — Tier C–F.** Broadens beyond AI. Lead with "swap shared cards for a
   per-automation budget," bookkeeping feed as the second hook; high-volume C/D
   accounts also exercise the fee module.

Feed self-serve activations (see [`metrics.md`](./metrics.md)) back into this list —
a company that connects an agent via `npx @haven_ai/connect` on its own is a warm
design-partner conversation, regardless of tier.

## Caveat

"Fit" is a hypothesis from what each company publicly does — whether they run
*paying* agents/automations must be confirmed in the first call. Segment letters:
A AI agent-builders · B payments/crypto-native · C programmatic-spend tech ·
D iGaming · E fintech/spend-mgmt · F ops-automation.
