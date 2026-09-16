import type { AnalyticsOverviewResponse } from '../../src/types/analytics'

/**
 * The `/analytics` overview fixtures for the Playwright visual gate (#3038).
 *
 * ── Why a copy exists at all, when the harness already declares these ───────
 *
 * The single declared shape for this endpoint lives in `scripts/screenshot.mjs`
 * (`FIXTURE_ANALYTICS_OVERVIEW` / `..._EMPTY`, #2949), and `fixture-shape-parity`
 * exists precisely so a second encoding of a Haven-API response cannot drift from
 * it. The natural move for `analytics.visual.spec.ts` was to import those keys,
 * and that import is what this file replaces — because it cannot load.
 *
 * `screenshot.mjs` is a CLI: it reads `import.meta.url` at module scope to find
 * its own repo root. Playwright transpiles every file it collects itself, and its
 * transform mis-handles a `.mjs` that touches `import.meta` at top level — the
 * module is compiled as CommonJS and dies on load with `ReferenceError: exports is
 * not defined in ES module scope`, pointing at the file’s FIRST import line
 * rather than at the offending read (so the line it names is an ordinary
 * `import`, which is what makes it confusing to diagnose). Measured, not inferred:
 * a minimal `.mjs` carrying only a long docblock, the harness’s own import block
 * and one `import.meta.url` read reproduces it, and the same file with that one
 * read removed does not. So no Playwright spec can import the harness, and a
 * dynamic `import()` cannot either: the failure arrives at collect time, before a
 * single test runs — which is how the first draft of this spec never reached a
 * locator.
 *
 * ── The split this repo already uses for exactly this problem ───────────────
 *
 * `settings-accounting.visual.spec.ts` meets the same shape of problem with the
 * accounting-feed fixtures and resolves it the same way: it takes its scenario
 * bodies from the e2e fixture layer (a `.ts` module the runner transpiles
 * happily) and `fixture-shape-parity.test.ts` pins those copies against the
 * harness’s own keys. The rule that makes a second encoding safe is not
 * “do not copy” — it is “copy, and pin the copy”. These two constants obey that
 * rule, and their pin lives in `fixture-shape-parity.test.ts` under
 * “the /analytics overview fixtures are the harness’s, verbatim (#3038)”.
 *
 * Two things follow from being a pin rather than a paraphrase, and both are
 * enforced there and below rather than asserted here:
 *   - the values are the harness’s, GENERATED from its exported keys rather than
 *     retyped, so a fixture cannot silently photograph a page no backend serves;
 *   - the shape is checked against the GENERATED wire type, so a field added to
 *     `GET /analytics/overview` reddens the typecheck instead of leaving the
 *     visual gate capturing a stale response.
 *
 * `fixtureFor` in the harness still answers `/analytics/overview` for the capture
 * harness and for the `analytics-populated` / `analytics-empty` / `analytics-error`
 * scenarios; nothing here reaches that path, and the vitest suites
 * (`MerchantsTable.test.tsx`, `AnalyticsClient.test.tsx`) keep reading the
 * harness’s keys directly, which they can do because vitest transpiles `.mjs`
 * itself.
 */
/**
 * The populated report — the `analytics-populated` capture scenario’s body.
 * One 30-day window, two agents, three merchants (one per label resolution the
 * API defines), a 30-point balance series: every figure the page quotes and
 * every string the copy assertions in `analytics.visual.spec.ts` read comes from
 * here, so the two capture surfaces describe one state, twice.
 */
