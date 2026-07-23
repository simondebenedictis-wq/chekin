# Stripe / ProfitWell / HubSpot subscription dashboard

Live customer/subscription table with company-wide MRR metrics. Stripe is the
source of truth for per-customer/subscription rows; ProfitWell supplies the
company-level MRR summary panel above the table; HubSpot supplies the contact
owner and company owner (account manager) for each customer.

## Setup

```
cd stripe-profitwell-dashboard
npm install
cp .env.example .env   # then fill in STRIPE_SECRET_KEY, PROFITWELL_TOKEN, HUBSPOT_ACCESS_TOKEN
npm start
```

Open http://localhost:3000. Click **Refresh Data** to re-fetch everything
from Stripe + ProfitWell + HubSpot without a page reload.

`STRIPE_SECRET_KEY` and `HUBSPOT_ACCESS_TOKEN` must be backend-only secrets.
They are only read in `server.js` via `process.env` and are never sent to, or
embedded in, the frontend. `HUBSPOT_ACCESS_TOKEN` is a private-app or OAuth
token with `crm.objects.contacts.read`, `crm.objects.companies.read`, and
`crm.objects.owners.read` scopes.

## What each part does

- `server.js` — Express app. Serves `public/` and one endpoint,
  `GET /api/dashboard-data`, which:
  1. Lists all Stripe subscriptions (auto-paginated, all pages) with status
     `active`/`trialing`/`past_due`/`unpaid`/`incomplete`, expanding the
     customer and product.
  2. Lists every paid Stripe invoice in the account once (auto-paginated),
     grouped by customer + calendar month, to build the monthly MRR history
     columns and the "Lifetime Expansion (estimated)" figures without an
     extra API call per customer.
  3. Calls ProfitWell's `GET /v2/metrics/monthly/` for the company-wide
     summary panel.
  4. For each unique customer email, calls HubSpot to resolve the contact's
     owner (`POST /crm/v3/objects/contacts/search` on email, reading
     `hubspot_owner_id`) and, separately, the associated company's owner
     (`GET .../contacts/{id}/associations/companies` then
     `GET /crm/v3/objects/companies/{id}?properties=hubspot_owner_id`), then
     resolves both owner ids to display names via `GET /crm/v3/owners/{id}`.
     Owner-name lookups are cached per refresh so the same owner (often the
     same person across many accounts) isn't re-fetched. Lookups are deduped
     by email so a customer with multiple subscriptions only triggers one
     HubSpot round-trip.
  5. Merges everything into one JSON response.
- `public/index.html` — single-file frontend: table, refresh button,
  loading spinner, error banner, simple client-side sort/filter.

## Known limitations / things to double-check before relying on this

- **ProfitWell field names weren't verified against a live response.** This
  session's network policy blocks outbound calls to `api.profitwell.com`, so
  the `/metrics/monthly/` schema could only be confirmed from public docs,
  which describe the shape (`data` object keyed by metric-trend name, each an
  array of `{date, value}` points) but not a complete, current list of every
  trend-name string. `server.js`'s `METRIC_ALIASES` tries several known
  aliases per concept (e.g. `recurring_revenue`, `mrr`) and reports a metric
  as "Not found in ProfitWell response" rather than guessing if none match.
  Run it once against your real ProfitWell account, check the KPI panel and
  the server logs (`rawKeysSeen` in the JSON response lists every key
  ProfitWell actually returned), and adjust the alias lists if needed.
- **"Current MRR (customer)" is the subscription's literal recurring line
  amount** (`unit_amount * quantity`), not normalized to a monthly figure —
  e.g. an annual subscription shows its full annual amount, per the original
  spec. Multiply/divide as needed if you want a true monthly-normalized
  figure instead.
- **Lifetime Expansion (estimated)** = sum of positive month-over-month
  increases across a customer's full paid-invoice history. This is a derived
  estimate for directional use, not an official Stripe or ProfitWell metric —
  labeled as such in the table.
- Columns with no real data source (next scheduled expansion/downgrade
  dates, forecasted MRR at 30/60/90 days, renewal probability) always render
  `N/A — no data source` and are never estimated.
- For accounts with very large customer/invoice counts, the invoice listing
  call can take a while since Stripe paginates 100 rows at a time; there's no
  caching layer here, by design, since every click is meant to re-fetch live.
- **HubSpot calls could not be tested live from this session** — the same
  network policy that blocks `api.profitwell.com` also blocks
  `api.hubapi.com` here. The endpoints and field names used
  (`hubspot_owner_id`, the contacts-search filter shape, the associations
  endpoint, `GET /crm/v3/owners/{id}`) are stable, documented HubSpot v3 CRM
  APIs, but run this once against your real HubSpot account and confirm the
  owner columns populate as expected before relying on it.
- **"Contact Owner" and "Company Owner" are reported separately, never
  merged.** A contact's owner and its associated company's owner are
  frequently different people; the dashboard never assumes they're the same
  "account manager." If a customer's email has no matching HubSpot contact,
  both columns show "Not found in HubSpot"; if a contact/company exists but
  has no owner assigned, that column shows "Unassigned"; if
  `HUBSPOT_ACCESS_TOKEN` is missing or invalid, columns show "HubSpot not
  configured" / "HubSpot authentication error" respectively — never a
  guessed name.
- A contact is matched to **one** associated company (the first one HubSpot's
  associations API returns). If a contact is associated with more than one
  company, only that first company's owner is shown.
