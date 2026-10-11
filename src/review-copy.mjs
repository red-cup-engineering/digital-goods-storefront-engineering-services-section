/**
 * Review copies: a free copy given to one reader before or after release so they can review it. Unlike a gift, it
 * is not the offering's paid release. It delivers one advance-reader rendition stamped for that grant
 * (`advance-reader-v1`, made by the ebook section). It may be given while the offering is coming soon, it expires
 * when the reading window closes, and the giver can withdraw it.
 *
 * The publisher stages the stamped EPUB and its pointer in the goods bucket under the grant:
 *   goods/<offeringId>/review-copies/<grant>/pointer.json
 *   { type: "ReviewCopyRelease", version: 1, offeringId, grant, release, rendition, bundle: { key, sha256, bytes, contentType, filename } }
 * and records the entitlement `{ kind: "review-copy", id: grant, release, artifactSha256, expiresAt, ... }`.
 * Delivery serves the bytes only while the entitlement stands, and only when the pointer, the entitlement and the
 * bytes agree on one digest.
 *
 * Web Crypto only, so it runs in a Worker.
 */

export const REVIEW_COPY_ID = /^review-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const REVIEW_COPY_RENDITION = "advance-reader-v1";
const OFFERING_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.epub$/u;
const EDITION = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u;

const unavailable = (reason) => new TypeError(`review-copy-unavailable: ${reason}`);
const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A review-copy id derived from the giver and the publisher's reference, so one invitation always names one grant. */
export async function referencedReviewCopyId(grantedBy, reference) {
  const digest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`review-copy\n${grantedBy}\n${reference}`)));
  return `review-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/** The pointer key a grant's stamped copy is staged under. */
export function reviewCopyPointerKey(offeringId, grant) {
  if (!OFFERING_ID.test(offeringId ?? "")) throw new TypeError("offering id must be a lowercase kebab-case slug");
  if (!REVIEW_COPY_ID.test(grant ?? "")) throw new TypeError("a review-copy id is review-<uuid>");
  return `goods/${offeringId}/review-copies/${grant}/pointer.json`;
}

/** Validate a review-copy pointer for one offering and grant. */
export function admitReviewCopyPointer(pointer, offeringId, grant) {
  const bundle = pointer?.bundle, prefix = `goods/${offeringId}/review-copies/${grant}/`;
  if (pointer?.type !== "ReviewCopyRelease" || pointer.version !== 1 || pointer.offeringId !== offeringId || pointer.grant !== grant) throw unavailable("the pointer does not name this offering and grant");
  if (pointer.rendition !== REVIEW_COPY_RENDITION || !EDITION.test(pointer.release ?? "")) throw unavailable("the pointer names no advance-reader rendition of an edition");
  if (typeof bundle?.key !== "string" || !bundle.key.startsWith(prefix) || bundle.key.endsWith("pointer.json")) throw unavailable("the copy is outside this grant's goods");
  if (!HEX_SHA256.test(bundle.sha256 ?? "") || !Number.isInteger(bundle.bytes) || bundle.bytes < 1) throw unavailable("the copy carries no digest or size");
  if (bundle.contentType !== "application/epub+zip" || !FILENAME.test(bundle.filename ?? "")) throw unavailable("the copy is not a named EPUB");
  return Object.freeze({ ...pointer, bundle: Object.freeze({ ...bundle }) });
}

/**
 * The pointer that stages one stamped copy: from the copy's AdvanceReaderRendition record (cell or content) and the
 * staged bytes' digest and size. Refuses an unstamped rendition and bytes the record does not name.
 */
export function stagedReviewCopyPointer(rendition, offeringId, { sha256, bytes }) {
  const record = rendition?.content ?? rendition;
  if (record?.type !== "AdvanceReaderRendition" || !record.grant) throw new TypeError("stage from a stamped AdvanceReaderRendition record; an unstamped rendition is not one reader's copy");
  if (sha256 !== record.artifactSha256) throw new TypeError(`the copy is ${sha256}, not the rendition's ${record.artifactSha256}`);
  return admitReviewCopyPointer({
    type: "ReviewCopyRelease", version: 1, offeringId, grant: record.grant,
    release: record.editionInputDigest, rendition: record.rendition, renditionRecord: rendition.id ?? null,
    bundle: { key: `goods/${offeringId}/review-copies/${record.grant}/${sha256}.epub`, sha256, bytes, contentType: "application/epub+zip", filename: `${offeringId}-review-copy.epub` },
  }, offeringId, record.grant);
}

