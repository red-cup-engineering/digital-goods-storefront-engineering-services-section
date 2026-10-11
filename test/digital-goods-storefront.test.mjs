import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogModel,
  issueDownloadToken,
  receiptFor,
  stripeOfferingFor,
  validateCatalog,
  verifyDownloadToken,
} from "../src/digital-goods-storefront.mjs";
import { displayPrice, storefrontItemFor, structuredDataFor } from "../src/storefront-presentation.mjs";
import { renderTufteDocument } from "@red-cup-engineering/web-page-tiling-engine/rendering";
import { storefrontCatalogModel, storefrontDetailModel } from "@red-cup-engineering/web-page-tiling-engine/storefront";

const GOOD = { name: "EPUB", key: "handbook.epub", contentType: "application/epub+zip", byteLength: 1024, sha256: "a".repeat(64) };

function liveOffering(overrides = {}) {
  return {
    id: "agent-operators-handbook",
    title: "The Agent Operator's Handbook",
    blurb: "A field guide.",
    line: "artificial-intelligence-education-curriculum-services-section",
    status: "live",
    priceCents: 2900,
    currency: "usd",
    goods: [GOOD],
    ...overrides,
  };
}

function catalogOf(...offerings) {
  return { merchant: { name: "561 Group", legalBody: "emsenn" }, offerings };
}

// --- validateCatalog -------------------------------------------------------

test("validateCatalog admits a well-formed live offering", () => {
  const result = validateCatalog(catalogOf(liveOffering()));
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateCatalog rejects a non-object catalog", () => {
  assert.equal(validateCatalog(null).valid, false);
  assert.equal(validateCatalog("nope").valid, false);
});

test("validateCatalog requires offerings to be an array", () => {
  const result = validateCatalog({ merchant: {}, offerings: "nope" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "offerings"));
});

test("validateCatalog rejects a non-kebab-case id", () => {
  const result = validateCatalog(catalogOf(liveOffering({ id: "Not_Kebab" })));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /kebab-case/.test(e.message)));
});

test("validateCatalog rejects duplicate ids", () => {
  const result = validateCatalog(catalogOf(liveOffering(), liveOffering()));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /duplicate offering id/.test(e.message)));
});

test("validateCatalog rejects an unknown status", () => {
  const result = validateCatalog(catalogOf(liveOffering({ status: "on-sale" })));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /status must be one of/.test(e.message)));
});

test("live/test-only offerings require priceCents > 0", () => {
  const result = validateCatalog(catalogOf(liveOffering({ priceCents: 0 })));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /priceCents/.test(e.message)));
});

test("live/test-only offerings require goods, a release or externalUrl", () => {
  const result = validateCatalog(catalogOf(liveOffering({ goods: [] })));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /goods, release or externalUrl/.test(e.message)));
});

test("a live offering may deliver a paid release instead of listed goods, named by a kebab-case id", () => {
  assert.equal(validateCatalog(catalogOf(liveOffering({ goods: undefined, release: "agent-operators-handbook" }))).valid, true);
  assert.equal(validateCatalog(catalogOf(liveOffering({ goods: undefined, release: "Not A Slug" }))).valid, false);
});

test("live/test-only offering is admitted via externalUrl instead of goods", () => {
  const result = validateCatalog(catalogOf(liveOffering({ goods: [], externalUrl: "https://example.test/x" })));
  assert.equal(result.valid, true);
});

test("test-only offering follows the same rules as live", () => {
  const result = validateCatalog(catalogOf(liveOffering({ status: "test-only" })));
  assert.equal(result.valid, true);
});

test("external offering requires externalUrl", () => {
  const withUrl = validateCatalog(catalogOf(liveOffering({ status: "external", priceCents: undefined, currency: undefined, goods: [], externalUrl: "https://gumroad.com/l/x" })));
  assert.equal(withUrl.valid, true);
  const withoutUrl = validateCatalog(catalogOf(liveOffering({ status: "external", priceCents: undefined, currency: undefined, goods: [], externalUrl: undefined })));
  assert.equal(withoutUrl.valid, false);
  assert.ok(withoutUrl.errors.some((e) => /externalUrl/.test(e.message)));
});

