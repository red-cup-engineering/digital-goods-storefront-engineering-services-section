import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { createDigitalGoodsStorefrontWorker, createPublicShopCatalog } from "../src/worker-runtime.mjs";
import { issueDownloadToken } from "../src/digital-goods-storefront.mjs";
import { createDurableFulfillment, DigitalGoodsFulfillment } from "../src/durable-fulfillment.mjs";
import { referencedReviewCopyId, reviewCopyPointerKey } from "../src/review-copy.mjs";
import { createSessionCookie } from "@red-cup-engineering/computer-web-server/admission/session";

const bytes = new TextEncoder().encode("a small test epub");
const sha256 = "708be5f2e46eb82e55c1599ab7646872fd4bd4c19898d759020cbdd75602da7e";
const catalog = {
  merchant: { name: "Test Press", legalBody: "test-press" },
  offerings: [{ id: "test-book", title: "Test Book", line: "test-line", status: "test-only", priceCents: 1200, currency: "usd", goods: [{ name: "Test EPUB", key: "test-book.epub", contentType: "application/epub+zip", byteLength: bytes.byteLength, sha256 }] }],
};

function memoryFulfillment() {
  const checkouts = new Map(); const entitlements = new Map(); const events = new Set();
  return {
    async recordCheckout(value) { checkouts.set(value.sessionId, value); return { disposition: "registered" }; },
    async getCheckout(id) { return checkouts.get(id) ?? null; },
    async claimPayment(value) {
      if (events.has(value.eventId)) return "duplicate";
      const checkout = checkouts.get(value.sessionId);
      if (!checkout || value.paymentStatus !== "paid" || value.status !== "complete" || checkout.offeringId !== value.offeringId || checkout.requestDigest !== value.requestDigest || checkout.amountTotal !== value.amountTotal || checkout.currency !== value.currency || checkout.stripeMode !== value.stripeMode) return "rejected";
      events.add(value.eventId);
      if (entitlements.has(value.sessionId)) return "duplicate-session";
      entitlements.set(value.sessionId, { ...value, goods: checkout.goods, status: "active" });
      return "claimed";
    },
    async getEntitlement(id) { return entitlements.get(id) ?? null; },
    revoke(id) { const value = entitlements.get(id); entitlements.set(id, { ...value, status: "revoked" }); },
  };
}
function env(store, overrides = {}) {
  return {
    fulfillment: store,
    goods: { async get(key) { return key === "goods/test-book/test-book.epub" ? { async arrayBuffer() { return bytes.buffer.slice(0); } } : null; } },
    tokenSecret: "token-secret",
    audit: { query: () => [], async record(entry) { return entry; } },
    API_KEY_STRIPE: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_CUSTOMER_CONTRACT_TOKEN: "contract-test",
    ...overrides,
  };
}
function signature(body, secret) { const timestamp = Math.floor(Date.now() / 1000); return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`; }
function event(overrides = {}) {
  return { id: "evt_test", type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_test", amount_total: 1200, currency: "usd", payment_status: "paid", status: "complete", metadata: { offering_id: "test-book", request_digest: "digest" } } }, ...overrides };
}

test("mountable catalog follows catalog, offering, POST checkout, thanks, and download routes", async () => {
  const store = memoryFulfillment();
  const runtime = createDigitalGoodsStorefrontWorker({ catalog, origin: "https://bindinggenerations.net", buyerActor: "urn:ame:test-buyer", routes: { catalog: "/publications", goods: "/publications/", checkout: "/checkout/", thanks: "/thanks", download: "/download/" } });
  const listing = await runtime.fetch(new Request("https://bindinggenerations.net/publications"), env(store));
  assert.match(await listing.text(), /href="\/publications\/test-book"/);
  const offering = await runtime.fetch(new Request("https://bindinggenerations.net/publications/test-book"), env(store));
  const offeringHtml = await offering.text();
  assert.match(offeringHtml, /<form[^>]*action="\/checkout\/test-book"[^>]*method="post"|<form[^>]*method="post"[^>]*action="\/checkout\/test-book"/);
  assert.match(offeringHtml, /Buy — \$12\.00/);
  assert.match(offeringHtml, /href="\/publications"/);
  assert.doesNotMatch(offeringHtml, /<script(?! data-tufte-meta="structuredData")/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "cs_test", url: "https://checkout.stripe.test/session", amount_total: 1200, currency: "usd", payment_status: "unpaid", status: "open" }), { status: 200 });
  try {
    const refused = await runtime.fetch(new Request("https://bindinggenerations.net/checkout/test-book", { method: "POST", headers: { origin: "https://elsewhere.test" } }), env(store));
    assert.equal(refused.status, 403);
    const checkout = await runtime.fetch(new Request("https://bindinggenerations.net/checkout/test-book", { method: "POST", headers: { origin: "https://bindinggenerations.net" } }), env(store));
    assert.equal(checkout.status, 303);
  } finally { globalThis.fetch = originalFetch; }

  const issued = await store.getCheckout("cs_test");
  assert.ok(issued);
  const body = JSON.stringify(event({ data: { object: { ...event().data.object, metadata: { offering_id: "test-book", request_digest: issued.requestDigest } } } }));
  const receipt = await runtime.fetch(new Request("https://bindinggenerations.net/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": signature(body, "whsec_test") } }), env(store));
  assert.equal(receipt.status, 200);
  const thanks = await runtime.fetch(new Request("https://bindinggenerations.net/thanks?session_id=cs_test"), env(store));
  const token = (await thanks.text()).match(/\/download\/([^"]+)/u)?.[1];
  assert.ok(token);
  const download = await runtime.fetch(new Request(`https://bindinggenerations.net/download/${token}`), env(store));
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
});

