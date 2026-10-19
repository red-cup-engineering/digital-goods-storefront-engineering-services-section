/**
 * Digital-goods storefront domain semantics: catalog validation, view-model
 * shaping, the Stripe-offering derivation, download-token issuance and
 * verification (Web Crypto only), and receipt shaping. Pure — no `node:fs`,
 * no `node:crypto` — so this module runs unmodified inside a Cloudflare
 * Worker as well as under plain Node. Presentation is TUFTE's
 * (storefront-presentation.mjs).
 *
 * An offering delivers either hand-listed `goods` or a paid `release`: the
 * id of a release pointer staged in the goods bucket (paid-release.mjs), so a
 * card purchase, a gift and an x402 sale all read the same accepted bytes.
 */

const OFFERING_STATUSES = new Set(["live", "test-only", "coming-soon", "external"]);
const PAID_STATUSES = new Set(["live", "test-only"]);
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** One source-derived BCP 47 language for books: use native Intl rather
 * than a storefront-specific copy of the standard language-tag grammar.
 * The pre-existing English-only catalog remains English by default.
 */
export function bookLanguageTag(book) {
  const value=book?.language ?? "en";
  if (typeof value!=="string" || !value.trim()) throw new TypeError("book.language must be a BCP 47 language tag");
  try {
    const [tag]=Intl.getCanonicalLocales(value);
    if(!tag) throw new RangeError("empty language tag");
    return tag;
  } catch {
    throw new TypeError("book.language must be a BCP 47 language tag");
  }
}
const SHA256_HEX = /^[a-f0-9]{64}$/iu;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function hasGoods(offering) {
  return Array.isArray(offering.goods) && offering.goods.length > 0;
}

function hasExternalUrl(offering) {
  return isNonEmptyString(offering.externalUrl);
}

function hasRelease(offering) {
  return isNonEmptyString(offering.release);
}

/**
 * Validates one catalog `good` entry, appending any defects to `errors`.
 * @param {object} good a catalog offering's goods[] entry
 * @param {string} path the JSON-pointer-ish path to report against
 * @param {{path: string, message: string}[]} errors accumulator
 * @returns {void}
 */
function validateGood(good, path, errors) {
  if (!good || typeof good !== "object") {
    errors.push({ path, message: "good must be an object" });
    return;
  }
  if (!isNonEmptyString(good.name)) errors.push({ path: `${path}.name`, message: "name is required" });
  if (!isNonEmptyString(good.key)) errors.push({ path: `${path}.key`, message: "key is required" });
  if (!isNonEmptyString(good.contentType)) errors.push({ path: `${path}.contentType`, message: "contentType is required" });
  if (!Number.isInteger(good.byteLength) || good.byteLength <= 0) errors.push({ path: `${path}.byteLength`, message: "byteLength must be a positive integer" });
  if (!isNonEmptyString(good.sha256) || !SHA256_HEX.test(good.sha256)) errors.push({ path: `${path}.sha256`, message: "sha256 must be a 64-character hex digest" });
}

/**
 * Validates one catalog offering against the storefront's admission rules,
 * appending any defects to `errors`.
 * @param {object} offering a catalog.offerings[] entry
 * @param {number} index its position in offerings[]
 * @param {Set<string>} seenIds offering ids already seen (mutated)
 * @param {{path: string, message: string}[]} errors accumulator
 * @returns {void}
 */
