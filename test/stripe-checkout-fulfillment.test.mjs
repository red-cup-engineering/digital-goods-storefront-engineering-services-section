import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { fulfillStripeCheckoutWebhook } from "../src/stripe-checkout-fulfillment.mjs";
import { createDurableFulfillment, DigitalGoodsFulfillment } from "../src/durable-fulfillment.mjs";

const secret = "offline-webhook-fixture";
const checkout = { sessionId: "cs_fixture", offeringId: "fixture-book", requestDigest: "fixture-digest", amountTotal: 1200, currency: "usd", stripeMode: "test", goods: [] };
function event(type = "checkout.session.async_payment_succeeded", overrides = {}) {
  return { id: "evt_async", type, livemode: false, data: { object: { id: checkout.sessionId, amount_total: checkout.amountTotal, currency: checkout.currency, payment_status: "paid", status: "complete", payment_intent: "pi_fixture", metadata: { offering_id: checkout.offeringId, request_digest: checkout.requestDigest }, ...overrides } } };
}
function request(value, signingSecret = secret) {
  const body = JSON.stringify(value), timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex");
  return new Request("https://shop.test/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": `t=${timestamp},v1=${signature}` } });
}
async function fixture() {
  const rows = new Map();
  const storage = { async get(key) { return rows.get(key); }, async put(key, value) { rows.set(key, value); }, async transaction(work) { return work(storage); } };
  const runtime = new DigitalGoodsFulfillment({ storage });
  const fulfillment = createDurableFulfillment({ idFromName: () => "fixture", get: () => ({ fetch: (url, init) => runtime.fetch(new Request(url, init)) }) }, "fixture");
  await fulfillment.recordCheckout(checkout);
  return { rows, fulfillment, env: { fulfillment, STRIPE_WEBHOOK_SECRET: secret } };
}

test("a delayed paid event fulfills through the real Stripe signature and durable store", async () => {
  const f = await fixture();
  const response = await fulfillStripeCheckoutWebhook(request(event()), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, duplicate: false });
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
  assert.equal(f.rows.get("event:evt_async").type, "checkout.session.async_payment_succeeded");
});