test("webhooks refuse unpaid, unmatched, and unknown sessions without an entitlement", async () => {
  const store = memoryFulfillment(); const runtime = createDigitalGoodsStorefrontWorker({ catalog, origin: "https://bindinggenerations.net", buyerActor: "urn:ame:test-buyer" });
  await store.recordCheckout({ sessionId: "cs_test", offeringId: "test-book", requestDigest: "digest", amountTotal: 1200, currency: "usd", stripeMode: "test", goods: catalog.offerings[0].goods });
  for (const raw of [event({ data: { object: { ...event().data.object, payment_status: "unpaid" } } }), event({ data: { object: { ...event().data.object, amount_total: 1 } } }), event({ data: { object: { ...event().data.object, id: "cs_unknown" } } })]) {
    const body = JSON.stringify(raw);
    const response = await runtime.fetch(new Request("https://bindinggenerations.net/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": signature(body, "whsec_test") } }), env(store));
    assert.equal(response.status, 409);
  }
  assert.equal(await store.getEntitlement("cs_test"), null);
});

test("a duplicate webhook retains delivery, while revoked and tampered downloads fail", async () => {
  const store = memoryFulfillment(); const runtime = createDigitalGoodsStorefrontWorker({ catalog, origin: "https://bindinggenerations.net", buyerActor: "urn:ame:test-buyer" });
  await store.recordCheckout({ sessionId: "cs_test", offeringId: "test-book", requestDigest: "digest", amountTotal: 1200, currency: "usd", stripeMode: "test", goods: catalog.offerings[0].goods });
  const body = JSON.stringify(event()); const request = () => new Request("https://bindinggenerations.net/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": signature(body, "whsec_test") } });
  assert.equal((await runtime.fetch(request(), env(store))).status, 200);
  assert.equal((await runtime.fetch(request(), env(store))).status, 200);
  const token = await issueDownloadToken({ secret: "token-secret", offeringId: "test-book/test-book.epub", sessionId: "cs_test", expiresAt: Date.now() + 60_000 });
  const tampered = await runtime.fetch(new Request(`https://bindinggenerations.net/download/${token}`), env(store, { goods: { async get() { return { async arrayBuffer() { return new TextEncoder().encode("tampered").buffer; } }; } } }));
  assert.equal(tampered.status, 503);
  store.revoke("cs_test");
  assert.equal((await runtime.fetch(new Request(`https://bindinggenerations.net/download/${token}`), env(store))).status, 403);
});

