# ProfitWell / Stripe / HubSpot customer dashboard

Customer table with company-wide MRR metrics. **ProfitWell's full customer
list is the base of the table** — every row is a ProfitWell customer, joined
by email to a matching Stripe subscription and a matching HubSpot contact
when one exists. ProfitWell's monthly metrics endpoint also supplies the
company-wide summary panel above the table.

## Setup

```
cd stripe-profitwell-dashboard
npm install
cp .env.example .env   # then fill in STRIPE_SECRET_KEY, PROFITWELL_TOKEN, HUBSPOT_ACCESS_TOKEN
npm start
```

Open http://localhost:3000. Click **Refresh Data** to re-fetch everything
from ProfitWell + Stripe + HubSpot without a page reload.

`STRIPE_SECRET_KEY` and `HUBSPOT_ACCESS_TOKEN` must be backend-only secrets.
They are only read in `server.js` via `process.env` and are never sent to, or
embedded in, the frontend. `HUBSPOT_ACCESS_TOKEN` is a private-app or OAuth
token with `crm.objects.contacts.read`, `crm.objects.companies.read`, and
`crm.objects.owners.read` scopes.

## Table columns

Email | ProfitWell MRR | Stripe MRR | Stripe Product | Stripe Subscription | HubSpot Contact Owner

Stripe and HubSpot columns are only populated when that row's ProfitWell
email matches a Stripe customer / HubSpot contact — otherwise the cell is
left blank, never guessed or defaulted to zero.

## What each part does

`server.js` — Express app. Serves `public/` and one endpoint,
`GET /api/dashboard-data`, which:

1. **Fetches every ProfitWell customer** (paginated) via the ProfitWell
   Customers API — this is the base list, one row per customer returned.
2. **Builds a Stripe email → subscription index**: lists all Stripe
   subscriptions (auto-paginated, all pages) with status
   `active`/`trialing`/`past_due`/`unpaid`/`incomplete`, expanding customer
   and product, keeping the most recent subscription per email.
3. **Resolves a HubSpot contact owner per unique email**
   (`POST /crm/v3/objects/contacts/search` filtering on email, reading
   `hubspot_owner_id`, then `GET /crm/v3/owners/{id}` for the display name).
   Owner-name lookups are cached per refresh; email lookups are deduped so
   each unique customer only triggers one HubSpot round-trip.
4. Calls ProfitWell's `GET /v2/metrics/monthly/` for the company-wide
   summary panel.
5. Joins all three by email into one row per ProfitWell customer.

`public/index.html` — single-file frontend: table, refresh button, loading
spinner, error banner, simple client-side sort/filter.

## Known limitations / things to verify before relying on this

- **The ProfitWell Customers API request URL is confirmed; the response
  body's field names are not.** The endpoint, path (no `/v2/`, unlike the
  metrics API), and query params (`date_field`, `start_date`, `end_date`,
  `page`, `per_page`, `direction`) were confirmed against ProfitWell's own
  documented example request. This session's network policy still blocks
  actually calling `api.profitwell-events.com` from here, so the *response*
  field names (`email`, `mrr` in `server.js`'s `firstDefined` candidates)
  haven't been checked against a live payload. **Run this once against your
  real ProfitWell account before trusting it.** If a customer's email or MRR
  comes through as blank/null when you know it shouldn't be, the response
  body has different field names than guessed — send me one raw customer
  object from the response and I'll fix `firstDefined`'s candidate list.
- **ProfitWell's monthly-metrics field names weren't verified either**, for
  the same network-access reason. `METRIC_ALIASES` in `server.js` tries
  several known aliases per concept (e.g. `recurring_revenue`, `mrr`) and
  reports a metric as "Not found in ProfitWell response" rather than
  guessing if none match. The JSON response includes `rawKeysSeen` — every
  key ProfitWell actually returned — to help adjust the alias lists if
  needed.
- **HubSpot calls could not be tested live from this session either** (same
  network policy blocks `api.hubapi.com`). The endpoints used
  (`hubspot_owner_id`, the contacts-search filter shape,
  `GET /crm/v3/owners/{id}`) are stable, documented HubSpot v3 CRM APIs, but
  run this once against your real HubSpot account and confirm the owner
  column populates as expected.
- If a ProfitWell email has no matching HubSpot contact, or a matching
  contact has no owner assigned, that cell shows "Unassigned" — read the
  cell contents ("HubSpot not configured" / "HubSpot authentication error"
  / "Unassigned") to distinguish "no data" from "checked, found nothing."
- For accounts with very large customer counts, fetching every ProfitWell
  customer page-by-page (and every Stripe subscription) can take a while;
  there's no caching layer here, by design, since every click is meant to
  re-fetch live.
- ProfitWell's customer-level MRR is assumed to already be in whole currency
  units (matching the metrics endpoint's documented convention), not cents —
  unlike Stripe amounts, which the code divides by 100.
