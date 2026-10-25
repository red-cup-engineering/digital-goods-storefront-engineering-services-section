import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createDigitalGoodsStorefrontWorker } from '../src/worker-runtime.mjs';
import { createDurableFulfillment, DigitalGoodsFulfillment } from '../src/durable-fulfillment.mjs';
import { validateCatalog, stripeOfferingFor, publicCatalog } from '../src/digital-goods-storefront.mjs';
import { createSessionCookie } from '@red-cup-engineering/computer-web-server/admission/session';
import { digest, resolveSubscriptionAccess, SUBSCRIPTION_READ_API_VERSION } from '@red-cup-engineering/stripe-services-section';

const ACTOR = 'urn:fixture:original-shop-buyer';
const ACCOUNT = 'reader@example.test';
const EVENT_CATEGORY = 'stripe-webhook-event-admission.events';
const CHECKOUT_CATEGORY = 'stripe-checkout-session-creation.receipts';
const CONTRACT = 'ni:///sha-256;' + 'a'.repeat(43);
const originalOffering = {
  id: 'fixture-subscription', title: 'Fixture subscription', line: 'urn:fixture:publisher',
  blurb: 'Inert receiving fixture; no actual product or rights.', status: 'live',
  priceCents: 1200, currency: 'usd', mode: 'subscription', recurring: { interval: 'month' },
  contractRef: 'https://shop.test/contracts/fixture', contractRevision: CONTRACT,
  terms: 'urn:fixture:terms', taxPolicy: 'urn:fixture:tax', refundPolicy: 'urn:fixture:refund',
};
const catalogOf = offering => ({ merchant: { name: 'Fixture merchant', legalBody: 'fixture-merchant' }, offerings: [offering] });
const accounts = { clientId: 'fixture-client', clientSecret: 'fixture-secret', sessionSecret: 'fixture-session-secret' };
const cookie = email => createSessionCookie({ name: 'storefront_session', subject: 'fixture-reader', subjectHash: 'h', email,
  secret: accounts.sessionSecret, now: Date.now }).split(';')[0];
