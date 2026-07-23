require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');

const PORT = process.env.PORT || 3000;
const PROFITWELL_TOKEN = process.env.PROFITWELL_TOKEN;
const PROFITWELL_METRICS_BASE = 'https://api.profitwell.com/v2/';
// ProfitWell's Customers API lives on a different host than the metrics API,
// and (unlike the metrics API) has no /v2/ path segment — confirmed from the
// docs' own example request:
//   https://api.profitwell-events.com/customers/?date_field=updated_on&start_date=...&end_date=...&page=1&per_page=10&direction=asc
// The response body's exact field names are still unconfirmed (this
// session's network policy blocks reaching this host directly), so
// `firstDefined` below tries a couple of candidates per field and the error
// path surfaces ProfitWell's real response if the shape is still off.
const PROFITWELL_CUSTOMERS_BASE = 'https://api.profitwell-events.com/customers/';
const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const HUBSPOT_BASE = 'https://api.hubapi.com';

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill it in.');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

// Statuses treated as "active/recent" — fully-dead subscriptions (canceled,
// incomplete_expired) are excluded when matching a ProfitWell customer to Stripe.
const RELEVANT_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

function billingCycleFor(items) {
  let hasFlat = false;
  let hasMetered = false;
  for (const item of items) {
    const rec = item.price?.recurring;
    if (!rec) continue;
    if (rec.usage_type === 'metered') hasMetered = true;
    else hasFlat = true;
  }
  if (hasFlat && hasMetered) return 'Hybrid';
  if (hasMetered && !hasFlat) return 'Usage-based';

  const rec = items[0]?.price?.recurring;
  if (!rec) return 'Unknown';
  const { interval, interval_count: count } = rec;
  if (interval === 'month' && count === 1) return 'Monthly';
  if (interval === 'month' && count === 3) return 'Quarterly';
  if (interval === 'year' && count === 1) return 'Annual';
  return 'Multi-year';
}

// Batches concurrent async work so we don't fire hundreds of requests at once
// and hit rate limits.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- ProfitWell: full customer list (the base of the table) ----------

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

// ProfitWell's date params use "YYYY-MM-DD HH:MM:SS" (space-separated, UTC),
// per the docs' example — not ISO 8601.
function formatProfitwellDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

async function fetchProfitwellCustomers() {
  if (!PROFITWELL_TOKEN) {
    const err = new Error('PROFITWELL_TOKEN is not configured on the server.');
    err.statusCode = 500;
    throw err;
  }

  const customers = [];
  const perPage = 100;
  // date_field/start_date/end_date appear in every documented example, so a
  // wide fixed range (rather than omitting them) is used to fetch the full
  // customer list regardless of when each was last updated.
  const startDate = '2000-01-01 00:00:00';
  const endDate = formatProfitwellDate(new Date());

  for (let page = 1; page <= 2000; page++) {
    const params = new URLSearchParams({
      date_field: 'updated_on',
      start_date: startDate,
      end_date: endDate,
      page: String(page),
      per_page: String(perPage),
      direction: 'asc',
    });
    const res = await fetch(`${PROFITWELL_CUSTOMERS_BASE}?${params.toString()}`, {
      headers: { Authorization: PROFITWELL_TOKEN },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`ProfitWell Customers API responded ${res.status}: ${body || res.statusText}`);
      err.statusCode = res.status;
      throw err;
    }
    const json = await res.json();
    const batch = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : Array.isArray(json.customers) ? json.customers : null;
    if (!batch) {
      const err = new Error('Unexpected response shape from the ProfitWell Customers API (expected an array of customers).');
      err.statusCode = 502;
      throw err;
    }
    for (const c of batch) {
      const email = firstDefined(c, ['email', 'customer_email']);
      const mrr = firstDefined(c, ['mrr', 'recurring_revenue', 'monthly_recurring_revenue']);
      if (email) customers.push({ email, mrr: mrr != null ? Number(mrr) : null });
    }
    if (batch.length < perPage) break;
  }
  return customers;
}

// ---------- Stripe: email -> subscription summary, for the join ----------