function validateOffering(offering, index, seenIds, errors) {
  const path = offering && typeof offering.id === "string" ? `offerings[${offering.id}]` : `offerings[${index}]`;
  if (!offering || typeof offering !== "object") {
    errors.push({ path, message: "offering must be an object" });
    return;
  }
  if (!isNonEmptyString(offering.id) || !KEBAB_CASE.test(offering.id)) {
    errors.push({ path, message: "id is required and must be kebab-case" });
  } else if (seenIds.has(offering.id)) {
    errors.push({ path, message: `duplicate offering id "${offering.id}"` });
  } else {
    seenIds.add(offering.id);
  }
  if (!isNonEmptyString(offering.title)) errors.push({ path, message: "title is required" });
  if (!isNonEmptyString(offering.line)) errors.push({ path, message: "line is required" });
  if (!OFFERING_STATUSES.has(offering.status)) {
    errors.push({ path, message: `status must be one of ${[...OFFERING_STATUSES].join(", ")}` });
    return;
  }
  if (PAID_STATUSES.has(offering.status)) {
    if (!Number.isInteger(offering.priceCents) || offering.priceCents <= 0) {
      errors.push({ path, message: "priceCents must be a positive integer" });
    }
    if (!isNonEmptyString(offering.currency)) errors.push({ path, message: "currency is required" });
    if (!hasGoods(offering) && !hasExternalUrl(offering) && !hasRelease(offering)) {
      errors.push({ path, message: "goods, release or externalUrl is required" });
    }
    if (hasGoods(offering)) {
      offering.goods.forEach((good, goodIndex) => validateGood(good, `${path}.goods[${goodIndex}]`, errors));
    }
  } else if (offering.status === "external") {
    if (!hasExternalUrl(offering)) errors.push({ path, message: "externalUrl is required" });
  }
  // coming-soon: no priceCents/goods/externalUrl requirement either way.
  if (offering.release !== undefined && (!isNonEmptyString(offering.release) || !KEBAB_CASE.test(offering.release))) {
    errors.push({ path, message: "release must name a kebab-case paid-release id" });
  }
  if (offering.book !== undefined && (!offering.book || typeof offering.book !== "object" || Array.isArray(offering.book))) {
    errors.push({ path, message: "book must be an object" });
  } else if (offering.book) {
    try { bookLanguageTag(offering.book); }
    catch { errors.push({ path: path + ".book.language", message: "book.language must be a BCP 47 language tag" }); }
  }
}

/**
 * Validates a digital-goods catalog against the storefront's admission
 * rules (id uniqueness/kebab-case, per-status required fields, goods
 * shape). Pure — never throws on a malformed catalog, reports it instead.
 * @param {object} catalog `{ merchant, offerings: [...] }`
 * @returns {{valid: boolean, errors: {path: string, message: string}[]}}
 */
export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== "object") {
    return { valid: false, errors: [{ path: "$", message: "catalog must be an object" }] };
  }
  if (!catalog.merchant || typeof catalog.merchant !== "object") {
    errors.push({ path: "merchant", message: "merchant is required" });
  }
  if (!Array.isArray(catalog.offerings)) {
    errors.push({ path: "offerings", message: "offerings must be an array" });
    return { valid: errors.length === 0, errors };
  }
  const seenIds = new Set();
  catalog.offerings.forEach((offering, index) => validateOffering(offering, index, seenIds, errors));
  return { valid: errors.length === 0, errors };
}

/** Source-qualified public product information for any independent Shop.
 * Keep settlement lines, storage pointers and manuscript paths at the merchant.
 * Explicit field selection prevents new private tenant attributes leaking. */
