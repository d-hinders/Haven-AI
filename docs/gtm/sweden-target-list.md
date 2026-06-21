# GTM — Sweden target list

Working list of Swedish companies whose **machine / automated outbound spend** we
could move onto Haven (budgeted on-chain wallets per agent/automation + the
non-asserting bookkeeping feed). Living doc — add rows, fill `Status`, and append
contact path + latest funding as you qualify.

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

| Company | Segment | Fit signal (qualify in call) | Hook | Status |
|---|---|---|---|---|
| Lovable | A · AI agent-builder | Agents provision/call 3rd-party APIs + infra per user | Let your agents pay for the APIs/infra they wire up, within a budget you set; reference logo | Not contacted |
| Legora | A · AI agent-builder | Legal agents pay-per-query for case-law/data APIs | Per-query data spend under an allowance + verifiable receipt per payment | Not contacted |
| Epiminds | A · AI agent-builder | Autonomous marketing agents execute spend across ad channels | Guardrailed per-agent ad/API spend + reporting feed — money is in the core loop | Not contacted |
| Paraglide AI | A · AI agent-builder (finance) | AR/collections agents in finance inboxes | Spend guardrails + Fortnox feed — finance team values both most | Not contacted |
| Sana | A · AI agent-builder | Enterprise agents call paid connectors/data | Budgeted per-agent spend on connectors | Not contacted |
| Trustly | B · Payments/crypto-native | Payments-native; understands rails | Agent/automation spend in stablecoin with on-chain caps | Not contacted |
| Brite Payments | B · Payments-native | Instant-payments native | Same as above; fast technical buy-in | Not contacted |
| Zimpler | B · Payments-native | Payments-native | Stablecoin machine-spend + reporting | Not contacted |
| Safello | B · Crypto-native | On-chain treasury already | Natural stablecoin spend for tools/data | Not contacted |
| Goobit (BTCX) | B · Crypto-native | On-chain treasury | Early adopter for x402 flows | Not contacted |
| Funnel.io | C · Martech/data | Heavy ad/data API volumes | Swap shared cards for per-automation budget + feed | Not contacted |
| Bannerflow | C · Adtech | Programmatic ad/creative API spend | Per-system budgeted spend | Not contacted |
| Epidemic Sound | C · Media/data | Large data/API + automation spend | Budgeted machine spend + bookkeeping feed | Not contacted |
| Detectify | C · Security | Scanners incur recurring API/compute cost | Guardrailed machine spend across scan infra | Not contacted |
| Validio | C · Data | Data-quality pipelines, API/compute spend | Per-pipeline budget | Not contacted |
| Bisnode (D&B Nordic) | C · Data/enrichment | Enrichment API consumption | Budgeted enrichment spend + receipts | Not contacted |
| Sinch | C · Comms/CPaaS | Pays carrier/data APIs per call | Per-service budget + verifiable receipts | Not contacted |
| 46elks | C · Comms | SMS/voice API spend | Budgeted machine spend | Not contacted |
| Truecaller | C · Comms/data | Large data-API consumption | Per-system budget | Not contacted |
| Mentimeter | C · Dev/SaaS | 3rd-party API-heavy product | Budgeted programmatic spend | Not contacted |
| Evolution | D · iGaming | Huge data/odds/KYC/feed API volume; payments-mature | Machine spend across dozens of supplier APIs, on-chain caps per system + auto bookkeeping | Not contacted |
| Kindred | D · iGaming | Heavy feed/KYC API spend | Same as above | Not contacted |
| LeoVegas | D · iGaming | Feed/data API spend | Same | Not contacted |
| Betsson | D · iGaming | Feed/data API spend | Same | Not contacted |
| Hero Gaming | D · iGaming | Feed/data API spend | Same | Not contacted |
| Juni | E · Fintech (e-com banking) | E-commerce co with heavy tool spend; spend-control buyer | "Spend control for agents/machines" — partner or customer | Not contacted |
| Anyfin | E · Fintech | AI/automation + finance | Guardrails + reporting feed | Not contacted |
| Rocker | E · Fintech | Spend/finance product | Partner or customer angle | Not contacted |
| Voi | F · Ops automation | Scripts pay map/data/SMS/compute APIs | Budgeted automation spend + Fortnox feed | Not contacted |
| Budbee / Instabox | F · Logistics automation | Logistics API + automation spend | Same | Not contacted |
| Mathem | F · E-commerce/ops | Automation + 3rd-party API spend | Budgeted machine spend + feed | Not contacted |
| Einride | F · Autonomous freight | Operational/automation spend | Per-system budget | Not contacted |
| Storytel | F · Media/ops | Automation + API spend | Budgeted spend + feed | Not contacted |

## Prioritisation

Start with **Tier A** (agents that already spend) — Epiminds and Paraglide
(money in the core loop), Lovable and Legora (volume + reference value). Then
**Tier B** (crypto-native = lowest adoption friction). C–F broaden the wedge
beyond AI: the pitch there is "budgeted wallet for machine spend, today stuck on
shared cards," with the bookkeeping feed as the second hook.

## Caveat

"Fit" is a hypothesis from what each company publicly does — whether they run
*paying* agents/automations must be confirmed in the first call. Segment letters:
A AI agent-builders · B payments/crypto-native · C programmatic-spend tech ·
D iGaming · E fintech/spend-mgmt · F ops-automation.