// Stripe rejects expand paths deeper than 4 levels, and
// "data.items.data.price.product" is 5 — confirmed live against this
// account's Stripe API (400: "You cannot expand more than 4 levels").
// So `price.product` here is just an id; product names are resolved in a
// second pass below.
async function buildStripeIndexByEmail() {
  const index = new Map();
  for await (const sub of stripe.subscriptions.list({
    status: 'all',
    limit: 100,
    expand: ['data.customer', 'data.items.data.price'],
  })) {
    if (!RELEVANT_STATUSES.has(sub.status)) continue;
    const email = sub.customer?.email;
    if (!email) continue;

    const items = sub.items.data;
    const firstItem = items[0];
    const price = firstItem?.price;
    const unitAmount = price?.unit_amount;
    // unit_amount is null for tiered/graduated pricing (confirmed live on
    // several of this account's real subscriptions) and for metered prices —
    // left blank rather than guessed, since there's no single "per unit"
    // amount to multiply by quantity in those billing schemes.
    const mrr = unitAmount != null ? (unitAmount * (firstItem.quantity || 1)) / 100 : null;

    // A customer can have more than one subscription in Stripe; keep the most recent.
    const existing = index.get(email);
    if (!existing || sub.created > existing.subscriptionDate) {
      index.set(email, {
        mrr,
        productId: typeof price?.product === 'string' ? price.product : price?.product?.id || null,
        subscriptionSummary: `${billingCycleFor(items)} · ${sub.status}`,
        subscriptionDate: sub.created,
      });
    }
  }

  const uniqueProductIds = Array.from(new Set(Array.from(index.values()).map((v) => v.productId).filter(Boolean)));
  const productNames = new Map();
  // GetProducts supports a batch `ids` filter (confirmed against this
  // account's Stripe API), so all product names come back in chunks of up
  // to 100 instead of one request per product.
  for (let i = 0; i < uniqueProductIds.length; i += 100) {
    const chunk = uniqueProductIds.slice(i, i + 100);
    const { data: products } = await stripe.products.list({ ids: chunk, limit: 100 });
    for (const product of products) productNames.set(product.id, product.name || 'Unknown product');
  }
  for (const v of index.values()) {
    v.product = v.productId ? productNames.get(v.productId) || 'Unknown product' : 'Unknown product';
  }

  return index;
}

// ---------- HubSpot: email -> contact owner ----------

async function hubspotFetch(path, options = {}) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HubSpot API responded ${res.status}${body ? `: ${body}` : ''}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function findContactByEmail(email) {
  const json = await hubspotFetch('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['hubspot_owner_id'],
      limit: 1,
    }),
  });
  return json.results?.[0] || null;
}

// Owner id -> display name, cached per refresh cycle so the same owner
// (frequently the same person owns many contacts) isn't re-fetched.
async function getOwnerName(ownerId, cache) {
  if (!ownerId) return null;
  if (cache.has(ownerId)) return cache.get(ownerId);
  const json = await hubspotFetch(`/crm/v3/owners/${ownerId}`);
  const name = [json.firstName, json.lastName].filter(Boolean).join(' ') || json.email || `Owner ${ownerId}`;
  cache.set(ownerId, name);
  return name;
}

// Resolves the contact owner for every unique email in one batch, deduped and
// rate-limited. If the token itself is bad, every lookup fails the same way,
// so the first 401/403 short-circuits the rest instead of repeating the
// failure for every remaining customer.
async function resolveContactOwners(emails) {
  const byEmail = new Map();

  if (!HUBSPOT_TOKEN) {
    for (const email of emails) byEmail.set(email, 'HubSpot not configured');
    return byEmail;
  }

  const ownerNameCache = new Map();
  let authFailed = false;

  await mapWithConcurrency(emails, 5, async (email) => {
    if (authFailed) {
      byEmail.set(email, 'HubSpot authentication error');
      return;
    }
    try {
      const contact = await findContactByEmail(email);
      if (!contact) {
        byEmail.set(email, null); // no matching HubSpot contact — leave unpopulated
        return;
      }
      const ownerId = contact.properties?.hubspot_owner_id || null;
      byEmail.set(email, ownerId ? await getOwnerName(ownerId, ownerNameCache) : 'Unassigned');
    } catch (err) {
      if (err.statusCode === 401 || err.statusCode === 403) authFailed = true;
      byEmail.set(email, authFailed ? 'HubSpot authentication error' : 'HubSpot lookup failed');
    }
  });

  return byEmail;
}

// ---------- ProfitWell company-wide monthly metrics (summary panel) ----------