export function publicCatalog(catalog) {
  const validity = validateCatalog(catalog);
  if (!validity.valid) throw new TypeError(`invalid catalog: ${validity.errors.map(e => e.message).join("; ")}`);
  const pick = (record, keys) => Object.fromEntries(keys
    .filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
  const file = source => pick(source, ["format", "bytes", "sha256", "contentType", "byteLength"]);
  const offerings = catalog.offerings.map(source => {
    const offering = pick(source, ["id","title","subtitle","blurb","keywords","cover",
      "status","priceCents","currency","release","agentOfferUrl","externalUrl"]);
    if (source.goods) offering.goods = source.goods.map(good => pick(good,
      ["name","contentType","byteLength","sha256"]));
    if (source.book) {
      const book = pick(source.book, ["author","authorship","publisher","subjects",
        "marks","contents","series","profile","textProvenance","coverIllustration",
        "coverArt","generatedIllustrations","print","language"]);
      if (source.book.edition) {
        const e = source.book.edition;
        book.edition = {...pick(e, ["digest","acceptedAt","pages","proof"]),
          files: (e.files ?? []).map(file)};
      }
      if (source.book.printEdition) {
        const p = source.book.printEdition;
        book.printEdition = {...pick(p, ["profile","pages","acceptedAt"]),
          ...(p.interior ? {interior: file(p.interior)} : {}),
          ...(p.cover ? {cover: file(p.cover)} : {})};
      }
      offering.book = book;
    }
    return offering;
  });
  return {merchant: pick(catalog.merchant, ["name","legalBody","website"]), offerings};
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * The honest buyer-facing state for one offering, given whether checkout
 * is actually armed right now. Never claims a buy affordance the storefront
 * cannot currently honor.
 * @param {object} offering a catalog offering
 * @param {boolean} checkoutArmed whether the card rail can accept a charge
 * @returns {string} a state string, e.g. "coming soon", "sold at gumroad.com"
 */
function stateFor(offering, checkoutArmed) {
  if (offering.status === "coming-soon") return "coming soon";
  if (offering.status === "external") return `sold at ${hostnameOf(offering.externalUrl)}`;
  if (!checkoutArmed) return "checkout not yet armed";
  return "buy";
}

/**
 * Shapes one catalog offering into its view-model form for listing and
 * product pages.
 * @param {object} offering a catalog offering
 * @param {{checkoutArmed: boolean}} options
 * @returns {object} the offering view model
 */
function offeringModel(offering, { checkoutArmed }) {
  const buyable = PAID_STATUSES.has(offering.status) && checkoutArmed;
  return {
    id: offering.id,
    title: offering.title,
    blurb: offering.blurb ?? null,
    line: offering.line,
    status: offering.status,
    priceCents: offering.priceCents ?? null,
    currency: offering.currency ?? null,
    cover: offering.cover ?? null,
    externalUrl: offering.externalUrl ?? null,
    goods: (offering.goods ?? []).map((good) => ({ name: good.name, key: good.key, contentType: good.contentType, byteLength: good.byteLength, sha256: good.sha256 })),
    release: offering.release ?? null,
    book: offering.book ?? null,
    subtitle: offering.subtitle ?? null,
    keywords: offering.keywords ?? [],
    agentOfferUrl: offering.agentOfferUrl ?? null,
    buyable,
    state: stateFor(offering, checkoutArmed),
  };
}

/**
 * Builds the view model consumed by `renderCatalogHtml`/`renderOfferingHtml`
 * and any other rendering face. Never grants a buy affordance the caller
 * has not honestly declared armed.
 * @param {object} catalog `{ merchant, offerings: [...] }`
 * @param {{checkoutArmed?: boolean}} [options]
 * @returns {{merchant: object, offerings: object[]}}
 */
export function catalogModel(catalog, { checkoutArmed = false } = {}) {
  return {
    merchant: catalog.merchant,
    offerings: catalog.offerings.map((offering) => offeringModel(offering, { checkoutArmed })),
  };
}


/**
 * Select a buyer-useful stable product order without modifying the seller's
 * canonical catalog or confusing advertised release with payment readiness.
 * An actually armed live product leads. An external merchant link is a
 * separate purchase path. Unarmed live products remain discoverable, while
 * preview/test-only and coming-soon entries cannot crowd out those paths.
 * This is storefront commerce policy, not generic Data sorting or payment.
 */
export function prioritizeStorefrontOfferings(offerings) {
  const priority = (item) => item.status === "live" && item.buyable === true ? 0
    : item.status === "external" && typeof item.externalUrl === "string" && item.externalUrl.length > 0 ? 1
    : item.status === "live" ? 2
    : item.status === "test-only" && item.buyable === true ? 3
    : item.status === "test-only" ? 4 : 5;
  return offerings.map((offering, position) => ({ offering, position }))
    .sort((left, right) => priority(left.offering) - priority(right.offering) || left.position - right.position)
    .map(({ offering }) => offering);
}

/**
 * Derives the stripe-services-section fixed-offering shape from one
 * catalog offering — this storefront's catalog is the single source; the
 * card rail's fixed-offerings list is a projection of it, never a second
 * hand-authored copy. Callers filter to `live`/`test-only` offerings
 * before calling this (an external or coming-soon offering has no
 * meaningful Stripe form).
 * @param {object} offering a `live`/`test-only` catalog offering
 * @returns {object} the stripe-services-section offerings.json entry shape
 */
export function stripeOfferingFor(offering) {
  return {
    id: offering.id,
    status: offering.status === "live" ? "live" : "test-only",
    mode: "payment",
    currency: offering.currency,
    unitAmount: offering.priceCents,
    name: offering.title,
    description: offering.blurb ?? offering.title,
    quantity: { minimum: 1, maximum: 1 },
    beneficiarySettlement: offering.line,
    // Preserve the product owner\'s existing policy evidence through the single
    // catalog-to-Stripe projection. Missing policies remain missing and are
    // refused by Stripe live admission; never invent default customer terms.
    ...(typeof offering.terms === "string" ? { terms: offering.terms } : {}),
    ...(typeof offering.taxPolicy === "string" ? { taxPolicy: offering.taxPolicy } : {}),
    ...(typeof offering.refundPolicy === "string" ? { refundPolicy: offering.refundPolicy } : {}),
  };
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64urlDecode(value) {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Issues a signed, expiring download token — `base64url(payload).
 * base64url(signature)` over HMAC-SHA-256 via Web Crypto — so a fulfillment
 * Worker can hand a buyer a verifiable link without any server-side session
 * store.
 * @param {{secret: string, offeringId: string, sessionId: string, expiresAt: number}} params `expiresAt` is an epoch-millisecond timestamp
 * @returns {Promise<string>} the token
 * @throws {Error} when `secret` is missing
 */
export async function issueDownloadToken({ secret, offeringId, sessionId, expiresAt }) {
  if (!isNonEmptyString(secret)) throw new Error("secret is required");
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ offeringId, sessionId, expiresAt }));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${base64urlEncode(payloadBytes)}.${base64urlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies a download token issued by `issueDownloadToken`: signature,
 * shape, and expiry. Never throws — a malformed or tampered token is
 * reported as `{valid: false, reason}`, never an exception a caller must
 * remember to catch.
 * @param {{secret: string, token: string, now?: number}} params `now` defaults to `Date.now()`
 * @returns {Promise<{valid: boolean, reason?: string, offeringId?: string, sessionId?: string, expiresAt?: number}>}
 */
export async function verifyDownloadToken({ secret, token, now = Date.now() }) {
  if (!isNonEmptyString(secret) || typeof token !== "string") return { valid: false, reason: "missing-token-or-secret" };
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed-token" };
  let payloadBytes, signatureBytes;
  try {
    [payloadBytes, signatureBytes] = parts.map((part) => base64urlDecode(part));
  } catch {
    return { valid: false, reason: "malformed-token" };
  }
  const key = await hmacKey(secret);
  const verified = await crypto.subtle.verify("HMAC", key, signatureBytes, payloadBytes);
  if (!verified) return { valid: false, reason: "invalid-signature" };
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { valid: false, reason: "malformed-token" };
  }
  if (typeof payload.expiresAt !== "number" || now > payload.expiresAt) return { valid: false, reason: "expired" };
  return { valid: true, offeringId: payload.offeringId, sessionId: payload.sessionId, expiresAt: payload.expiresAt };
}

/**
 * Shapes a plain-JSON purchase receipt for one settled session against one
 * offering. Deliberately carries no buyer personal data — no email, no
 * card data — only what the storefront itself needs to prove a purchase
 * happened and what it was for.
 * @param {{session: {id: string, mode?: string}, offering: object, now?: Date|number}} params
 * @returns {object} the receipt
 */
export function receiptFor({ session, offering, now = new Date() }) {
  const recordedAt = now instanceof Date ? now : new Date(now);
  return {
    type: "DigitalGoodsReceipt",
    recordedAt: recordedAt.toISOString(),
    sessionId: session.id,
    stripeMode: session.mode ?? null,
    offeringId: offering.id,
    title: offering.title,
    line: offering.line,
    priceCents: offering.priceCents,
    currency: offering.currency,
    goods: (offering.goods ?? []).map((good) => ({ name: good.name, key: good.key, contentType: good.contentType, byteLength: good.byteLength, sha256: good.sha256 })),
  };
}