test("unpaid completion cannot fulfill, then delayed success does", async () => {
  const f = await fixture();
  const pending = { ...event("checkout.session.completed", { payment_status: "unpaid" }), id: "evt_pending" };
  assert.equal((await fulfillStripeCheckoutWebhook(request(pending), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
  assert.equal(f.rows.has("event:evt_pending"), false);
  assert.equal((await fulfillStripeCheckoutWebhook(request(event()), f.env)).status, 200);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
});

test("duplicate and differently identified successful events retain one entitlement", async () => {
  const f = await fixture();
  await fulfillStripeCheckoutWebhook(request(event()), f.env);
  const original = structuredClone(await f.fulfillment.getEntitlement(checkout.sessionId));
  for (const paid of [event(), { ...event("checkout.session.completed"), id: "evt_immediate" }, { ...event(), id: "evt_async_again" }]) {
    const response = await fulfillStripeCheckoutWebhook(request(paid), f.env);
    assert.deepEqual(await response.json(), { accepted: true, duplicate: true });
    assert.deepEqual(await f.fulfillment.getEntitlement(checkout.sessionId), original);
  }
  assert.equal([...f.rows.keys()].filter(k => k.startsWith("entitlement:")).length, 1);
});

test("late unpaid completion does not undo earlier delayed success", async () => {
  const f = await fixture(); await fulfillStripeCheckoutWebhook(request(event()), f.env);
  const late = { ...event("checkout.session.completed", { payment_status: "unpaid" }), id: "evt_late" };
  assert.equal((await fulfillStripeCheckoutWebhook(request(late), f.env)).status, 409);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
});

for (const [name, change] of [
  ["unpaid", { payment_status: "unpaid" }],
  ["incomplete", { status: "open" }],
  ["wrong amount", { amount_total: 1 }],
  ["wrong currency", { currency: "eur" }],
  ["unknown session", { id: "cs_other" }],
  ["wrong offering", { metadata: { offering_id: "other-book", request_digest: checkout.requestDigest } }],
  ["wrong request", { metadata: { offering_id: checkout.offeringId, request_digest: "other-digest" } }],
]) test(`delayed success refuses ${name} without recording fulfillment`, async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(request(event(undefined, change)), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
  assert.equal(f.rows.has("event:evt_async"), false);
});

test("live and test receipts never cross their checkout mode", async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(request({ ...event(), livemode: true }), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
  await f.fulfillment.recordCheckout({ ...checkout, sessionId: "cs_live", stripeMode: "live" });
  assert.equal((await fulfillStripeCheckoutWebhook(request(event(undefined, { id: "cs_live" })), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement("cs_live"), null);
});

test("invalid signatures and missing live/test identity refuse delayed events", async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(request(event(), "wrong"), f.env)).status, 400);
  const malformed = event(); delete malformed.livemode;
  assert.equal((await fulfillStripeCheckoutWebhook(request(malformed), f.env)).status, 409);
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
});

test("unrelated and failed payment events cannot create an entitlement", async () => {
  const f = await fixture();
  for (const type of ["checkout.session.async_payment_failed", "payment_intent.succeeded", "charge.refunded"]) {
    assert.equal((await fulfillStripeCheckoutWebhook(request(event(type)), f.env)).status, 200);
  }
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
  assert.equal(f.rows.has("event:evt_async"), false);
});

test("a later delayed success never reactivates a revoked purchase", async () => {
  const f = await fixture(); await fulfillStripeCheckoutWebhook(request(event()), f.env);
  await f.fulfillment.revokeEntitlement({ id: checkout.sessionId, paymentIntentId: "pi_fixture", reason: "fixture withdrawal" });
  const response = await fulfillStripeCheckoutWebhook(request({ ...event(), id: "evt_later" }), f.env);
  assert.equal(response.status, 200);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "revoked");
});

test("storage failure requests retry and a subsequent delayed event succeeds", async () => {
  const f = await fixture();
  const failed = { ...f.env, fulfillment: { ...f.fulfillment, claimPayment: async () => ({ failed: true }) } };
  assert.equal((await fulfillStripeCheckoutWebhook(request(event()), failed)).status, 503);
  assert.equal((await fulfillStripeCheckoutWebhook(request(event()), f.env)).status, 200);
});

test("body bounds are enforced before Stripe signature processing", async () => {
  const f = await fixture();
  assert.equal((await fulfillStripeCheckoutWebhook(new Request("https://shop.test/webhooks/stripe", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }), f.env)).status, 413);
});

test("streamed Stripe webhook refuses oversize bytes before signature and durable receiving", async () => {
  const f = await fixture();
  const chunk = new Uint8Array(256 * 1024).fill(0x78);
  const body = new ReadableStream({ start(controller) {
    for (let n = 0; n < 5; n++) controller.enqueue(chunk);
    controller.close();
  } });
  const request = new Request("https://shop.test/webhooks/stripe", { method: "POST",
    body, duplex: "half" });
  const response = await fulfillStripeCheckoutWebhook(request, f.env);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "stripe-webhook-body-too-large" });
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
});

test("streamed Stripe webhook retains exact signed multibyte UTF-8 across chunks", async () => {
  const f = await fixture();
  const paid = event("checkout.session.async_payment_succeeded",
    { metadata: { offering_id: checkout.offeringId, request_digest: checkout.requestDigest, memo: "雪" } });
  const rawBody = JSON.stringify(paid);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const encoded = new TextEncoder().encode(rawBody), split = encoded.indexOf(0xe9) + 1;
  assert.ok(split > 0);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, split));
    controller.enqueue(encoded.slice(split));
    controller.close();
  } });
  const request = new Request("https://shop.test/webhooks/stripe", { method: "POST",
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
    body, duplex: "half" });
  const response = await fulfillStripeCheckoutWebhook(request, f.env);
  assert.equal(response.status, 200);
  assert.equal((await f.fulfillment.getEntitlement(checkout.sessionId)).status, "active");
});

test("malformed UTF-8 is not silently normalized into a valid signed Stripe event", async () => {
  const f = await fixture();
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([0xc3]));
    controller.close();
  } });
  const request = new Request("https://shop.test/webhooks/stripe", { method: "POST",
    body, duplex: "half" });
  const response = await fulfillStripeCheckoutWebhook(request, f.env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid-json" });
  assert.equal(await f.fulfillment.getEntitlement(checkout.sessionId), null);
});
