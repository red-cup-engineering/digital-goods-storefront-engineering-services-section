/**
 * Delivery of a paid release: one immutable bundle of a good (an ebook
 * edition's EPUB and PDF, say), named by a release pointer the seller stages
 * beside it in the goods bucket. It is the delivery half of any paid rail. An
 * x402 offer binds `readPaidRelease` as its compute and `admitPaidRelease` as
 * its validation, passing its own `operation` as the offering id; a card
 * checkout can serve the same pointer after its entitlement is verified.
 *
 * The pointer lives at `goods/<offeringId>/release.json`:
 *   { type: "PaidRelease", version: 1, offeringId, release, bundle: { key, sha256, bytes, contentType, filename } }
 * `release` names the edition (its edition-input digest), `bundle.sha256` is
 * the hex SHA-256 of the bundle's bytes, and delivery refuses bytes that do
 * not match it, so a buyer receives exactly the version the pointer names.
 * Replacing an edition stages a new bundle and a new pointer; past buyers'
 * agent receipts keep naming the response they paid for. Human libraries follow
 * the book's update channel; their checkout also records the admitted release.
 *
 * Web Crypto only, so it runs in a Worker; the bucket is `env.SHOP_GOODS` (the
 * market's binding) or `env.goods` (the storefront's).
 */

const OFFERING_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const unavailable = (reason) => new TypeError(`paid-release-unavailable: ${reason}`);

function bucket(env) {
  const store = env?.SHOP_GOODS ?? env?.goods;
  if (!store || typeof store.get !== "function" || typeof store.head !== "function") throw unavailable("no goods bucket is bound");
  return store;
}

/** The pointer key a release of `offeringId` is staged under. */
export function releasePointerKey(offeringId) {
  if (typeof offeringId !== "string" || !OFFERING_ID.test(offeringId)) throw new TypeError("offering id must be a lowercase kebab-case slug");
  return `goods/${offeringId}/release.json`;
}

/**
 * Validate a release pointer's shape.
 * @param {unknown} pointer
 * @param {string} offeringId
 * @returns {object} the pointer, frozen
 */
export function admitReleasePointer(pointer, offeringId) {
  const bundle = pointer?.bundle;
  if (pointer?.type !== "PaidRelease" || pointer.version !== 1 || pointer.offeringId !== offeringId) throw unavailable("the release pointer does not name this offering");
  if (typeof pointer.release !== "string" || pointer.release === "") throw unavailable("the release pointer names no release");
  if (typeof bundle?.key !== "string" || !bundle.key.startsWith(`goods/${offeringId}/`)) throw unavailable("the bundle is outside this offering's goods");
  if (!HEX_SHA256.test(bundle.sha256 ?? "") || !Number.isInteger(bundle.bytes) || bundle.bytes < 1) throw unavailable("the bundle carries no digest or size");
  if (typeof bundle.contentType !== "string" || !FILENAME.test(bundle.filename ?? "")) throw unavailable("the bundle carries no content type or file name");
  return Object.freeze({ ...pointer, bundle: Object.freeze({ ...bundle }) });
}

/** The intended edition of a compiled book, distinct from its release namespace. */
export function releaseExpectationFor(offering) {
  if (!offering?.book) return undefined;
  const edition = offering.book.edition;
  if (!edition?.record || !/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(edition.digest ?? "")) throw unavailable("the book names no accepted edition");
  const artifacts = Object.fromEntries((edition.files ?? []).map(file => [file.format === "EPUB" ? "epub" : file.format === "PDF" ? "screenPdf" : file.format, file.sha256]));
  if (!HEX_SHA256.test(artifacts.epub ?? "") || !HEX_SHA256.test(artifacts.screenPdf ?? "")) throw unavailable("the book names no accepted EPUB and PDF");
  return { release: edition.digest, artifacts };
}

function requireExpectedRelease(pointer, expected) {
  if (expected === undefined) return pointer;
  if (expected?.available === false) throw unavailable("this publication is not released for sale");
  if (typeof expected?.release !== "string" || !expected.release) throw unavailable("the offer names no intended release");
  if (pointer.release !== expected.release) throw unavailable("the staged release differs from the offer's intended edition");
  for (const [format, digest] of Object.entries(expected.artifacts ?? {})) {
    if (!HEX_SHA256.test(digest) || pointer.artifacts?.[format] !== digest) throw unavailable(`the staged ${format} differs from the intended artifact`);
  }
  return pointer;
}

async function readPointer(store, offeringId, expected) {
  const object = await store.get(releasePointerKey(offeringId));
  if (!object) throw unavailable("no release is staged");
  return requireExpectedRelease(admitReleasePointer(JSON.parse(await object.text()), offeringId), expected);
}

/**
 * Confirm a staged release exists before a payment is asked for: the pointer
 * is valid and the bundle it names is present at the size it states.
 * @param {string} offeringId
 * @param {object} env
 * @param {object} [expected] Intended release and artifact identities; unavailable publications refuse admission.
 * @returns {Promise<{offeringId: string, release: string, byteLength: number, bundle: object}>}
 */
export async function admitPaidRelease(offeringId, env, expected) {
  const store = bucket(env);
  const pointer = await readPointer(store, offeringId, expected);
  const head = await store.head(pointer.bundle.key);
  if (!head || head.size !== pointer.bundle.bytes) throw unavailable("the staged bundle is missing or not the size its pointer states");
  return Object.freeze({ offeringId, release: pointer.release, byteLength: head.size, bundle: pointer.bundle });
}

/**
 * Deliver the staged release as one response, refusing bytes whose digest is
 * not the pointer's.
 * @param {string} offeringId
 * @param {object} env
 * @param {object} [expected] Intended release and artifact identities.
 * @returns {Promise<Response>}
 */
export async function readPaidRelease(offeringId, env, expected) {
  const store = bucket(env);
  const pointer = await readPointer(store, offeringId, expected);
  const object = await store.get(pointer.bundle.key);
  if (!object) throw unavailable("the staged bundle is missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.byteLength !== pointer.bundle.bytes || digest !== pointer.bundle.sha256) throw unavailable("the staged bundle does not match its pointer's digest");
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