test("webhook returns 503 for unavailable or unknown fulfillment outcomes and accepts a later retry", async () => {
  const store = memoryFulfillment(); const runtime = createDigitalGoodsStorefrontWorker({ catalog, origin: "https://bindinggenerations.net", buyerActor: "urn:ame:test-buyer" });
  await store.recordCheckout({ sessionId: "cs_test", offeringId: "test-book", requestDigest: "digest", amountTotal: 1200, currency: "usd", stripeMode: "test", goods: catalog.offerings[0].goods });
  const body = JSON.stringify(event()); const request = () => new Request("https://bindinggenerations.net/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": signature(body, "whsec_test") } });
  const unavailable = { ...store, async claimPayment() { return { failed: true }; } };
  const unknown = { ...store, async claimPayment() { return { disposition: "unexpected" }; } };
  assert.equal((await runtime.fetch(request(), env(store, { fulfillment: unavailable }))).status, 503);
  assert.equal((await runtime.fetch(request(), env(store, { fulfillment: unknown }))).status, 503);
  assert.equal((await runtime.fetch(request(), env(store))).status, 200);
});

test("webhook refuses a body larger than one MiB before signature parsing", async () => {
  const runtime = createDigitalGoodsStorefrontWorker({ catalog, origin: "https://bindinggenerations.net", buyerActor: "urn:ame:test-buyer" });
  const response = await runtime.fetch(new Request("https://bindinggenerations.net/webhooks/stripe", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }), env(memoryFulfillment()));
  assert.equal(response.status, 413);
});

// ---- accounts, gifts and the library, over the real durable fulfillment object ----

const release = new TextEncoder().encode("an accepted epub-and-pdf bundle");
const releaseSha256 = createHash("sha256").update(release).digest("hex");
const bookCatalog = {
  merchant: { name: "Test Press", legalBody: "test-press" },
  offerings: [
    { id: "field-guide", title: "Field Guide", line: "test-line", status: "live", priceCents: 900, currency: "usd", release: "field-guide", agentOfferUrl: "https://market.test/#field-guide", book: { contents: ["One", "Two"], edition: { record: "fixture/acceptance.json", digest: "ni:///sha-256;" + "a".repeat(43), files: [{ format: "EPUB", sha256: releaseSha256 }, { format: "PDF", sha256: releaseSha256 }] } } },
    { id: "tote", title: "Tote", line: "merch", status: "coming-soon" },
  ],
};
function releaseBucket() {
  const pointer = JSON.stringify({ type: "PaidRelease", version: 1, offeringId: "field-guide", release: bookCatalog.offerings[0].book.edition.digest, artifacts: { epub: releaseSha256, screenPdf: releaseSha256 }, bundle: { key: "goods/field-guide/bundle.zip", sha256: releaseSha256, bytes: release.byteLength, contentType: "application/zip", filename: "field-guide.zip" } });
  const objects = { "goods/field-guide/release.json": new TextEncoder().encode(pointer), "goods/field-guide/bundle.zip": release };
  const object = (bytes) => ({ size: bytes.byteLength, async text() { return new TextDecoder().decode(bytes); }, async arrayBuffer() { return bytes.slice().buffer; } });
  return { async get(key) { return objects[key] ? object(objects[key]) : null; }, async head(key) { return objects[key] ? object(objects[key]) : null; } };
}
function durableStore() {
  const rows = new Map();
  const storage = { async get(key) { return rows.get(key); }, async put(key, value) { rows.set(key, value); }, async transaction(work) { return work({ get: storage.get, put: storage.put }); } };
  const object = new DigitalGoodsFulfillment({ storage });
  return createDurableFulfillment({ idFromName: () => "test", get: () => ({ fetch: (input, init) => object.fetch(input instanceof Request ? input : new Request(input, init)) }) }, "test");
}
const accounts = { clientId: "client", clientSecret: "secret", sessionSecret: "session-secret" };
function readerEnv(store, overrides = {}) { return { fulfillment: store, goods: releaseBucket(), tokenSecret: "token-secret", audit: { async record(entry) { return entry; } }, accounts, gifters: ["Giver@Example.test"], ...overrides }; }
function signedIn(email) { return createSessionCookie({ name: "storefront_session", subject: `sub-${email}`, subjectHash: "h", email, secret: accounts.sessionSecret, now: Date.now }).split(";")[0]; }
const shop = () => createDigitalGoodsStorefrontWorker({ catalog: bookCatalog, origin: "https://shop.test", buyerActor: "urn:ame:test-buyer", storefront: { title: "Test Shop" } });
const as = (email, init = {}) => ({ ...init, headers: { ...(init.headers ?? {}), cookie: signedIn(email), ...(init.method === "POST" ? { origin: "https://shop.test" } : {}) } });

