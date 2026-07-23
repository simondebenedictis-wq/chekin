require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');

const PORT = process.env.PORT || 3000;
const PROFITWELL_TOKEN = process.env.PROFITWELL_TOKEN;
const PROFITWELL_BASE = 'https://api.profitwell.com/v2/';

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill it in.');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

// Statuses treated as "active/recent" per the spec. Fully-dead subscriptions
// (canceled, incomplete_expired) are excluded from the customer table.
const RELEVANT_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

// Stripe tax_id `type` values are prefixed with an ISO-3166 alpha-2 country
// code for every type except the EU-wide `eu_vat`, which doesn't map to a
// single country and is skipped.
function countryFromTaxIds(taxIds) {
  if (!taxIds || !taxIds.length) return null;
  for (const t of taxIds) {
    if (t.type === 'eu_vat') continue;
    const m = /^([a-z]{2})_/.exec(t.type || '');
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function resolveCountry(customer, taxIds) {
  return (
    customer.address?.country ||
    customer.shipping?.address?.country ||
    countryFromTaxIds(taxIds) ||
    null
  );
}

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

function paymentTypeFor(collectionMethod) {
  if (collectionMethod === 'charge_automatically') return 'Automatic';
  if (collectionMethod === 'send_invoice') return 'Manual';
  return collectionMethod || 'Unknown';
}

function monthKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + '-' + String(y).slice(2);
}

// Batches concurrent async work so we don't fire hundreds of Stripe requests
// (e.g. tax-id lookups) at once and hit rate limits.
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

// Fetches every paid invoice in the account (auto-paginating) and groups
// amounts by customer + calendar month, so per-customer monthly MRR history
// and lifetime-expansion figures come from one paginated list instead of a
// separate API call per customer.
async function fetchInvoiceHistory() {
  const byCustomer = new Map();
  const monthSet = new Set();

  for await (const invoice of stripe.invoices.list({ status: 'paid', limit: 100 })) {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customerId) continue;
    const ts = invoice.status_transitions?.paid_at || invoice.created;
    const key = monthKey(ts);
    monthSet.add(key);
    if (!byCustomer.has(customerId)) byCustomer.set(customerId, []);
    byCustomer.get(customerId).push({ ts, monthKey: key, amount: (invoice.amount_paid || 0) / 100 });
  }

  for (const list of byCustomer.values()) list.sort((a, b) => a.ts - b.ts);

  return { byCustomer, months: Array.from(monthSet).sort() };
}

// Sum of positive month-over-month invoice-amount increases across a
// customer's full paid-invoice history, versus their first invoice amount.
// This is a derived estimate, not an official Stripe/ProfitWell metric.
function lifetimeExpansion(invoices) {
  if (!invoices || invoices.length === 0) return { eur: null, pct: null };
  const first = invoices[0].amount;
  let expansion = 0;
  for (let i = 1; i < invoices.length; i++) {
    const diff = invoices[i].amount - invoices[i - 1].amount;
    if (diff > 0) expansion += diff;
  }
  const pct = first > 0 ? (expansion / first) * 100 : null;
  return { eur: expansion, pct };
}

function monthlyTotalsFor(invoices, months) {
  const totals = {};
  for (const m of months) totals[m] = null;
  for (const inv of invoices || []) {
    totals[inv.monthKey] = (totals[inv.monthKey] || 0) + inv.amount;
  }
  return totals;
}

async function buildCustomerRows() {
  const { byCustomer, months } = await fetchInvoiceHistory();

  const subscriptions = [];
  for await (const sub of stripe.subscriptions.list({
    status: 'all',
    limit: 100,
    expand: ['data.customer', 'data.items.data.price.product'],
  })) {
    if (RELEVANT_STATUSES.has(sub.status)) subscriptions.push(sub);
  }

  // customer.tax_ids isn't included on the subscription's expanded customer,
  // so only fetch it (per customer, deduped) when address/shipping are both
  // missing and we actually need the fallback.
  const needsTaxIds = subscriptions.filter(
    (sub) => !sub.customer?.address?.country && !sub.customer?.shipping?.address?.country
  );
  const uniqueCustomerIds = Array.from(new Set(needsTaxIds.map((s) => s.customer.id)));
  const taxIdMap = new Map();
  await mapWithConcurrency(uniqueCustomerIds, 5, async (customerId) => {
    try {
      const list = await stripe.customers.listTaxIds(customerId, { limit: 10 });
      taxIdMap.set(customerId, list.data);
    } catch (e) {
      taxIdMap.set(customerId, []);
    }
  });

  const rows = subscriptions.map((sub) => {
    const customer = sub.customer;
    const items = sub.items.data;
    const firstItem = items[0];
    const price = firstItem?.price;
    const product = price?.product;

    const country = resolveCountry(customer, taxIdMap.get(customer.id));
    const invoices = byCustomer.get(customer.id) || [];
    const expansion = lifetimeExpansion(invoices);
    const monthlyTotals = monthlyTotalsFor(invoices, months);

    const unitAmount = price?.unit_amount;
    const currentMrr = unitAmount != null ? (unitAmount * (firstItem.quantity || 1)) / 100 : null;

    return {
      customerId: customer.id,
      email: customer.email || 'Not provided',
      subscriptionDate: sub.created,
      product: product?.name || 'Unknown product',
      billingCycle: billingCycleFor(items),
      paymentType: paymentTypeFor(sub.collection_method),
      country: country || 'Not provided',
      currentMrr,
      renewalDate: sub.current_period_end,
      expectedArrAtRenewal: currentMrr != null ? currentMrr * 12 : null,
      lifetimeExpansionEur: expansion.eur,
      lifetimeExpansionPct: expansion.pct,
      monthlyTotals,
    };
  });

  return { rows, months };
}

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

  const res = await fetch(`${PROFITWELL_BASE}metrics/monthly/`, {
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

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/dashboard-data', async (req, res) => {
  try {
    const [customerData, profitwell] = await Promise.all([buildCustomerRows(), fetchProfitWellMetrics()]);
    res.json({
      generatedAt: new Date().toISOString(),
      companyMetrics: profitwell,
      months: customerData.months,
      monthLabels: Object.fromEntries(customerData.months.map((m) => [m, monthLabel(m)])),
      customers: customerData.rows,
    });
  } catch (err) {
    console.error(err);
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.message || 'Unknown error fetching dashboard data.' });
  }
});

app.listen(PORT, () => {
  console.log(`Stripe/ProfitWell dashboard listening on http://localhost:${PORT}`);
});