/**
 * Validate the entitlement the publisher asks the fulfillment store to record.
 * @returns {object|null} the record to store, or null when the request is malformed
 */
export function reviewCopyEntitlement(body, accountOf) {
  const recipient = accountOf(body?.recipientEmail), giver = accountOf(body?.grantedBy);
  if (!REVIEW_COPY_ID.test(body?.id ?? "") || !recipient || !giver || !OFFERING_ID.test(body?.offeringId ?? "")) return null;
  if (!EDITION.test(body.release ?? "") || !HEX_SHA256.test(body.artifactSha256 ?? "") || Number.isNaN(Date.parse(body.expiresAt ?? ""))) return null;
  return {
    id: body.id, kind: "review-copy", offeringId: body.offeringId, release: body.release, rendition: REVIEW_COPY_RENDITION,
    artifactSha256: body.artifactSha256, expiresAt: new Date(body.expiresAt).toISOString(),
    account: recipient, recipientEmail: recipient, grantedBy: giver,
    note: typeof body.note === "string" ? body.note.slice(0, 1000) : "", status: "active", createdAt: body.createdAt ?? null,
  };
}

/** Whether a review copy can be delivered at `now`: active, not expired. */
export function reviewCopyStanding(entitlement, now = new Date()) {
  if (entitlement?.kind !== "review-copy") return Object.freeze({ deliverable: false, reason: "not-a-review-copy" });
  if (entitlement.status !== "active") return Object.freeze({ deliverable: false, reason: "withdrawn" });
  if (Date.parse(entitlement.expiresAt) <= now.getTime()) return Object.freeze({ deliverable: false, reason: "expired" });
  return Object.freeze({ deliverable: true, reason: null });
}

/**
 * Deliver a standing review copy, refusing bytes whose digest is not the one the entitlement and pointer name.
 * @param {object} entitlement the review-copy entitlement
 * @param {object} env the Worker env holding `goods` or `SHOP_GOODS`
 * @returns {Promise<Response>}
 */
export async function readReviewCopy(entitlement, env, now = new Date()) {
  const standing = reviewCopyStanding(entitlement, now);
  if (!standing.deliverable) throw unavailable(standing.reason);
  const store = env?.SHOP_GOODS ?? env?.goods;
  if (!store || typeof store.get !== "function") throw unavailable("no goods bucket is bound");
  const object = await store.get(reviewCopyPointerKey(entitlement.offeringId, entitlement.id));
  if (!object) throw unavailable("no copy is staged for this grant");
  const pointer = admitReviewCopyPointer(JSON.parse(await object.text()), entitlement.offeringId, entitlement.id);
  if (pointer.release !== entitlement.release || pointer.bundle.sha256 !== entitlement.artifactSha256) throw unavailable("the staged copy is not the one this grant names");
  const copy = await store.get(pointer.bundle.key);
  if (!copy) throw unavailable("the staged copy is missing");
  const bytes = new Uint8Array(await copy.arrayBuffer());
  if (bytes.byteLength !== pointer.bundle.bytes || hex(await crypto.subtle.digest("SHA-256", bytes)) !== pointer.bundle.sha256) throw unavailable("the staged copy does not match its digest");
  return new Response(bytes, {
    headers: {
      "content-type": pointer.bundle.contentType,
      "content-disposition": `attachment; filename="${pointer.bundle.filename}"`,
      "content-length": String(bytes.byteLength),
      "x-release": pointer.release,
      "cache-control": "private, no-store",
    },
  });
}