test("the catalog tells a reader card checkout is not open, offers x402, and shows sign-in only when it is configured", async () => {
  const store = durableStore();
  const closed = await (await shop().fetch(new Request("https://shop.test/goods/field-guide"), readerEnv(store, { accounts: {} }))).text();
  assert.match(closed, /Card checkout opens soon/);
  assert.match(closed, /href="https:\/\/market.test\/#field-guide"/);
  assert.match(closed, /Explore x402 offer/);
  assert.doesNotMatch(closed, /Buy with USDC over x402/);
  assert.doesNotMatch(closed, /Sign in/);
  assert.match(closed, /"@type":"Book"/);
  const open = await (await shop().fetch(new Request("https://shop.test/"), readerEnv(store))).text();
  assert.match(open, /href="\/oauth\/login\?return_to=%2F"/);
  const login = await shop().fetch(new Request("https://shop.test/oauth/login?return_to=/library"), readerEnv(store));
  assert.equal(login.status, 302);
  assert.match(login.headers.get("location"), /^https:\/\/accounts.google.com\/.*redirect_uri=https%3A%2F%2Fshop.test%2Foauth%2Fcallback/);
  assert.match(login.headers.get("set-cookie"), /storefront_sign_in=/);
});

test("a gifter gives a book by email; the link delivers the accepted bytes and the recipient's library keeps it", async () => {
  const store = durableStore();
  assert.equal((await shop().fetch(new Request("https://shop.test/gifts", as("someone@example.test")), readerEnv(store))).status, 403);
  const refused = await shop().fetch(new Request("https://shop.test/gifts", as("someone@example.test", { method: "POST", body: new URLSearchParams({ offering: "field-guide", email: "friend@example.test" }) })), readerEnv(store));
  assert.equal(refused.status, 403);
  const form = await (await shop().fetch(new Request("https://shop.test/gifts?offering=field-guide", as("giver@example.test")), readerEnv(store))).text();
  assert.match(form, /Give this book/);
  const given = await shop().fetch(new Request("https://shop.test/gifts", as("giver@example.test", { method: "POST", body: new URLSearchParams({ offering: "field-guide", email: "Friend@Example.test", note: "For your exam" }) })), readerEnv(store));
  assert.equal(given.status, 303);
  const link = given.headers.get("location");
  assert.match(link, /^\/gifts\/gift-[0-9a-f-]{36}$/);
  const claim = await (await shop().fetch(new Request(`https://shop.test${link}`), readerEnv(store))).text();
  assert.match(claim, /For your exam/);
  assert.match(claim, /addressed to friend@example.test/);
  const token = claim.match(/\/download\/([^"]+)/u)[1];
  const download = await shop().fetch(new Request(`https://shop.test/download/${token}`), readerEnv(store));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("x-release"), bookCatalog.offerings[0].book.edition.digest);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), release);
  const library = await (await shop().fetch(new Request("https://shop.test/library", as("friend@example.test")), readerEnv(store))).text();
  assert.match(library, /Field Guide/);
  assert.match(library, /A gift/);
  const listing = await (await shop().fetch(new Request("https://shop.test/", as("friend@example.test")), readerEnv(store))).text();
  assert.match(listing, /In your library/);
  const otherLibrary = await (await shop().fetch(new Request("https://shop.test/library", as("other@example.test")), readerEnv(store))).text();
  assert.doesNotMatch(otherLibrary, /Field Guide/);
  const id = link.split("/").pop();
  assert.equal((await shop().fetch(new Request(`https://shop.test/gifts/${id}/revoke`, as("someone@example.test", { method: "POST" })), readerEnv(store))).status, 404);
  assert.equal((await shop().fetch(new Request(`https://shop.test/gifts/${id}/revoke`, as("giver@example.test", { method: "POST" })), readerEnv(store))).status, 303);
  assert.equal((await shop().fetch(new Request(`https://shop.test${link}`), readerEnv(store))).status, 410);
  assert.equal((await shop().fetch(new Request(`https://shop.test/download/${token}`), readerEnv(store))).status, 403);
  assert.doesNotMatch(await (await shop().fetch(new Request("https://shop.test/library", as("friend@example.test")), readerEnv(store))).text(), /Field Guide/);
});