export const analyticsOverview =
  {
    "range": {
      "from": "2026-06-11T00:00:00.000Z",
      "to": "2026-07-11T00:00:00.000Z",
      "days": 30,
      "previous_from": "2026-05-12T00:00:00.000Z",
      "previous_to": "2026-06-11T00:00:00.000Z"
    },
    "currency": "usd",
    "basis": {
      "payments_counted": 5,
      "unsettled_submitted": 1,
      "refusals_recorded_from": "2026-05-28",
      "refusals_counted": 2,
      "refusal_attempts": 3,
      "fee_rows": 2,
      "gas_sponsored_ops": 7,
      "snapshot_days": 30,
      "tz": "UTC"
    },
    "totals": {
      "spent": "324.75",
      "spent_previous": "280.10",
      "refused_count": 2,
      "refused_attempts": 3,
      "refused_amount": "3.00",
      "refused_previous_count": 1,
      "budget_bands": {
        "above_75": 1,
        "above_50": 1,
        "agents_with_budget": 2
      },
      "fees": {
        "amount": "0",
        "previous": "0",
        "flag_on": false
      },
      "gas_sponsored_ops": 7
    },
    "by_day": [
      {
        "date": "2026-07-07",
        "spent_by_agent": {
          "agent-research": "85.75",
          "agent-retired": "12.50"
        },
        "refusals": 0
      },
      {
        "date": "2026-07-08",
        "spent_by_agent": {
          "agent-research": "112.50"
        },
        "refusals": 0
      },
      {
        "date": "2026-07-09",
        "spent_by_agent": {
          "agent-research": "87.25"
        },
        "refusals": 1
      },
      {
        "date": "2026-07-10",
        "spent_by_agent": {
          "agent-research": "26.75"
        },
        "refusals": 1
      }
    ],
    "agents": [
      {
        "id": "agent-research",
        "name": "Research agent",
        "status": "active",
        "spent": "312.25",
        "payments": 4,
        "refusals": 1,
        "refusal_attempts": 2,
        "budgets": [
          {
            "token": "USDC",
            "recipient": null,
            "used_atomic": "214000000",
            "budget_atomic": "250000000",
            "remaining_from_chain": true,
            "period_start": "2026-07-04T00:00:00.000Z",
            "period_end": "2026-07-11T00:00:00.000Z"
          }
        ],
        "top_merchant": {
          "label": "NordShield VPN",
          "address": "0x6B175474E89094C44Da98b954EedeAC495271d0F"
        },
        "last_payment_at": "2026-07-10T08:12:00.000Z",
        "share": 0.9615088529638183
      },
      {
        "id": "agent-retired",
        "name": "Data-feed agent",
        "status": "paused",
        "spent": "12.50",
        "payments": 1,
        "refusals": 1,
        "refusal_attempts": 1,
        "budgets": [
          {
            "token": "USDC",
            "recipient": "0x9995F3aB1e2C4d6087A1b3E5f6C7D890aB1244E2",
            "used_atomic": "5000000",
            "budget_atomic": "500000000",
            "remaining_from_chain": false,
            "period_start": "2026-07-10T00:00:00.000Z",
            "period_end": "2026-07-11T00:00:00.000Z"
          }
        ],
        "top_merchant": {
          "label": "0x71C2E8a4D5f6093b1a7C8e2F4B6D0A9C3E5F7128",
          "address": "0x71C2E8a4D5f6093b1a7C8e2F4B6D0A9C3E5F7128"
        },
        "last_payment_at": "2026-07-10T12:30:00.000Z",
        "share": 0.03849114703618168
      }
    ],
    "merchants": [
      {
        "label": "NordShield VPN",
        "address": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        "spent": "225.00",
        "payments": 3,
        "agent_ids": [
          "agent-research"
        ],
        "first_seen": "2026-07-08T09:15:00.000Z",
        "last_seen": "2026-07-10T08:12:00.000Z"
      },
      {
        "label": "Klara Data AB",
        "address": "0xC0dA5fA2b7E1d3418c6b9A0fD2e3B4C5D6E7F809",
        "spent": "87.25",
        "payments": 1,
        "agent_ids": [
          "agent-research"
        ],
        "first_seen": "2026-07-09T10:00:00.000Z",
        "last_seen": "2026-07-09T10:00:00.000Z"
      },
      {
        "label": "0x71C2E8a4D5f6093b1a7C8e2F4B6D0A9C3E5F7128",
        "address": "0x71C2E8a4D5f6093b1a7C8e2F4B6D0A9C3E5F7128",
        "spent": "12.50",
        "payments": 1,
        "agent_ids": [
          "agent-retired"
        ],
        "first_seen": "2026-07-10T12:30:00.000Z",
        "last_seen": "2026-07-10T12:30:00.000Z"
      }
    ],
    "balance_by_day": [
      {
        "date": "2026-06-12",
        "value": "12342.12"
      },
      {
        "date": "2026-06-13",
        "value": "12364.38"
      },
      {
        "date": "2026-06-14",
        "value": "12374.25"
      },
      {
        "date": "2026-06-15",
        "value": "12371.71"
      },
      {
        "date": "2026-06-16",
        "value": "12393.97"
      },
      {
        "date": "2026-06-17",
        "value": "12403.84"
      },
      {
        "date": "2026-06-18",
        "value": "12401.30"
      },
      {
        "date": "2026-06-19",
        "value": "12423.56"
      },
      {
        "date": "2026-06-20",
        "value": "12433.42"
      },
      {
        "date": "2026-06-21",
        "value": "12430.89"
      },
      {
        "date": "2026-06-22",
        "value": "12453.15"
      },
      {
        "date": "2026-06-23",
        "value": "12463.01"
      },
      {
        "date": "2026-06-24",
        "value": "12460.48"
      },
      {
        "date": "2026-06-25",
        "value": "12482.74"
      },
      {
        "date": "2026-06-26",
        "value": "12492.60"
      },
      {
        "date": "2026-06-27",
        "value": "12490.07"
      },
      {
        "date": "2026-06-28",
        "value": "12512.33"
      },
      {
        "date": "2026-06-29",
        "value": "12522.19"
      },
      {
        "date": "2026-06-30",
        "value": "12519.66"
      },
      {
        "date": "2026-07-01",
        "value": "12541.92"
      },
      {
        "date": "2026-07-02",
        "value": "12551.78"
      },
      {
        "date": "2026-07-03",
        "value": "12549.25"
      },
      {
        "date": "2026-07-04",
        "value": "12571.51"
      },
      {
        "date": "2026-07-05",
        "value": "12581.37"
      },
      {
        "date": "2026-07-06",
        "value": "12578.83"
      },
      {
        "date": "2026-07-07",
        "value": "12601.10"
      },
      {
        "date": "2026-07-08",
        "value": "12610.96"
      },
      {
        "date": "2026-07-09",
        "value": "12608.42"
      },
      {
        "date": "2026-07-10",
        "value": "12630.69"
      },
      {
        "date": "2026-07-11",
        "value": "12640.55"
      }
    ]
  } satisfies AnalyticsOverviewResponse