const request = (email = ACCOUNT) => new Request('https://shop.test/private-host-read', {
  headers: email ? { cookie: cookie(email) } : {},
});
function nativeStore() {
  const rows = new Map(), reads = [];
  const storage = {
    async get(key) { return structuredClone(rows.get(key)); },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async list(options = {}) {
      reads.push(structuredClone(options));
      return new Map([...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([key]) =>
        (!options.prefix || key.startsWith(options.prefix)) && (!options.startAfter || key > options.startAfter))
        .slice(0, options.limit ?? Infinity).map(([key, value]) => [key, structuredClone(value)]));
    },
    async transaction(work) { return work(storage); },
  };
  const object = new DigitalGoodsFulfillment({ storage });
  const fulfillment = createDurableFulfillment({ idFromName: () => 'original-shop', get: () => ({
    fetch: (url, init) => object.fetch(new Request(url, init)),
  }) }, 'original-shop');
  return { rows, reads, object, fulfillment };
}
function signedEvent(value, secret) {
  const raw = JSON.stringify(value), at = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${at}.${raw}`).digest('hex');
  return new Request('https://shop.test/webhooks/stripe', { method: 'POST', body: raw,
    headers: { 'stripe-signature': `t=${at},v1=${signature}` } });
}
async function fixture({ offering = originalOffering, start = true } = {}) {
  const native = nativeStore(), catalog = catalogOf(structuredClone(offering));
  const runtime = createDigitalGoodsStorefrontWorker({ catalog, origin: 'https://shop.test', buyerActor: ACTOR });
  const env = { fulfillment: native.fulfillment, audit: native.fulfillment.audit,
    accounts, goods: { async get() { return null; } }, tokenSecret: 'fixture-token',
    STRIPE_SECRET_KEY: 'sk_live_fixture_not_a_real_key', STRIPE_WEBHOOK_SECRET: 'fixture-webhook-secret',
    STRIPE_CUSTOMER_CONTRACT_TOKEN: 'fixture-contract' };
  const calls = [];
  async function checkout(email = ACCOUNT) {
    const before = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, method: init.method, form: Object.fromEntries(init.body) });
      return Response.json({ id: 'cs_fixture', url: 'https://checkout.stripe.test/fixture', amount_total: 1200,
        currency: 'usd', payment_status: 'unpaid', status: 'open' });
    };
    try { return await runtime.fetch(new Request('https://shop.test/checkout/fixture-subscription', { method: 'POST',
      headers: { origin: 'https://shop.test', ...(email ? { cookie: cookie(email) } : {}) } }), env); }
    finally { globalThis.fetch = before; }
  }
  if (start) assert.equal((await checkout()).status, 303);
  const order = () => native.fulfillment.getCheckout('cs_fixture');
  const event = (id, type, object) => ({ id, type, livemode: true, created: Math.floor(Date.now() / 1000), data: { object } });
  async function subscriptionEvent(id = 'evt_subscription', extra = {}) {
    const held = await order();
    return event(id, 'customer.subscription.created', { id: 'sub_fixture', object: 'subscription', status: 'active',
      metadata: { customer_settlement: ACTOR, offering_id: offering.id, request_digest: held.requestDigest }, ...extra });
  }
  const receive = value => runtime.fetch(signedEvent(value, env.STRIPE_WEBHOOK_SECRET), env);
  const read = (email = ACCOUNT, selector = { subscriptionId: 'sub_fixture' }) => runtime.readSubscriptionOrder(request(email), selector, env);
  return { ...native, runtime, catalog, env, calls, checkout, order, event, subscriptionEvent, receive, read };
}

test('authored recurring contracts preserve exact interval and agreement in the original Stripe projection', () => {
  for (const interval of ['day', 'week', 'month', 'year']) {
    const offering = { ...originalOffering, recurring: { interval, intervalCount: 2 } };
    assert.equal(validateCatalog(catalogOf(offering)).valid, true);
    const projected = stripeOfferingFor(offering);
    assert.equal(projected.mode, 'subscription');
    assert.deepEqual(projected.recurring, offering.recurring);
    assert.equal(projected.contractRef, offering.contractRef);
    assert.equal(projected.contractRevision, CONTRACT);
    const published = publicCatalog(catalogOf(offering)).offerings[0];
    assert.equal(published.mode, 'subscription'); assert.deepEqual(published.recurring, offering.recurring);
    assert.notEqual(digest(projected), digest({ ...projected, contractRevision: 'ni:///sha-256;' + 'b'.repeat(43) }));
  }
});

test('recurring catalog refuses missing agreements, ambiguous modes, invalid intervals and perpetual download claims', () => {
  for (const change of [{ contractRef: undefined }, { contractRevision: undefined }, { contractRevision: 'latest' },
    { mode: undefined }, { mode: 'payment' }, { recurring: null }, { recurring: { interval: 'fortnight' } },
    { recurring: { interval: 'month', intervalCount: 0 } }, { release: 'perpetual-book' },
    { goods: [{ key: 'perpetual.epub' }] }]) {
    assert.equal(validateCatalog(catalogOf({ ...originalOffering, ...change })).valid, false, JSON.stringify(change));
  }
});

test('recurring human listing discloses the billing period and sign-in precedes any Checkout effect', async () => {
  const f = await fixture({ start: false });
  const page = await f.runtime.fetch(new Request('https://shop.test/goods/fixture-subscription'), f.env);
  assert.match(await page.text(), /\$12\.00.*month/u);
  const response = await f.checkout(null);
  assert.notEqual(response.status, 303); assert.equal(f.calls.length, 0); assert.equal(f.rows.size, 0);
});

test('original authenticated reader, Checkout request and exact host actor are retained without equating their identities', async () => {
  const f = await fixture(), held = await f.order();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].form.mode, 'subscription');
  assert.equal(f.calls[0].form['subscription_data[metadata][customer_settlement]'], ACTOR);
  assert.notEqual(ACTOR, ACCOUNT); assert.ok(!JSON.stringify(f.calls[0].form).includes(ACCOUNT));
  assert.equal(held.account, ACCOUNT); assert.equal(held.buyerActor, ACTOR); assert.equal(held.mode, 'subscription');
  assert.equal(digest({ actor: ACTOR, request: held.request, offering: held.offering }), held.requestDigest);
  assert.equal(held.offering.contractRevision, CONTRACT);
  assert.equal(await f.fulfillment.getEntitlement('cs_fixture'), null);
});

test('same durable recurring Checkout cannot switch its original actor, request, offering or account', async () => {
  const f = await fixture(), held = await f.order();
  for (const change of [{ buyerActor: 'urn:other:actor' }, { account: 'other@example.test' }, { mode: 'payment' },
    { request: { ...held.request, customerReference: 'switched' } },
    { offering: { ...held.offering, contractRevision: 'ni:///sha-256;' + 'b'.repeat(43) } }]) {
    assert.equal((await f.fulfillment.recordCheckout({ ...held, ...change })).disposition, 'conflict');
    assert.deepEqual(await f.order(), held);
  }
});

test('native signed subscription joins through the same audit/checkout custody and returns billing input only', async () => {
  const f = await fixture();
  const value = await f.subscriptionEvent(); assert.equal((await f.receive(value)).status, 200);
  assert.equal((await f.fulfillment.audit.query({ category: EVENT_CATEGORY, strict: true })).length, 1);
  const result = await f.read();
  assert.equal(result.type, 'StorefrontSubscriptionOrder', JSON.stringify(result));
  assert.equal(result.subscriber, ACCOUNT); assert.equal(result.stripeSessionId, 'cs_fixture');
  assert.equal(result.contractRef, originalOffering.contractRef); assert.equal(result.contractRevision, CONTRACT);
  assert.deepEqual(result.billingInput, { authenticatedActor: ACTOR, subscriptionId: 'sub_fixture',
    requestDigest: (await f.order()).requestDigest, offeringId: originalOffering.id });
  for (const key of ['admitted', 'status', 'profiles', 'rights', 'accessGranted', 'notBefore', 'expiresAt'])
    assert.equal(Object.hasOwn(result, key), false, key);
  assert.equal(await f.fulfillment.getEntitlement('cs_fixture'), null);
  assert.equal((await f.runtime.fetch(new Request('https://shop.test/private-host-read'), f.env)).status, 404);
});

test('host join rejects another or absent reader and selectors that supply identity or contracts', async () => {
  const f = await fixture(); await f.receive(await f.subscriptionEvent());
  for (const account of [null, 'other@example.test'])
    assert.equal((await f.read(account)).type, 'StorefrontSubscriptionOrderRefusal');
  for (const extra of [{ account: ACCOUNT }, { buyerActor: ACTOR }, { requestDigest: (await f.order()).requestDigest },
    { offeringId: originalOffering.id }, { root: '/tmp/other' }, { contractRef: originalOffering.contractRef }])
    assert.equal((await f.read(ACCOUNT, { subscriptionId: 'sub_fixture', ...extra })).type, 'StorefrontSubscriptionOrderRefusal');
});

test('missing, legacy or altered contract bindings cannot become an inferred recurring order', async () => {
  const f = await fixture();
  assert.equal((await f.read()).type, 'StorefrontSubscriptionOrderRefusal');
  await f.receive(await f.subscriptionEvent());
  const original = f.rows.get('checkout:cs_fixture');
  for (const change of [{ buyerActor: undefined }, { mode: undefined }, { account: null },
    { offering: { ...original.offering, contractRevision: 'ni:///sha-256;' + 'c'.repeat(43) } }]) {
    f.rows.set('checkout:cs_fixture', { ...original, ...change });
    assert.equal((await f.read()).type, 'StorefrontSubscriptionOrderRefusal');
  }
  f.rows.set('checkout:cs_fixture', original);
  const changed = createDigitalGoodsStorefrontWorker({ catalog: catalogOf({ ...originalOffering,
    contractRevision: 'ni:///sha-256;' + 'b'.repeat(43) }), origin: 'https://shop.test', buyerActor: ACTOR });
  assert.equal((await changed.readSubscriptionOrder(request(), { subscriptionId: 'sub_fixture' }, f.env)).type,
    'StorefrontSubscriptionOrderRefusal');
});

test('unsigned and conflicting signed subscription witnesses cannot supply an order binding', async () => {
  const f = await fixture(), value = await f.subscriptionEvent();
  assert.equal((await f.runtime.fetch(signedEvent(value, 'wrong-secret'), f.env)).status, 400);
  assert.equal((await f.read()).type, 'StorefrontSubscriptionOrderRefusal');
  await f.receive(value);
  const conflict = structuredClone(value); conflict.data.object.metadata.customer_settlement = 'urn:other:actor';
  assert.equal((await f.receive(conflict)).status, 409);
  assert.equal((await f.read()).type, 'StorefrontSubscriptionOrderRefusal');
  assert.ok([...f.rows.values()].some(row => row.record?.conflict === true));
});

test('recurring paid Checkout is observed but never grants the existing perpetual download entitlement', async () => {
  const f = await fixture(), held = await f.order();
  const value = f.event('evt_checkout', 'checkout.session.completed', { id: 'cs_fixture', object: 'checkout.session',
    mode: 'subscription', subscription: 'sub_fixture', amount_total: 1200, currency: 'usd', status: 'complete', payment_status: 'paid',
    metadata: { offering_id: held.offeringId, request_digest: held.requestDigest, customer_settlement: ACTOR } });
  const response = await f.receive(value); assert.equal(response.status, 200);
  assert.equal((await response.json()).subscriptionObserved, true);
  assert.equal(await f.fulfillment.getEntitlement('cs_fixture'), null);
  const grant = await f.fulfillment.claimPayment({ eventId: 'evt_direct_claim', sessionId: 'cs_fixture',
    offeringId: held.offeringId, requestDigest: held.requestDigest, stripeMode: 'live', amountTotal: 1200,
    currency: 'usd', paymentStatus: 'paid', status: 'complete' });
  assert.equal(grant.disposition, 'rejected'); assert.equal(await f.fulfillment.getEntitlement('cs_fixture'), null);
});

test('strict original audit query refuses malformed and misplaced rows instead of filtering away revocation evidence', async () => {
  const f = await fixture(); await f.receive(await f.subscriptionEvent());
  assert.equal(typeof f.fulfillment.audit.query, 'function');
  const entry = structuredClone(f.rows.get('audit:urn:stripe-event-receipt:evt_subscription'));
  for (const [key, value] of [['audit:broken', null], ['audit:wrong-key', entry],
    ['audit:urn:stripe-event-receipt:evt_bad_category', { ...entry, category: CHECKOUT_CATEGORY,
      record: { ...entry.record, id: 'urn:stripe-event-receipt:evt_bad_category', stripeEventId: 'evt_bad_category' } }]]) {
    f.rows.set(key, value);
    await assert.rejects(f.fulfillment.audit.query({ category: CHECKOUT_CATEGORY, strict: true }));
    assert.equal((await f.read()).type, 'StorefrontSubscriptionOrderRefusal');
    f.rows.delete(key);
  }
  for (const input of [{ category: EVENT_CATEGORY, strict: false }, { category: 'caller-selected-private-store', strict: true },
    { category: EVENT_CATEGORY, strict: true, limit: 0 }, { category: EVENT_CATEGORY, strict: true, path: '/other' }])
    await assert.rejects(f.fulfillment.audit.query(input));
  assert.ok(f.reads.every(read => read.prefix === 'audit:' && Number.isSafeInteger(read.limit) && read.limit <= 64));
});

test('strict original audit query bounds the complete scan even when the caller selects one returned row', async () => {
  const f = await fixture(); await f.receive(await f.subscriptionEvent());
  const entry = f.rows.get('audit:urn:stripe-event-receipt:evt_subscription');
  for (let n = 0; n < 2050; n++) {
    const id = `evt_extra_${n}`; f.rows.set('audit:urn:stripe-event-receipt:' + id,
      { ...entry, record: { ...entry.record, id: 'urn:stripe-event-receipt:' + id, stripeEventId: id } });
  }
  await assert.rejects(f.fulfillment.audit.query({ category: EVENT_CATEGORY, strict: true, limit: 1 }));
  assert.ok(f.reads.length <= 34, 'bounded scan must not traverse the entire growing store');
});

test('strict original audit query refuses oversized stored bytes and incomplete native replies', async () => {
  const f = await fixture(); await f.receive(await f.subscriptionEvent());
  const key = 'audit:urn:stripe-event-receipt:evt_subscription', entry = f.rows.get(key);
  f.rows.set(key, { ...entry, unsupportedPadding: 'x'.repeat(2 * 1024 * 1024) });
  await assert.rejects(f.fulfillment.audit.query({ category: CHECKOUT_CATEGORY, strict: true }));
  for (const body of [{ entries: [] }, { complete: false, entries: [] }, { complete: true, entries: [null] },
    { complete: true, entries: [entry] }]) {
    const client = createDurableFulfillment({ idFromName: () => 'original-shop', get: () => ({
      fetch: async () => Response.json(body),
    }) }, 'original-shop');
    await assert.rejects(client.audit.query({ category: CHECKOUT_CATEGORY, strict: true }));
  }
});

test('recurring checkout refuses absent, divergent or damaged original custody before invoking Stripe', async () => {
  for (const defect of ['missing-query', 'different-audit', 'damaged']) {
    const f = await fixture({ start: false });
    if (defect === 'missing-query') delete f.fulfillment.audit.query;
    if (defect === 'different-audit') f.env.audit = { ...f.fulfillment.audit };
    if (defect === 'damaged') f.rows.set('audit:broken', null);
    assert.equal((await f.checkout()).status, 503, defect);
    assert.equal(f.calls.length, 0, defect);
  }
});

test('recurring purchase affordance depends on original reader and audit capabilities', async () => {
  const f = await fixture({ start: false });
  for (const env of [{ ...f.env, accounts: {} }, { ...f.env, audit: { record() {} } }]) {
    const catalog = await (await f.runtime.fetch(new Request('https://shop.test/catalog.json'), env)).json();
    assert.equal(catalog.offerings[0].buyable, false);
    const body = await (await f.runtime.fetch(new Request('https://shop.test/goods/fixture-subscription'), env)).text();
    assert.doesNotMatch(body, /action="\/checkout\/fixture-subscription"/u);
  }
  assert.equal((await (await f.runtime.fetch(new Request('https://shop.test/catalog.json'), f.env)).json()).offerings[0].buyable, true);
});

test('recurring thanks confirms only the authenticated original order and never offers permanent downloads', async () => {
  const f = await fixture();
  for (const email of [ACCOUNT, null, 'other@example.test']) {
    const response = await f.runtime.fetch(new Request('https://shop.test/thanks?session_id=cs_fixture', {
      headers: email ? { cookie: cookie(email) } : {},
    }), f.env);
    assert.equal(response.status, email === ACCOUNT ? 200 : 404);
    const body = await response.text();
    if (email === ACCOUNT) assert.match(body, /Subscription order/u);
    assert.doesNotMatch(body, /href="\/download\//u);
  }
});

// Actual original Stripe 0.2.1 billing input/reader; the only substituted edge
// is its explicitly supplied inert HTTP provider, using native Basil shapes.
async function billingFixture() {
  const f = await fixture(), order = await f.order(), now = new Date(), start = Math.floor(now.getTime() / 1000) - 3600, end = start + 86400;
  const list = data => ({ object: 'list', has_more: false, data });
  const metadata = { customer_settlement: ACTOR, offering_id: order.offeringId, request_digest: order.requestDigest };
  const item = { id: 'si_fixture', object: 'subscription_item', subscription: 'sub_fixture', quantity: 1,
    current_period_start: start, current_period_end: end,
    price: { id: 'price_fixture', object: 'price', product: 'prod_fixture', livemode: true, type: 'recurring',
      billing_scheme: 'per_unit', transform_quantity: null, currency: 'usd', unit_amount: 1200,
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } };
  const subscription = { id: 'sub_fixture', object: 'subscription', metadata, livemode: true, status: 'active',
    customer: 'cus_fixture', latest_invoice: 'in_fixture', items: list([item]), ended_at: null,
    pause_collection: null, pending_update: null, cancel_at_period_end: false, cancel_at: null };
  const checkout = { id: 'cs_fixture', object: 'checkout.session', subscription: 'sub_fixture', customer: 'cus_fixture',
    livemode: true, mode: 'subscription', status: 'complete', payment_status: 'paid', metadata };
  const line = { id: 'il_fixture', object: 'line_item', livemode: true, amount: 1200, currency: 'usd', quantity: 1,
    parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_fixture',
      subscription_item: item.id, proration: false } },
    pricing: { type: 'price_details', price_details: { price: item.price.id, product: item.price.product } }, period: { start, end } };
  const invoice = { id: 'in_fixture', object: 'invoice', livemode: true, customer: 'cus_fixture', status: 'paid',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_fixture', metadata } },
    amount_paid: 1200, amount_due: 1200, amount_remaining: 0, total: 1200, currency: 'usd', starting_balance: 0,
    pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, billing_reason: 'subscription_cycle',
    period_start: start - 30 * 86400, period_end: start, lines: list([line]) };
  const payment = { id: 'inpay_fixture', object: 'invoice_payment', invoice: invoice.id, livemode: true,
    status: 'paid', amount_paid: 1200, amount_requested: 1200, currency: 'usd', payment: { type: 'payment_intent', payment_intent: 'pi_fixture' } };
  const charge = { id: 'ch_fixture', object: 'charge', payment_intent: 'pi_fixture', customer: 'cus_fixture', livemode: true,
    status: 'succeeded', paid: true, captured: true, amount: 1200, amount_captured: 1200, currency: 'usd',
    refunded: false, amount_refunded: 0, disputed: false };
  const intent = { id: 'pi_fixture', object: 'payment_intent', livemode: true, customer: 'cus_fixture', status: 'succeeded',
    amount_received: 1200, currency: 'usd', latest_charge: charge };
  const routes = { '/v1/account': { id: 'acct_fixture', object: 'account' }, '/v1/checkout/sessions/cs_fixture': checkout,
    '/v1/subscriptions/sub_fixture': subscription, '/v1/invoices/in_fixture': invoice,
    '/v1/invoice_payments': list([payment]), '/v1/payment_intents/pi_fixture': intent };
  assert.equal((await f.receive(f.event('evt_current_sub', 'customer.subscription.created', subscription))).status, 200);
  const reads = [];
  return { ...f, subscription, charge, invoice, reads, async billing() {
    const original = await f.read(); assert.equal(original.type, 'StorefrontSubscriptionOrder', JSON.stringify(original));
    return resolveSubscriptionAccess(original.billingInput, { env: f.env, store: f.fulfillment.audit,
      catalog: { merchant: f.catalog.merchant, offerings: f.catalog.offerings.map(stripeOfferingFor) },
      expectedAccountId: 'acct_fixture', now, fetchImpl: async (url, init) => {
        const parsed = new URL(url); assert.equal(parsed.origin, 'https://api.stripe.com'); assert.equal(init.method, 'GET');
        assert.equal(init.headers['Stripe-Version'], SUBSCRIPTION_READ_API_VERSION); assert.equal(init.redirect, 'error');
        assert.ok(routes[parsed.pathname]); reads.push(parsed.pathname); return Response.json(routes[parsed.pathname]);
      } });
  } };
}

test('host order joins the actual Stripe billing reader through the same original custody and stable two-read revision', async () => {
  const f = await billingFixture(), before = structuredClone([...f.rows]);
  const first = await f.billing(); assert.equal(first.admitted, true, JSON.stringify(first));
  const second = await f.billing(); assert.equal(second.admitted, true, JSON.stringify(second));
  assert.equal(first.billingRevision, second.billingRevision); assert.equal(first.customerSettlement, ACTOR);
  assert.notEqual(first.customerSettlement, ACCOUNT); assert.equal(f.reads.length, 14);
  assert.deepEqual([...f.rows], before, 'read-only joins and billing checks create no new custody or grant');
  for (const key of ['rights', 'queryProfiles', 'accessGranted']) assert.equal(Object.hasOwn(first, key), false);
  f.subscription.status = 'canceled';
  assert.equal((await f.billing()).admitted, false, 'order identity is insufficient when current provider state refuses');
});

for (const [type, object, reason] of [
  ['customer.subscription.deleted', { id: 'sub_fixture', object: 'subscription', status: 'canceled' }, 'subscription-revoked-by-verified-event'],
  ['charge.refunded', { id: 'ch_fixture', object: 'charge', amount_refunded: 1200 }, 'subscription-payment-refunded'],
  ['charge.dispute.created', { id: 'dp_fixture', object: 'dispute', charge: 'ch_fixture' }, 'subscription-payment-disputed'],
  ['credit_note.created', { id: 'cn_fixture', object: 'credit_note', invoice: 'in_fixture' }, 'subscription-current-invoice-credit-note-unsupported'],
]) test(`original recurring webhook retains ${type} and the actual billing reader refuses access evidence`, async () => {
  const f = await billingFixture(); assert.equal((await f.billing()).admitted, true);
  const received = await f.receive(f.event('evt_later', type, object)); assert.equal(received.status, 200);
  const result = await f.billing(); assert.equal(result.admitted, false); assert.equal(result.reason, reason);
  assert.equal(await f.fulfillment.getEntitlement('cs_fixture'), null);
});

for (const [type, object, field] of [
  ['charge.dispute.created', { id: 'dp_custody', object: 'dispute', charge: 'ch_fixture' }, 'stripeChargeId'],
  ['credit_note.created', { id: 'cn_custody', object: 'credit_note', invoice: 'in_fixture' }, 'stripeCreditNoteInvoiceId'],
]) test(`original strict audit cannot lose the ${field} relation from a retained ${type}`, async () => {
  const f = await billingFixture(); assert.equal((await f.billing()).admitted, true);
  assert.equal((await f.receive(f.event('evt_projection_custody', type, object))).status, 200);
  assert.equal((await f.billing()).admitted, false);
  const key = 'audit:urn:stripe-event-receipt:evt_projection_custody', damaged = structuredClone(f.rows.get(key));
  assert.equal(typeof damaged.record[field], 'string'); delete damaged.record[field]; f.rows.set(key, damaged);
  await assert.rejects(f.fulfillment.audit.query({ category: EVENT_CATEGORY, strict: true }), /audit-custody/u);
  assert.equal((await f.read()).type, 'StorefrontSubscriptionOrderRefusal');
  assert.deepEqual(f.rows.get(key), damaged, 'incomplete historical facts are neither filled in nor rewritten');
});

test('original recurring billing preserves canonical null, unrelated and native outside-catalog support observations', async () => {
  const f = await billingFixture();
  for (const object of [{ id: 'dp_null', object: 'dispute' }, { id: 'dp_other', object: 'dispute', charge: 'ch_other' }]) {
    assert.equal((await f.receive(f.event(`evt_${object.id}`, 'charge.dispute.created', object))).status, 200);
    const record = f.rows.get(`audit:urn:stripe-event-receipt:evt_${object.id}`).record;
    assert.equal(Object.hasOwn(record, 'stripeChargeId'), true); assert.equal(record.stripeChargeId, object.charge ?? null);
  }
  f.env.externalPaymentLinks = ['plink_support'];
  const response = await f.receive(f.event('evt_external_support', 'checkout.session.completed', {
    id: 'cs_support', payment_link: 'plink_support', amount_total: 1000, currency: 'usd', payment_status: 'paid', status: 'complete',
  }));
  assert.equal(response.status, 200); assert.equal((await response.json()).externalCheckoutObserved, true);
  assert.equal(f.rows.get('audit:urn:stripe-event-receipt:evt_external_support').record.type, 'StripeExternalPaymentLinkObservation');
  assert.equal((await f.billing()).admitted, true);
  assert.equal(await f.fulfillment.getCheckout('cs_support'), null); assert.equal(await f.fulfillment.getEntitlement('cs_support'), null);
});

test('original strict audit delegates adverse relation domains to its Stripe owner before category filtering', async () => {
  for (const [type, object, field] of [
    ['charge.dispute.created', { id: 'dp_domains', object: 'dispute', charge: 'ch_fixture' }, 'stripeChargeId'],
    ['credit_note.created', { id: 'cn_domains', object: 'credit_note', invoice: 'in_fixture' }, 'stripeCreditNoteInvoiceId'],
  ]) for (const invalid of [42, {}, '', []]) {
    const f = await billingFixture();
    assert.equal((await f.receive(f.event('evt_domain_custody', type, object))).status, 200);
    assert.equal((await f.billing()).admitted, false);
    const key = 'audit:urn:stripe-event-receipt:evt_domain_custody', damaged = structuredClone(f.rows.get(key));
    damaged.record[field] = invalid; f.rows.set(key, damaged);
    await assert.rejects(f.fulfillment.audit.query({ category: CHECKOUT_CATEGORY, strict: true }), /audit-custody/u);
    assert.equal((await f.read()).type, 'StorefrontSubscriptionOrderRefusal');
    assert.deepEqual(f.rows.get(key), damaged);
  }
});