// The ProfitWell v2 response shape (a `data` object keyed by metric-trend
// name, each an array of {date, value} points) is documented, but this
// session's network policy blocks outbound calls to api.profitwell.com, so
// the exact trend-name strings below could not be confirmed against a live
// response. Matching is done by scanning for any of several known aliases
// per concept rather than a single hardcoded key, and any concept that
// can't be found is reported as unavailable instead of guessed.
const METRIC_ALIASES = {
  currentMrr: ['recurring_revenue', 'active_recurring_revenue', 'total_recurring_revenue', 'mrr'],
  expansionMrr: ['upgrade_recurring_revenue', 'upgraded_recurring_revenue', 'upgrade', 'expansion_recurring_revenue'],
  contractionMrr: ['downgrade_recurring_revenue', 'downgraded_recurring_revenue', 'downgrade', 'contraction_recurring_revenue'],
  churnedMrr: ['churned_recurring_revenue', 'churn_recurring_revenue', 'churn'],
  reactivatedMrr: ['reactivation_recurring_revenue', 'reactivated_recurring_revenue', 'reactivation'],
};

function findSeries(data, aliases) {
  const keys = Object.keys(data || {});
  for (const alias of aliases) {
    const hit = keys.find((k) => k.toLowerCase() === alias);
    if (hit) return data[hit];
  }
  return null;
}

function lastTwo(series) {
  if (!series || series.length === 0) return [null, null];
  const sorted = [...series].sort((a, b) => new Date(a.date) - new Date(b.date));
  const current = sorted[sorted.length - 1]?.value ?? null;
  const previous = sorted.length > 1 ? sorted[sorted.length - 2]?.value ?? null : null;
  return [current, previous];
}

async function fetchProfitWellMetrics() {
  if (!PROFITWELL_TOKEN) {
    return { error: 'PROFITWELL_TOKEN is not configured on the server.' };
  }

  const res = await fetch(`${PROFITWELL_METRICS_BASE}metrics/monthly/`, {
    headers: { Authorization: PROFITWELL_TOKEN },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`ProfitWell API responded ${res.status}: ${body || res.statusText}`);
    err.statusCode = res.status;
    throw err;
  }

  const json = await res.json();
  const data = json.data || {};

  const [currentMrr, previousMrr] = lastTwo(findSeries(data, METRIC_ALIASES.currentMrr));
  const [expansionMrr] = lastTwo(findSeries(data, METRIC_ALIASES.expansionMrr));
  const [contractionMrr] = lastTwo(findSeries(data, METRIC_ALIASES.contractionMrr));
  const [churnedMrr] = lastTwo(findSeries(data, METRIC_ALIASES.churnedMrr));
  const [reactivatedMrr] = lastTwo(findSeries(data, METRIC_ALIASES.reactivatedMrr));

  return {
    startingMrr: previousMrr,
    previousMonthMrr: previousMrr,
    currentMrr,
    mrrDelta: currentMrr != null && previousMrr != null ? currentMrr - previousMrr : null,
    expansionMrr,
    contractionMrr,
    churnedMrr,
    reactivatedMrr,
    rawKeysSeen: Object.keys(data),
  };
}

// ---------- assemble: ProfitWell customers as the base, joined by email ----------

async function buildCustomerRows() {
  const pwCustomers = await fetchProfitwellCustomers();
  const emails = pwCustomers.map((c) => c.email);

  const [stripeIndex, hubspotByEmail] = await Promise.all([
    buildStripeIndexByEmail(),
    resolveContactOwners(emails),
  ]);

  return pwCustomers.map((c) => {
    const s = stripeIndex.get(c.email);
    return {
      email: c.email,
      profitwellMrr: c.mrr,
      stripeMrr: s ? s.mrr : null,
      stripeProduct: s ? s.product : null,
      stripeSubscription: s ? s.subscriptionSummary : null,
      hubspotContactOwner: hubspotByEmail.get(c.email) ?? null,
    };
  });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/dashboard-data', async (req, res) => {
  try {
    const [customers, companyMetrics] = await Promise.all([buildCustomerRows(), fetchProfitWellMetrics()]);
    res.json({
      generatedAt: new Date().toISOString(),
      companyMetrics,
      customers,
    });
  } catch (err) {
    console.error(err);
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.message || 'Unknown error fetching dashboard data.' });
  }
});

app.listen(PORT, () => {
  console.log(`Stripe/ProfitWell/HubSpot dashboard listening on http://localhost:${PORT}`);
});
