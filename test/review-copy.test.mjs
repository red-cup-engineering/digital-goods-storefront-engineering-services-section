import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { DigitalGoodsFulfillment } from "../src/durable-fulfillment.mjs";
import { readReviewCopy, referencedReviewCopyId, reviewCopyPointerKey, reviewCopyStanding } from "../src/review-copy.mjs";

const edition = `ni:///sha-256;${"A".repeat(43)}`;
const copy = new TextEncoder().encode("stamped epub bytes");
const digest = createHash("sha256").update(copy).digest("hex");

function goods(rows) {
  return { async get(key) { const value = rows.get(key); return value === undefined ? null : { async text() { return typeof value === "string" ? value : new TextDecoder().decode(value); }, async arrayBuffer() { return typeof value === "string" ? new TextEncoder().encode(value).buffer : value.buffer; } }; } };
}
function fulfillment() {
  const rows = new Map();
  const storage = { async get(key) { return rows.get(key); }, async put(key, value) { rows.set(key, value); }, async transaction(work) { return work({ get: storage.get, put: storage.put }); } };
  return { runtime: new DigitalGoodsFulfillment({ storage }), rows };
}
const post = (runtime, path, value) => runtime.fetch(new Request(`https://fulfillment${path}`, { method: "POST", body: JSON.stringify(value) }));

test("one invitation names one review copy; the store records it with its digest and expiry, and lists it for reader and giver", async () => {
  const id = await referencedReviewCopyId("press@561.group", "ice-out/arc/0001");
  assert.equal(id, await referencedReviewCopyId("press@561.group", "ice-out/arc/0001"));
  assert.notEqual(id, await referencedReviewCopyId("press@561.group", "ice-out/arc/0002"));
  const { runtime, rows } = fulfillment();
  const grant = { kind: "review-copy", id, offeringId: "ice-out", release: edition, artifactSha256: digest, expiresAt: "2026-11-01T00:00:00Z", recipientEmail: "Reader@Example.com", grantedBy: "press@561.group", createdAt: "2026-10-06T00:00:00Z" };
  assert.equal((await post(runtime, "/grant", grant)).status, 200);
  assert.equal((await (await post(runtime, "/grant", grant)).json()).disposition, "duplicate");
  assert.equal(rows.get(`entitlement:${id}`).kind, "review-copy");
  assert.deepEqual(rows.get("account:reader@example.com"), [id]);
  assert.deepEqual(rows.get("grants:press@561.group"), [id]);
  assert.equal((await post(runtime, "/grant", { ...grant, artifactSha256: "nope" })).status, 400);
  assert.equal((await post(runtime, "/grant", { ...grant, id: "gift-not-a-review" })).status, 400);
});

test("a review copy is delivered only while it stands and only as the bytes its grant names", async () => {
  const id = await referencedReviewCopyId("press@561.group", "r1");
  const entitlement = { kind: "review-copy", id, offeringId: "ice-out", release: edition, artifactSha256: digest, expiresAt: "2026-11-01T00:00:00.000Z", status: "active" };
  const key = `goods/ice-out/review-copies/${id}/${digest}.epub`;
  const pointer = { type: "ReviewCopyRelease", version: 1, offeringId: "ice-out", grant: id, release: edition, rendition: "advance-reader-v1", bundle: { key, sha256: digest, bytes: copy.byteLength, contentType: "application/epub+zip", filename: "ice-out-review-copy.epub" } };
  const env = { goods: goods(new Map([[reviewCopyPointerKey("ice-out", id), JSON.stringify(pointer)], [key, copy]])) };
  const response = await readReviewCopy(entitlement, env, new Date("2026-10-10T00:00:00Z"));
  assert.equal(new TextDecoder().decode(await response.arrayBuffer()), "stamped epub bytes");
  assert.equal(response.headers.get("x-release"), edition);
  await assert.rejects(readReviewCopy(entitlement, env, new Date("2026-11-01T00:00:00Z")), /expired/u);
  await assert.rejects(readReviewCopy({ ...entitlement, status: "revoked" }, env, new Date("2026-10-10T00:00:00Z")), /withdrawn/u);
  await assert.rejects(readReviewCopy({ ...entitlement, artifactSha256: "b".repeat(64) }, env, new Date("2026-10-10T00:00:00Z")), /not the one this grant names/u);
  const tampered = { goods: goods(new Map([[reviewCopyPointerKey("ice-out", id), JSON.stringify(pointer)], [key, new TextEncoder().encode("other bytes, same len")]])) };
  await assert.rejects(readReviewCopy(entitlement, tampered, new Date("2026-10-10T00:00:00Z")), /does not match/u);
  assert.equal(reviewCopyStanding({ kind: "gift", status: "active" }).reason, "not-a-review-copy");
});