test("a house agent gives books through the gift API with its key; a reference names the same gift every time", async () => {
  const store = durableStore();
  const env = readerEnv(store, { giftAgent: { key: "agent-key", as: "Press@Example.test" } });
  const api = (path, init = {}, key = "agent-key") => shop().fetch(new Request(`https://shop.test/api/gifts${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } }), env);
  assert.equal((await api("", {}, "wrong")).status, 401);
  assert.equal((await shop().fetch(new Request("https://shop.test/api/gifts"), readerEnv(store))).status, 503);
  assert.deepEqual(await (await api("")).json(), { giftable: [{ id: "field-guide", title: "Field Guide" }] });
  assert.equal((await api("", { method: "POST", body: JSON.stringify({ offering: "tote", email: "r@example.test" }) })).status, 400);
  const ask = { method: "POST", body: JSON.stringify({ offering: "field-guide", email: "Reviewer@Example.test", note: "A review copy", reference: "campaign/reviewer" }) };
  const first = await api("", ask);
  assert.equal(first.status, 201);
  const given = await first.json();
  assert.match(given.url, /^https:\/\/shop.test\/gifts\/gift-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const again = await api("", ask);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ...given, disposition: "duplicate" });
  assert.equal((await api("", { method: "POST", body: JSON.stringify({
    offering: "field-guide", email: "other@example.test", reference: "campaign/reviewer",
  }) })).status, 409, "one reference cannot transfer a gift to another address");
  assert.match(await (await shop().fetch(new Request(given.url), env)).text(), /addressed to reviewer@example.test/);
  assert.equal((await (await api(`/${given.id}`)).json()).status, "active");
  assert.equal((await api(`/${given.id}/revoke`, { method: "POST", body: "{}" })).status, 200);
  assert.equal((await api("", ask)).status, 410, "retry cannot resurrect a withdrawn gift");
  assert.equal((await shop().fetch(new Request(given.url), env)).status, 410);
});

test("the publisher records a staged review copy through the review-copy API; its link serves the stamped bytes until it expires or is withdrawn", async () => {
  const store = durableStore();
  const edition = bookCatalog.offerings[0].book.edition.digest;
  const copy = new TextEncoder().encode("a stamped advance-reader epub");
  const copySha256 = createHash("sha256").update(copy).digest("hex");
  const staged = new Map();
  const stage = async (id) => {
    const key = `goods/field-guide/review-copies/${id}/${copySha256}.epub`;
    staged.set(reviewCopyPointerKey("field-guide", id), new TextEncoder().encode(JSON.stringify({ type: "ReviewCopyRelease", version: 1, offeringId: "field-guide", grant: id, release: edition, rendition: "advance-reader-v1", bundle: { key, sha256: copySha256, bytes: copy.byteLength, contentType: "application/epub+zip", filename: "field-guide-review-copy.epub" } })));
    staged.set(key, copy);
  };
  const release = releaseBucket();
  const object = (bytes) => ({ size: bytes.byteLength, async text() { return new TextDecoder().decode(bytes); }, async arrayBuffer() { return bytes.slice().buffer; } });
  const goods = { async get(key) { return staged.has(key) ? object(staged.get(key)) : release.get(key); }, async head(key) { return staged.has(key) ? object(staged.get(key)) : release.head(key); } };
  const env = readerEnv(store, { goods, giftAgent: { key: "agent-key", as: "Press@Example.test" } });
  const api = (path, init = {}, key = "agent-key") => shop().fetch(new Request(`https://shop.test/api/review-copies${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } }), env);
  const id = await referencedReviewCopyId("press@example.test", "field-guide/arc/0001");
  const ask = { id, offering: "field-guide", email: "Reviewer@Example.test", release: edition, artifactSha256: copySha256, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const post = (body) => api("", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await api("", { method: "POST", body: JSON.stringify(ask) }, "wrong")).status, 401);
  assert.equal((await post({ ...ask, release: "ni:///sha-256;" + "b".repeat(43) })).status, 400, "only a rendition of the accepted edition");
  assert.equal((await post(ask)).status, 409, "nothing is staged yet");
  await stage(id);
  assert.equal((await post({ ...ask, artifactSha256: "c".repeat(64) })).status, 409, "the staged bytes are not these");
  const first = await post(ask);
  assert.equal(first.status, 201);
  const given = await first.json();
  assert.equal(given.url, `https://shop.test/review-copies/${id}`);
  assert.equal((await post(ask)).status, 200);
  const claim = await (await shop().fetch(new Request(given.url), env)).text();
  assert.match(claim, /A review is welcome and never required\. If you post one, please say you received a free copy\./);
  assert.match(claim, /addressed to reviewer@example.test/);
  const token = claim.match(/\/download\/([^"]+)/u)[1];
  const download = await shop().fetch(new Request(`https://shop.test/download/${token}`), env);
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), copy);
  assert.match(await (await shop().fetch(new Request("https://shop.test/library", as("reviewer@example.test")), env)).text(), /A review copy given on/);
  assert.equal((await shop().fetch(new Request("https://shop.test/library/keep", as("other@example.test", { method: "POST", body: new URLSearchParams({ session_id: id }) })), env)).status, 404, "a review copy is not a purchase to keep");
  assert.equal((await (await api(`/${id}`)).json()).expiresAt, ask.expiresAt);

  const lapsed = await referencedReviewCopyId("press@example.test", "field-guide/arc/0002");
  await stage(lapsed);
  assert.equal((await post({ ...ask, id: lapsed, expiresAt: "2026-01-01T00:00:00Z" })).status, 201);
  assert.equal((await shop().fetch(new Request(`https://shop.test/review-copies/${lapsed}`), env)).status, 410);

  assert.equal((await api(`/${id}/revoke`, { method: "POST", body: "{}" })).status, 200);
  assert.equal((await shop().fetch(new Request(given.url), env)).status, 410);
  assert.equal((await shop().fetch(new Request(`https://shop.test/download/${token}`), env)).status, 403);
});

test("a signed-out library asks for sign-in, and a purchase kept from its receipt joins the reader's library once", async () => {
  const store = durableStore();
  const library = await shop().fetch(new Request("https://shop.test/library"), readerEnv(store));
  assert.equal(library.status, 303);
  assert.match(library.headers.get("location"), /^\/oauth\/login\?return_to=%2Flibrary$/);
  await store.recordCheckout({ sessionId: "cs_kept", offeringId: "field-guide", requestDigest: "d", amountTotal: 900, currency: "usd", stripeMode: "test", release: "field-guide", account: null });
  await store.claimPayment({ eventId: "evt_kept", sessionId: "cs_kept", offeringId: "field-guide", requestDigest: "d", amountTotal: 900, currency: "usd", stripeMode: "test", paymentStatus: "paid", status: "complete" });
  const thanks = await (await shop().fetch(new Request("https://shop.test/thanks?session_id=cs_kept", as("buyer@example.test")), readerEnv(store))).text();
  assert.match(thanks, /Keep it in your library/);
  const kept = await shop().fetch(new Request("https://shop.test/library/keep", as("buyer@example.test", { method: "POST", body: new URLSearchParams({ session_id: "cs_kept" }) })), readerEnv(store));
  assert.equal(kept.status, 303);
  assert.match(await (await shop().fetch(new Request("https://shop.test/library", as("buyer@example.test")), readerEnv(store))).text(), /Bought/);
  const stolen = await shop().fetch(new Request("https://shop.test/library/keep", as("thief@example.test", { method: "POST", body: new URLSearchParams({ session_id: "cs_kept" }) })), readerEnv(store));
  assert.equal(stolen.status, 409);
});

test("a separate tenant serves public machine-readable Shop goods without private accounts", async () => {
  const privateCatalog = {merchant:{name:"Tenant",legalBody:"LLC",bankToken:"secret"},offerings:[{
    id:"product",title:"Product",line:"Income:Private",status:"live",priceCents:100,currency:"usd",
    release:"product",goods:[{name:"File",key:"internal/file",byteLength:4,
      contentType:"application/octet-stream",sha256:"b".repeat(64)}],
  }]};
  const runtime = createDigitalGoodsStorefrontWorker({catalog:privateCatalog,
    origin:"https://tenant.example",buyerActor:"urn:ame:tenant"});
  const result = await runtime.fetch(new Request("https://tenant.example/catalog.json"),{});
  assert.equal(result.status,200);
  assert.match(result.headers.get("content-type"),/application\\/json/u);
  assert.equal(result.headers.get("cache-control"),"public, max-age=60");
  const body = await result.json();
    assert.equal(result.headers.get("access-control-allow-origin"),"*");
  assert.equal(body.merchant.name,"Tenant");
  assert.equal(body.offerings[0].goods[0].sha256,"b".repeat(64));
  assert.ok(!/bankToken|Income:Private|internal\\/|"key"/u.test(JSON.stringify(body)));
});

test("human Shop and public agent catalog share sellable-first selection with honest checkout readiness", async () => {
  const seller = {
    merchant: { name: "Seller", legalBody: "seller", privateKey: "keep-private" },
    offerings: [
      { id: "future", title: "Future Book", line: "education", status: "coming-soon" },
      { id: "live-one", title: "Live One", line: "education", status: "live",
        priceCents: 300, currency: "usd", release: "live-one" },
      { id: "external", title: "Outside Seller", line: "outside",
        status: "external", externalUrl: "https://seller.example/offer" },
      { id: "live-two", title: "Live Two", line: "education", status: "live",
        priceCents: 500, currency: "usd", release: "live-two" },
      { id: "preview", title: "Preview", line: "education", status: "test-only",
        priceCents: 100, currency: "usd", release: "preview" },
    ],
  };
  const sourceOrder = seller.offerings.map(({ id }) => id);
  const runtime = createDigitalGoodsStorefrontWorker({ catalog: seller,
    origin: "https://seller.example", buyerActor: "urn:ame:seller" });
  const store = memoryFulfillment();
  const full = env(store);
  const ready = await (await runtime.fetch(new Request("https://seller.example/catalog.json"), full)).json();
  assert.deepEqual(ready.offerings.map(({ id }) => id),
    ["live-one", "live-two", "external", "preview", "future"]);
  assert.deepEqual(ready.offerings.filter(({ buyable }) => buyable).map(({ id }) => id),
    ["live-one", "live-two", "preview"]);
  const home = await (await runtime.fetch(new Request("https://seller.example/"), full)).text();
  assert.ok(home.indexOf('href="/goods/live-one"') >= 0);
  assert.ok(home.indexOf('href="/goods/future"') > home.indexOf('href="/goods/live-one"'));

  const offline = env(store, { STRIPE_CUSTOMER_CONTRACT_TOKEN: undefined });
  const closed = await (await runtime.fetch(new Request("https://seller.example/catalog.json"), offline)).json();
  assert.deepEqual(closed.offerings.map(({ id }) => id),
    ["external", "live-one", "live-two", "preview", "future"]);
  assert.equal(closed.offerings.some(({ buyable }) => buyable), false);
  assert.equal(closed.offerings.find(({ id }) => id === "future").status, "coming-soon");
  assert.ok(!JSON.stringify(closed).includes("keep-private"));
  const closedHome = await (await runtime.fetch(new Request("https://seller.example/"), offline)).text();
  assert.ok(closedHome.indexOf('href="/goods/external"') >= 0);
  assert.ok(closedHome.indexOf('href="/goods/live-one"') > closedHome.indexOf('href="/goods/external"'));
  assert.deepEqual(seller.offerings.map(({ id }) => id), sourceOrder);
});

test("generic Shop catalog serves browser Bazaar readers while refusing write methods", async () => {
  const original = { merchant:{name:"Seller",legalBody:"seller",privateKey:"internal"},
    offerings:[{id:"sku",title:"SKU",line:"Income:Private",status:"live",priceCents:250,
      currency:"usd",release:"sku"}] };
  const route = createPublicShopCatalog(original);
  const resource = "https://seller.example/catalog.json";
  const get = route.fetch(new Request(resource,{method:"GET"}));
  assert.equal(get.status,200);
  assert.equal(get.headers.get("access-control-allow-origin"),"*");
  assert.deepEqual(await get.json(),route.readout);
  assert.equal(JSON.stringify(route.readout).includes("Income:Private"),false);
  const head = route.fetch(new Request(resource,{method:"HEAD"}));
  assert.equal(head.status,200);
  assert.equal(await head.text(),"");
  const preflight = route.fetch(new Request(resource,{method:"OPTIONS"}));
  assert.equal(preflight.status,204);
  assert.match(preflight.headers.get("access-control-allow-methods"),/GET/u);
  const denied = route.fetch(new Request(resource,{method:"POST"}));
  assert.equal(denied.status,405);
  assert.equal(denied.headers.get("allow"),"GET, HEAD, OPTIONS");
  assert.equal(original.offerings[0].line,"Income:Private");
});

test("merchant release state and checkout readiness remain separate in agent-facing public catalog", async () => {
  const seller = {
    merchant: { name: "Independent Shop", legalBody: "independent", privateKey: "not-public" },
    offerings: [{ id: "ready-good", title: "Ready Good", line: "Income:Private",
      status: "live", priceCents: 250, currency: "usd", release: "ready-good" }],
  };
  assert.throws(() => createPublicShopCatalog(seller, { checkoutArmed: "yes" }), TypeError);
  const unreadied = createPublicShopCatalog(seller);
  const ready = createPublicShopCatalog(seller, { checkoutArmed: true });
  assert.equal(unreadied.readout.offerings[0].status, "live");
  assert.equal(unreadied.readout.offerings[0].buyable, false);
  assert.equal(ready.readout.offerings[0].status, "live");
  assert.equal(ready.readout.offerings[0].buyable, true);
  assert.equal(ready.readout.offerings[0].release, "ready-good");
  assert.equal(JSON.stringify(ready.readout).includes("Income:Private"), false);
  assert.equal(JSON.stringify(ready.readout).includes("not-public"), false);
  const unavailable = createPublicShopCatalog({
    ...seller, offerings: seller.offerings.map((entry) => ({ ...entry, status: "coming-soon" })),
  }, { checkoutArmed: true });
  assert.equal(unavailable.readout.offerings[0].status, "coming-soon");
  assert.equal(unavailable.readout.offerings[0].buyable, false);
});

test("generic Shop fetch responds to current actual card bindings without changing publication status", async () => {
  const store = memoryFulfillment();
  const runtime = createDigitalGoodsStorefrontWorker({
    catalog, origin: "https://bindinggenerations.net", buyerActor: "urn:ame:test-buyer",
  });
  const url = "https://bindinggenerations.net/catalog.json";
  const usable = await runtime.fetch(new Request(url), env(store));
  assert.equal(usable.status, 200);
  assert.equal(usable.headers.get("access-control-allow-origin"), "*");
  const enabled = await usable.json();
  assert.equal(enabled.offerings[0].status, "test-only");
  assert.equal(enabled.offerings[0].buyable, true);

  const disabled = await (await runtime.fetch(new Request(url), env(store, {
    STRIPE_CUSTOMER_CONTRACT_TOKEN: undefined,
  }))).json();
  assert.equal(disabled.offerings[0].status, "test-only");
  assert.equal(disabled.offerings[0].buyable, false);
  const restored = await (await runtime.fetch(new Request(url), env(store))).json();
  assert.equal(restored.offerings[0].buyable, true, "the previous unarmed request cannot poison the shared cache");
  assert.equal(await (await runtime.fetch(new Request(url, { method: "HEAD" }), env(store))).text(), "");
  assert.equal((await runtime.fetch(new Request(url, { method: "POST" }), env(store))).status, 405);
});


test('mountable Shop exposes the shared MCP without creating another merchant catalog', async () => {
  const store = memoryFulfillment();
  const runtime = createDigitalGoodsStorefrontWorker({
    catalog, origin: 'https://bindinggenerations.net', buyerActor: 'urn:ame:test-buyer',
    routes: { goods: '/publications/' },
  });
  const shopUrl = 'https://bindinggenerations.net';
  const publicData = await (await runtime.fetch(new Request(shopUrl + '/catalog.json'), env(store))).json();
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_product', arguments: { id: 'test-book' } } };
  const call = await runtime.fetch(new Request(shopUrl + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  }), env(store));
  assert.equal(call.status, 200);
  const product = (await call.json()).result.structuredContent;
  assert.equal(product.id, publicData.offerings[0].id);
  assert.equal(product.buyable, publicData.offerings[0].buyable);
  assert.equal(product.url, shopUrl + '/publications/test-book');
  assert.equal(product.goods[0].sha256, publicData.offerings[0].goods[0].sha256);
  assert.equal(Object.hasOwn(product.goods[0], 'key'), false);
  assert.equal((await runtime.fetch(new Request(shopUrl + '/mcp'), env(store))).status, 405);
});
