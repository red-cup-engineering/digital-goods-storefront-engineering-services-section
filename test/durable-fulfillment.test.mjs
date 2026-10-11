import assert from "node:assert/strict";
import test from "node:test";

import { createDurableFulfillment, DigitalGoodsFulfillment } from "../src/durable-fulfillment.mjs";

function object() {
  const rows = new Map();
  const storage = {
    async get(key) { return rows.get(key); },
    async put(key, value) { rows.set(key, value); },
    async transaction(work) { return work({ get: storage.get, put: storage.put }); },
  };
  return { runtime: new DigitalGoodsFulfillment({ storage }), rows };
}
async function call(runtime, path, value) {
  return runtime.fetch(new Request(`https://fulfillment${path}`, { method: "POST", body: JSON.stringify(value) }));
}
function namespace(runtime) {
  return {
    idFromName() { return "test"; },
    get() { return { fetch(input, init) { return runtime.fetch(input instanceof Request ? input : new Request(input, init)); } }; },
  };
}
const checkout = { sessionId: "cs_test", offeringId: "book", requestDigest: "digest", amountTotal: 1200, currency: "usd", stripeMode: "test", goods: [{ key: "book.epub", sha256: "a".repeat(64), contentType: "application/epub+zip", name: "Book", byteLength: 1 }] };
const payment = { eventId: "evt_1", sessionId: "cs_test", offeringId: "book", requestDigest: "digest", amountTotal: 1200, currency: "usd", stripeMode: "test", paymentStatus: "paid", status: "complete", paymentIntentId: "pi_test" };

test("durable fulfillment keeps checkout records immutable and binds payment inside one transaction", async () => {
  const { runtime } = object();
  assert.equal((await call(runtime, "/checkout", checkout)).status, 200);
  assert.equal((await call(runtime, "/checkout", { ...checkout, amountTotal: 1 })).status, 409);
  assert.equal((await call(runtime, "/claim", { ...payment, amountTotal: 1 })).status, 409);
  assert.equal((await call(runtime, "/claim", payment)).status, 200);
  const entitlement = await (await runtime.fetch(new Request("https://fulfillment/entitlement/cs_test"))).json();
  assert.deepEqual(entitlement.goods, checkout.goods);
});

test("a second event cannot reactivate a durably revoked entitlement", async () => {
  const { runtime } = object();
  await call(runtime, "/checkout", checkout); await call(runtime, "/claim", payment);
  assert.equal((await call(runtime, "/revoke", { sessionId: "cs_test", paymentIntentId: "pi_test", reason: "refund" })).status, 200);
  const second = await call(runtime, "/claim", { ...payment, eventId: "evt_2" });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).disposition, "duplicate-session");
  const entitlement = await (await runtime.fetch(new Request("https://fulfillment/entitlement/cs_test"))).json();
  assert.equal(entitlement.status, "revoked");
});

test("audit receipts require their nested Stripe receipt id", async () => {
  const { runtime, rows } = object();
  assert.equal((await call(runtime, "/audit", { record: { id: "urn:stripe-checkout-receipt:cs_test" } })).status, 200);
  assert.ok(rows.has("audit:urn:stripe-checkout-receipt:cs_test"));
  assert.equal((await call(runtime, "/audit", { category: "missing" })).status, 400);
});

test("client fails closed on JSON 503, an unknown disposition, and a failed transaction before a retry", async () => {
  const unavailable = createDurableFulfillment({ idFromName() { return "test"; }, get() { return { async fetch() { return Response.json({ error: "unavailable" }, { status: 503 }); } }; } }, "test");
  assert.equal((await unavailable.claimPayment(payment)).failed, true);
  const unknown = createDurableFulfillment({ idFromName() { return "test"; }, get() { return { async fetch() { return Response.json({ disposition: "unexpected" }); } }; } }, "test");
  assert.equal((await unknown.claimPayment(payment)).disposition, "unexpected");

  const { runtime } = object(); const client = createDurableFulfillment(namespace(runtime), "test");
  await client.recordCheckout(checkout);
  const transaction = runtime.ctx.storage.transaction; let fail = true;
  runtime.ctx.storage.transaction = async (work) => { if (fail) throw new Error("temporary storage failure"); return transaction(work); };
  assert.equal((await client.claimPayment(payment)).failed, true);
  fail = false;
  assert.equal((await client.claimPayment(payment)).disposition, "claimed");
});