/**
 * The honest no-data answer — the `analytics-empty` capture scenario’s body.
 * The endpoint responded and found nothing, which the page renders as its own
 * empty state rather than as an error: empty arrays throughout, counts all zero.
 */
export const analyticsOverviewEmpty =
  {
    "range": {
      "from": "2026-06-11T00:00:00.000Z",
      "to": "2026-07-11T00:00:00.000Z",
      "days": 30,
      "previous_from": "2026-05-12T00:00:00.000Z",
      "previous_to": "2026-06-11T00:00:00.000Z"
    },
    "currency": "usd",
    "basis": {
      "payments_counted": 0,
      "unsettled_submitted": 0,
      "refusals_recorded_from": null,
      "refusals_counted": 0,
      "refusal_attempts": 0,
      "fee_rows": 0,
      "gas_sponsored_ops": 0,
      "snapshot_days": 0,
      "tz": "UTC"
    },
    "totals": {
      "spent": "0.00",
      "spent_previous": "0.00",
      "refused_count": 0,
      "refused_attempts": 0,
      "refused_amount": "0.00",
      "refused_previous_count": 0,
      "budget_bands": {
        "above_75": 0,
        "above_50": 0,
        "agents_with_budget": 0
      },
      "fees": {
        "amount": "0",
        "previous": "0",
        "flag_on": false
      },
      "gas_sponsored_ops": 0
    },
    "by_day": [],
    "agents": [],
    "merchants": [],
    "balance_by_day": []
  } satisfies AnalyticsOverviewResponse

/**
 * The outage the `analytics-error` capture scenario serves: the harness’s own
 * `httpError(503, { error: 'Service Unavailable' })`, flattened to the status
 * and body the Playwright route has to fulfil. A 503 and not a 500 because that
 * is what the harness sends — the class is "the reporting service is down", and
 * the page’s copy is written against exactly that case (#2949).
 */
export const analyticsOverviewFailure = {
  status: 503,
  body: {
    "error": "Service Unavailable"
  }
} as const