test("coming-soon offering requires neither priceCents nor goods/externalUrl", () => {
  const result = validateCatalog(catalogOf({ id: "next-book", title: "Next Book", line: "some-line", status: "coming-soon" }));
  assert.equal(result.valid, true);
});

test("validateCatalog rejects a malformed good", () => {
  const result = validateCatalog(catalogOf(liveOffering({ goods: [{ name: "EPUB" }] })));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /sha256/.test(e.message)));
  assert.ok(result.errors.some((e) => /byteLength/.test(e.message)));
});

// --- catalogModel ------------------------------------------------------------

test("catalogModel marks a live offering buyable only when checkout is armed", () => {
  const catalog = catalogOf(liveOffering());
  const unarmed = catalogModel(catalog, { checkoutArmed: false });
  assert.equal(unarmed.offerings[0].buyable, false);
  assert.equal(unarmed.offerings[0].state, "checkout not yet armed");
  const armed = catalogModel(catalog, { checkoutArmed: true });
  assert.equal(armed.offerings[0].buyable, true);
  assert.equal(armed.offerings[0].state, "buy");
});

test("catalogModel state for coming-soon and external ignores checkoutArmed", () => {
  const catalog = catalogOf(
    { id: "next-book", title: "Next Book", line: "l", status: "coming-soon" },
    liveOffering({ id: "elsewhere", status: "external", priceCents: undefined, currency: undefined, goods: [], externalUrl: "https://gumroad.com/l/x" }),
  );
  const model = catalogModel(catalog, { checkoutArmed: true });
  assert.equal(model.offerings[0].state, "coming soon");
  assert.equal(model.offerings[0].buyable, false);
  assert.equal(model.offerings[1].state, "sold at gumroad.com");
  assert.equal(model.offerings[1].buyable, false);
});

test("catalogModel default checkoutArmed is false", () => {
  const model = catalogModel(catalogOf(liveOffering()));
  assert.equal(model.offerings[0].buyable, false);
});

// --- rendering -----------------------------------------------------------

test("displayPrice renders cents as a reader-facing price", () => {
  assert.equal(displayPrice(2900, "usd"), "$29.00");
});

const BOOK = {
  author: "561 Group", series: { name: "Study Companions", number: 3 },
  contents: ["About this book", "Foundations", "Glossary"],
  edition: { digest: "ni:///sha-256;abc", acceptedAt: "2026-09-27T22:34:03Z", proof: { errors: 3, corrections: 11, notes: 2 },
    files: [{ format: "EPUB", bytes: 146742, sha256: "b".repeat(64) }, { format: "PDF", bytes: 243599, sha256: "c".repeat(64) }] },
};

test("a book is presented through TUFTE with its facts, contents and verification record, escaped", () => {
  const model = catalogModel(catalogOf(liveOffering({ title: "<script>alert(1)</script>", goods: undefined, release: "agent-operators-handbook", book: BOOK })), { checkoutArmed: false });
  const item = storefrontItemFor(model.offerings[0], { cover: "/covers/agent-operators-handbook.png", actions: [{ kind: "unavailable", label: "Card checkout opens soon" }] });
  const storefront = { title: "Shop", items: [item] };
  const listing = renderTufteDocument(storefrontCatalogModel(storefront, { itemHref: (id) => `/goods/${id}` }));
  assert.doesNotMatch(listing, /<script>alert/);
  assert.match(listing, /\$29\.00/);
  assert.match(listing, /EPUB and PDF/);
  assert.match(listing, /Study Companions · 3/);
  assert.match(listing, /src="\/covers\/agent-operators-handbook.png"/);
  const detail = renderTufteDocument(storefrontDetailModel(storefront, "agent-operators-handbook"));
  assert.match(detail, /<li>Foundations<\/li>/);
  assert.match(detail, /reported 3 errors, 11 corrections and 2 notes/);
  assert.match(detail, new RegExp(`EPUB SHA-256</dt><dd><code>${"b".repeat(64)}</code>`));
  assert.match(detail, /Card checkout opens soon/);
});

