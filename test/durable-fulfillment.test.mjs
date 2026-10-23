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

test("a pending Stripe completion is retained without delivering goods; a separately paid event delivers once", async () => {
  const { runtime, rows } = object();
  await call(runtime, "/checkout", checkout);
  const pending = { ...payment, eventId: "evt_pending", eventType: "checkout.session.completed", paymentStatus: "unpaid" };
  const first = await call(runtime, "/claim", pending);
  assert.deepEqual(await first.json(), { disposition: "pending" });
  assert.equal(rows.get("event:evt_pending")?.pending, true);
  assert.equal(rows.has("entitlement:cs_test"), false);

  const duplicate = await call(runtime, "/claim", pending);
  assert.deepEqual(await duplicate.json(), { disposition: "duplicate" });
  assert.equal((await call(runtime, "/claim", { ...pending, eventId: "evt_wrong_amount", amountTotal: 1 })).status, 409);
  assert.equal((await call(runtime, "/claim", { ...pending, eventId: "evt_invalid_async", eventType: "checkout.session.async_payment_succeeded" })).status, 409);
  assert.equal(rows.has("entitlement:cs_test"), false);

  const success = await call(runtime, "/claim", { ...payment, eventId: "evt_success", eventType: "checkout.session.async_payment_succeeded" });
  assert.deepEqual(await success.json(), { disposition: "claimed" });
  assert.equal(rows.get("entitlement:cs_test")?.status, "active");
  const late = await call(runtime, "/claim", { ...pending, eventId: "evt_late" });
  assert.deepEqual(await late.json(), { disposition: "pending" });
  assert.equal(rows.get("entitlement:cs_test")?.status, "active");
});



test('Stripe external event audit is append-only, distinguishes retries from conflicting money observations',async()=>{
 const {runtime,rows}=object();
 const id='urn:stripe-event-receipt:evt_source_observed_1';
 const first={
  category:'stripe-webhook-event-admission.events',
  recordedAt:'2026-10-22T12:00:00.000Z',
  record:{id,type:'StripeExternalPaymentLinkObservation',stripePaymentLinkId:'plink_verified',amountTotal:1000},
  told:{for:true,against:false}
 };
 const written=await call(runtime,'/audit',first);
 assert.deepEqual(await written.json(),{ok:true,duplicate:false});
 const key='audit:'+id,original=structuredClone(rows.get(key));
 assert.deepEqual(await (await call(runtime,'/audit',{...first,recordedAt:'2026-10-22T13:00:00.000Z'})).json(),
  {ok:true,duplicate:true});
 assert.deepEqual(rows.get(key),original,'retries cannot update original economic receipt timestamps');
 const conflict=await call(runtime,'/audit',{
  ...first,record:{...first.record,amountTotal:3000}
 });
 assert.equal(conflict.status,409);
 assert.deepEqual(await conflict.json(),{error:'receipt-identity-conflict'});
 assert.deepEqual(rows.get(key),original,'a changed same-ID payment observation cannot overwrite the first signed witness');
 const otherId=await call(runtime,'/audit',{
  ...first,record:{...first.record,id:'urn:stripe-event-receipt:evt_source_observed_2'}
 });
 assert.equal(otherId.status,200);
 assert.equal(rows.size,2);
});

test('Shop durable audit client provides receipt duplicate readback and refuses conflict',async()=>{
 const {runtime}=object(),store=createDurableFulfillment(namespace(runtime),'test');
 const first={category:'stripe-webhook-event-admission.events',
  record:{id:'urn:stripe-event-receipt:evt_stable_1',amountTotal:1000},
  recordedAt:'2026-10-22T12:00:00.000Z'
 };
 const original=await store.audit.record(first);
 assert.equal(original.duplicate,false);
 const repeated=await store.audit.record({...first,recordedAt:'2026-10-22T13:00:00.000Z'});
 assert.equal(repeated.duplicate,true);
 await assert.rejects(store.audit.record({...first,record:{...first.record,amountTotal:500}}),
  /could not record checkout receipt/u);
});



/** Independent durable-ACK oracle. HTTP 200 and ok:true are insufficient:
 * the original Worker must know whether an event was newly stored or replayed.
 * A malformed durable reply must not become duplicate:false by coercion. */
const malformedAuditDuplicateAcks=[
  ["missing",{}],
  ["null",{duplicate:null}],
  ["empty string",{duplicate:""}],
  ["string true",{duplicate:"true"}],
  ["string false",{duplicate:"false"}],
  ["string zero",{duplicate:"0"}],
  ["string one",{duplicate:"1"}],
  ["string yes",{duplicate:"yes"}],
  ["string no",{duplicate:"no"}],
  ["string new",{duplicate:"new"}],
  ["string duplicate",{duplicate:"duplicate"}],
  ["number zero",{duplicate:0}],
  ["number one",{duplicate:1}],
  ["number negative",{duplicate:-1}],
  ["number two",{duplicate:2}],
  ["fraction",{duplicate:0.5}],
  ["array empty",{duplicate:[]}],
  ["array true",{duplicate:[true]}],
  ["array false",{duplicate:[false]}],
  ["object empty",{duplicate:{}}],
  ["object value",{duplicate:{value:true}}],
  ["object duplicate true",{duplicate:{duplicate:true}}],
  ["object duplicate false",{duplicate:{duplicate:false}}],
  ["string fraction",{duplicate:"0.0"}],
  ["object status",{duplicate:{flag:"old"}}]
];
const auditedStripeEvent={category:"stripe-webhook-event-admission.events",
 record:{id:"urn:stripe-event-receipt:evt_durable_ack_1",type:"StripeExternalPaymentLinkObservation",
   stripePaymentLinkId:"plink_verified",amountTotal:1000,currency:"usd"},
 told:{for:true,against:false}
};
for(const [name, fields] of malformedAuditDuplicateAcks)
  test("a successful durable HTTP reply must not coerce an invalid duplicate ACK: "+name,async()=>{
    let calls=0;
    const namespace={idFromName(){return "offline";},get(){return {async fetch(url,init){
      calls++;
      assert.equal(new URL(url).pathname,"/audit");
      assert.deepEqual(JSON.parse(init.body),auditedStripeEvent);
      return Response.json({ok:true,...fields});
    }};}};
    const client=createDurableFulfillment(namespace,"offline");
    await assert.rejects(client.audit.record(auditedStripeEvent),/could not record checkout receipt/u);
    assert.equal(calls,1);
  });
for(const duplicate of [false,true])
  test("the original durable audit preserves an explicit Boolean duplicate disposition: "+duplicate,async()=>{
    let calls=0;
    const namespace={idFromName(){return "offline";},get(){return {async fetch(url,init){
      calls++;
      assert.equal(new URL(url).pathname,"/audit");
      assert.deepEqual(JSON.parse(init.body),auditedStripeEvent);
      return Response.json({ok:true,duplicate});
    }};}};
    const client=createDurableFulfillment(namespace,"offline");
    assert.deepEqual(await client.audit.record(auditedStripeEvent),{...auditedStripeEvent,duplicate});
    assert.equal(calls,1);
  });