test("structured data describes a book, its series and its offer", () => {
  const [offering] = catalogModel(catalogOf(liveOffering({ goods: undefined, release: "agent-operators-handbook", book: BOOK })), { checkoutArmed: true }).offerings;
  const data = structuredDataFor(offering, { origin: "https://shop.test", href: "/goods/agent-operators-handbook", image: "/covers/a.png" });
  assert.equal(data["@type"], "Book");
  assert.equal(data.image, "https://shop.test/covers/a.png");
  assert.deepEqual(data.offers, { "@type": "Offer", price: "29.00", priceCurrency: "USD", url: "https://shop.test/goods/agent-operators-handbook", availability: "https://schema.org/InStock" });
  assert.equal(data.isPartOf.name, "Study Companions");
});

// --- stripeOfferingFor -----------------------------------------------------

test("stripeOfferingFor projects the catalog offering into the stripe-services-section shape", () => {
  const projected = stripeOfferingFor(liveOffering());
  assert.deepEqual(projected, {
    id: "agent-operators-handbook",
    status: "live",
    mode: "payment",
    currency: "usd",
    unitAmount: 2900,
    name: "The Agent Operator's Handbook",
    description: "A field guide.",
    quantity: { minimum: 1, maximum: 1 },
    beneficiarySettlement: "artificial-intelligence-education-curriculum-services-section",
  });
});

test("stripeOfferingFor maps any non-live status to test-only", () => {
  assert.equal(stripeOfferingFor(liveOffering({ status: "test-only" })).status, "test-only");
});

// --- download tokens -------------------------------------------------------

test("issueDownloadToken / verifyDownloadToken round-trip", async () => {
  const secret = "test-secret";
  const now = Date.parse("2026-09-02T00:00:00Z");
  const token = await issueDownloadToken({ secret, offeringId: "agent-operators-handbook", sessionId: "cs_test_1", expiresAt: now + 3600_000 });
  const result = await verifyDownloadToken({ secret, token, now: now + 1000 });
  assert.equal(result.valid, true);
  assert.equal(result.offeringId, "agent-operators-handbook");
  assert.equal(result.sessionId, "cs_test_1");
});

test("verifyDownloadToken rejects an expired token", async () => {
  const secret = "test-secret";
  const now = Date.parse("2026-09-02T00:00:00Z");
  const token = await issueDownloadToken({ secret, offeringId: "x", sessionId: "y", expiresAt: now });
  const result = await verifyDownloadToken({ secret, token, now: now + 1 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "expired");
});

test("verifyDownloadToken rejects a tampered payload", async () => {
  const secret = "test-secret";
  const now = Date.parse("2026-09-02T00:00:00Z");
  const token = await issueDownloadToken({ secret, offeringId: "x", sessionId: "y", expiresAt: now + 3600_000 });
  const [payloadPart, signaturePart] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ offeringId: "z", sessionId: "y", expiresAt: now + 3600_000 })).toString("base64url");
  const tampered = `${tamperedPayload}.${signaturePart}`;
  assert.notEqual(tampered, token);
  const result = await verifyDownloadToken({ secret, token: tampered, now });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid-signature");
});

test("verifyDownloadToken rejects the wrong secret", async () => {
  const now = Date.parse("2026-09-02T00:00:00Z");
  const token = await issueDownloadToken({ secret: "right-secret", offeringId: "x", sessionId: "y", expiresAt: now + 3600_000 });
  const result = await verifyDownloadToken({ secret: "wrong-secret", token, now });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid-signature");
});

test("verifyDownloadToken rejects a malformed token", async () => {
  const result = await verifyDownloadToken({ secret: "s", token: "not-a-valid-token", now: 0 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "malformed-token");
});

test("issueDownloadToken throws without a secret", async () => {
  await assert.rejects(() => issueDownloadToken({ secret: "", offeringId: "x", sessionId: "y", expiresAt: 0 }));
});

// --- receiptFor --------------------------------------------------------------

test("receiptFor shapes a plain-JSON receipt with no buyer personal data", () => {
  const receipt = receiptFor({ session: { id: "cs_test_1", mode: "payment" }, offering: liveOffering(), now: new Date("2026-09-02T00:00:00Z") });
  assert.equal(receipt.type, "DigitalGoodsReceipt");
  assert.equal(receipt.sessionId, "cs_test_1");
  assert.equal(receipt.offeringId, "agent-operators-handbook");
  assert.equal(receipt.priceCents, 2900);
  assert.equal(receipt.goods.length, 1);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /email/i);
  assert.doesNotMatch(serialized, /card/i);
});
