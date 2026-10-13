import { ACTOR as STRIPE_ACTOR, invokeCheckout, readiness, solicitCheckout } from "@red-cup-engineering/stripe-services-section";
import { beginGoogleLogin, completeGoogleLogin, googleLogout, identifyGoogle, resolveGoogleSettings } from "@red-cup-engineering/computer-web-server/admission/google";
import { tuftePage, tufteRedirect } from "@red-cup-engineering/web-page-tiling-engine/application";
import { storefrontItemTile } from "@red-cup-engineering/web-page-tiling-engine/storefront";
import { createTufteStorefront } from "@red-cup-engineering/web-page-tiling-engine/storefront/application";
import { catalogModel, issueDownloadToken, stripeOfferingFor, validateCatalog, verifyDownloadToken } from "./digital-goods-storefront.mjs";
import { accountOf } from "./durable-fulfillment.mjs";
import { fulfillStripeCheckoutWebhook } from "./stripe-checkout-fulfillment.mjs";
import { admitPaidRelease, readPaidRelease, releaseExpectationFor } from "./paid-release.mjs";
import { REVIEW_COPY_ID, admitReviewCopyPointer, readReviewCopy, reviewCopyPointerKey, reviewCopyStanding } from "./review-copy.mjs";
import { displayPrice, storefrontFacets, storefrontItemFor, structuredDataFor } from "./storefront-presentation.mjs";

const PAID = new Set(["live", "test-only"]);
const GIFT_ID = /^gift-[0-9a-f-]{36}$/u;
const MAX_API_BYTES = 16 * 1024;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
// A release offering's one deliverable, named in a download token beside the offering id.
const RELEASE_KEY = "release";
// A review copy's one deliverable: the advance-reader rendition stamped for its grant.
const REVIEW_COPY_KEY = "review-copy";

function json(value, status = 200) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function stripeCatalog(catalog) { return { merchant: catalog.merchant, offerings: catalog.offerings.filter((offering) => PAID.has(offering.status)).map(stripeOfferingFor) }; }
function supportsStore(store) { return store && ["recordCheckout", "getCheckout", "claimPayment", "getEntitlement"].every((name) => typeof store[name] === "function"); }
function supportsAccounts(store) { return supportsStore(store) && ["grantEntitlement", "bindEntitlement", "listAccount", "listGrants", "revokeEntitlement"].every((name) => typeof store[name] === "function"); }
function validOrigin(value) { try { return new URL(value).origin === value && new URL(value).protocol === "https:"; } catch { return false; } }
function safeName(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value); }
/** Equal secrets, compared over their digests so the time taken says nothing about where they differ. */
async function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = (await Promise.all([given, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))))).map((digest) => new Uint8Array(digest));
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}
/** A gift id derived from the giver and the caller's reference, so the same request always names the same gift. */
async function referencedGiftId(grantedBy, reference) {
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${grantedBy}\n${reference}`)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `gift-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function dated(value) { return typeof value === "string" ? value.slice(0, 10) : typeof value === "number" ? new Date(value * 1000).toISOString().slice(0, 10) : null; }

// A sign-in result from the web server's admission module as a response.
function admitted(result) {
  if (result.status !== 302) return null;
  const headers = new Headers({ location: result.redirect, "cache-control": "no-store" });
  for (const cookie of result.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/**
 * Creates a Worker fetch handler for a branded digital-goods receiver: a TUFTE
 * storefront with card checkout, delivery of goods or paid releases, reader
 * accounts through Google sign-in, a library per account, and gifts.
 *
 * The receiver binds, per request: `env.fulfillment` (createDurableFulfillment),
 * `env.goods` (the goods bucket), `env.tokenSecret`, `env.audit`, the Stripe
 * secrets, `env.accounts` ({clientId, clientSecret, sessionSecret}; sign-in is
 * off until all three are present), `env.gifters` (the emails allowed to
 * give books) and `env.giftAgent` ({key, as}: a house agent that gives books
 * through the JSON gift API, and review copies through the review-copy API,
 * under `as`, off until both are present).
 * @param {{catalog: object, origin: string, buyerActor: string, routes?: object, tokenTtlSeconds?: number, storefront?: {title?: string, description?: string, footerHtml?: string}}} configuration
 * @returns {{fetch: (request: Request, env: object) => Promise<Response>, catalog: object}}
 */
export function createDigitalGoodsStorefrontWorker({ catalog, origin, buyerActor, routes = {}, tokenTtlSeconds = 3600, storefront = {} }) {
  const validation = validateCatalog(catalog);
  if (!validation.valid) throw new TypeError(`invalid catalog: ${validation.errors.map((error) => error.message).join("; ")}`);
  if (!validOrigin(origin)) throw new TypeError("origin must be a canonical https origin");
  if (typeof buyerActor !== "string" || buyerActor.length === 0) throw new TypeError("buyerActor is required");
  const path = { catalog: "/", goods: "/goods/", checkout: "/checkout/", webhook: "/webhooks/stripe", thanks: "/thanks", download: "/download/", library: "/library", gifts: "/gifts", giftApi: "/api/gifts", reviewCopies: "/review-copies", reviewCopyApi: "/api/review-copies", signIn: "/oauth/login", callback: "/oauth/callback", signOut: "/oauth/logout", ...routes };
  const railCatalog = stripeCatalog(catalog);
  const offering = (id) => catalog.offerings.find((candidate) => candidate.id === id);
  const title = storefront.title ?? catalog.merchant?.name ?? "Storefront";
  const armed = (env) => { const state = readiness({ env, catalog: railCatalog }); return supportsStore(env.fulfillment) && env.goods && typeof env.goods.get === "function" && env.audit && typeof env.audit.record === "function" && typeof env.tokenSecret === "string" && env.tokenSecret.length > 0 && state.credential.present && state.webhookSecretPresent && state.customerContractTokenPresent; };

  // Any verified Google account may sign in: an account here is a reader's
  // email, not admission to anything private.
  const signIn = (env) => ({ ...(env.accounts ?? {}), publicBaseUrl: origin, callbackPath: path.callback, admitEmail: () => true, sessionCookie: "storefront_session", transactionCookie: "storefront_sign_in" });
  const signInOpen = (env) => resolveGoogleSettings(signIn(env)).configured && supportsAccounts(env.fulfillment);
  const readerOf = (request, env) => (signInOpen(env) ? identifyGoogle(signIn(env), request) : null);
  const giftersOf = (env) => new Set((env.gifters ?? []).map(accountOf).filter(Boolean));
  const gifter = (reader, env) => Boolean(reader) && giftersOf(env).has(accountOf(reader.email));

  function navigation(context, current) {
    const { env, reader } = context.capabilities;
    const here = `${context.url.pathname}${context.url.search}`;
    return [
      { href: path.catalog, label: "Books", current: current === "catalog" },
      ...(reader ? [{ href: path.library, label: "Your library", current: current === "library" }] : signInOpen(env) ? [{ href: `${path.signIn}?return_to=${encodeURIComponent(here)}`, label: "Sign in" }] : []),
      ...(gifter(reader, env) ? [{ href: path.gifts, label: "Gifts", current: current === "gifts" }] : []),
      ...(reader ? [{ href: path.signOut, label: `Sign out (${reader.email})` }] : []),
    ];
  }
  const footerHtml = storefront.footerHtml;
  const page = (context, current, model, options) => tuftePage({ navigation: navigation(context, current), footerHtml, eyebrow: title, ...model }, options);
  const message = (context, heading, text, status = 200) => page(context, null, { title: heading, tiles: [{ id: "message", title: heading, span: 12, content: text }] }, { status });

  async function downloadHref(entitlement, env) {
    const item = offering(entitlement.offeringId);
    const expiresAt = Date.now() + tokenTtlSeconds * 1000;
    if (entitlement.kind === "review-copy") return [{ label: "Download the review copy (EPUB)", href: `${path.download}${await issueDownloadToken({ secret: env.tokenSecret, offeringId: `${entitlement.offeringId}/${REVIEW_COPY_KEY}`, sessionId: entitlement.id, expiresAt })}` }];
    if (item?.release) return [{ label: "Download EPUB and PDF", href: `${path.download}${await issueDownloadToken({ secret: env.tokenSecret, offeringId: `${item.id}/${RELEASE_KEY}`, sessionId: entitlement.id ?? entitlement.sessionId, expiresAt })}` }];
    return Promise.all((entitlement.goods ?? []).map(async (good) => ({ label: `Download ${good.name}`, href: `${path.download}${await issueDownloadToken({ secret: env.tokenSecret, offeringId: `${entitlement.offeringId}/${good.key}`, sessionId: entitlement.id ?? entitlement.sessionId, expiresAt })}` })));
  }

  // The actions a reader is offered on one offering, decided here, rendered by TUFTE.
  function actionsFor(item, { env, owned, giving }) {
    const actions = [];
    if (owned.has(item.id)) actions.push({ kind: "link", label: "In your library", href: path.library });
    if (PAID.has(item.status)) {
      if (item.buyable) actions.push({ kind: "form", form: { action: `${path.checkout}${item.id}`, method: "post", submitters: [{ label: `Buy — ${displayPrice(item.priceCents, item.currency)}` }] } });
      else actions.push({ kind: "unavailable", label: "Card checkout opens soon", reason: "card payments are not connected yet" });
      if (item.agentOfferUrl) actions.push({ kind: "link", label: "Buy with USDC over x402", href: item.agentOfferUrl });
    } else if (item.status === "external") actions.push({ kind: "link", label: item.state[0].toUpperCase() + item.state.slice(1), href: item.externalUrl });
    else if (item.status === "coming-soon") actions.push({ kind: "unavailable", label: "Coming soon" });
    if (giving && item.release) actions.push({ kind: "link", label: "Give this book", href: `${path.gifts}?offering=${encodeURIComponent(item.id)}` });
    return actions;
  }

  async function storefrontCatalog(context) {
    const { env, reader } = context.capabilities;
    const owned = new Set(reader && supportsAccounts(env.fulfillment) ? (await env.fulfillment.listAccount(reader.email)).filter((entry) => entry.status === "active").map((entry) => entry.offeringId) : []);
    const giving = gifter(reader, env);
    const items = catalogModel(catalog, { checkoutArmed: armed(env) }).offerings.map((item) => {
      const href = `${path.goods}${item.id}`;
      return { ...storefrontItemFor(item, { actions: actionsFor(item, { env, owned, giving }), cover: item.cover ?? undefined }), metadata: {
        canonical: `${origin}${href}`, type: item.book ? "book" : "product", siteName: title,
        ...(item.cover ? { image: `${origin}${item.cover}` } : {}),
        structuredData: structuredDataFor(item, { origin, href, image: item.cover }),
      } };
    });
    return { title, description: storefront.description, navigation: navigation(context, "catalog"), footerHtml, facets: storefrontFacets(items), items,
      metadata: { description: storefront.description, canonical: `${origin}${path.catalog}`, type: "website", siteName: title } };
  }

  async function checkout(context) {
    const { env, reader } = context.capabilities;
    const id = context.params.id; const item = offering(id);
    if (!item || !PAID.has(item.status)) return message(context, "Not found", "No such offering.", 404);
    if (!armed(env)) return message(context, "Not available yet", "Card checkout for this book opens once the shop's card payments are connected.", 409);
    let admittedRelease;
    if (item.release) {
      try { admittedRelease = await admitPaidRelease(item.release, { goods: env.goods }, releaseExpectationFor(item)); }
      catch { return message(context, "Checkout unavailable", "The current edition is unavailable. Please try again later.", 503); }
    }
    const customerReference = crypto.randomUUID();
    const solicitation = { "@context": "https://www.w3.org/ns/activitystreams", id: `${buyerActor}:checkout:${customerReference}`, type: "Offer", actor: buyerActor, target: STRIPE_ACTOR, object: { type: "ServiceSolicitation", request: { offeringId: id, quantity: 1, successUrl: `${origin}${path.thanks}?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${origin}${path.goods}${id}`, customerReference } } };
    const offered = solicitCheckout(solicitation, { env, catalog: railCatalog });
    if (offered.type !== "Offer") return message(context, "Checkout unavailable", "This book isn't available to buy yet.", 409);
    const accepted = await invokeCheckout({ "@context": solicitation["@context"], id: `${solicitation.id}:accept`, type: "Accept", actor: buyerActor, target: solicitation.target, object: { offer: offered } }, { env, catalog: railCatalog, store: env.audit });
    if (accepted.type !== "Accept") return message(context, "Checkout unavailable", "We couldn't start checkout. Please try again later.", 502);
    const registration = await env.fulfillment.recordCheckout({ sessionId: accepted.object.stripeSessionId, offeringId: id, requestDigest: accepted.object.requestDigest, amountTotal: item.priceCents, currency: item.currency, stripeMode: accepted.object.stripeMode, goods: item.goods, release: item.release ?? null, admittedRelease: admittedRelease ?? null, account: reader ? accountOf(reader.email) : null, status: "open" });
    if (!registration || registration.failed || !["registered", "duplicate"].includes(registration.disposition)) return message(context, "Checkout unavailable", "We couldn't start checkout. Please try again later.", 503);
    return Response.redirect(accepted.object.checkoutUrl, 303);
  }


  // One entitlement as a TUFTE storefront tile: what it is, where it came from, and its downloads.
  async function entitlementTile(entitlement, env, { extraActions = [], note } = {}) {
    const item = offering(entitlement.offeringId);
    const provenance = entitlement.kind === "review-copy" ? `A review copy${entitlement.createdAt ? ` given on ${dated(entitlement.createdAt)}` : ""}, readable until ${dated(entitlement.expiresAt)}`
      : entitlement.kind === "gift" ? `A gift${entitlement.createdAt ? ` on ${dated(entitlement.createdAt)}` : ""}${entitlement.note ? `: “${entitlement.note}”` : ""}` : `Bought${entitlement.createdAt ? ` on ${dated(entitlement.createdAt)}` : ""}`;
    const standing = entitlement.kind === "review-copy" ? reviewCopyStanding(entitlement) : { deliverable: entitlement.status === "active", reason: "withdrawn" };
    const downloads = standing.deliverable ? (await downloadHref(entitlement, env)).map((link) => ({ kind: "link", ...link })) : [{ kind: "unavailable", label: standing.reason === "expired" ? "Expired" : "Withdrawn" }];
    return storefrontItemTile({ id: `entitlement-${entitlement.id ?? entitlement.sessionId}`, title: item?.title ?? entitlement.offeringId, summary: note ?? provenance, ...(item?.cover ? { image: { src: item.cover, alt: `Cover of ${item.title}` } } : {}), actions: [...downloads, ...(item ? [{ kind: "link", label: "About this book", href: `${path.goods}${item.id}` }] : []), ...extraActions] });
  }

  async function thanks(context) {
    const { env, reader } = context.capabilities;
    const sessionId = context.url.searchParams.get("session_id");
    const entitlement = sessionId && supportsStore(env.fulfillment) ? await env.fulfillment.getEntitlement(sessionId) : null;
    if (!entitlement || entitlement.status !== "active") return message(context, "Purchase not found", "We can't find a completed purchase for this link.", 404);
    if (!env.tokenSecret) return message(context, "Unavailable", "Delivery is unavailable.", 503);
    const keep = entitlement.account
      ? []
      : reader
        ? [{ kind: "form", form: { action: `${path.library}/keep`, method: "post", fields: [{ name: "session_id", kind: "hidden", value: sessionId }], submitters: [{ label: "Keep it in your library" }] } }]
        : signInOpen(env) ? [{ kind: "link", label: "Sign in to keep it in your library", href: `${path.signIn}?return_to=${encodeURIComponent(`${path.thanks}?session_id=${sessionId}`)}` }] : [];
    return page(context, null, { title: "Thank you", tiles: [await entitlementTile(entitlement, env, { extraActions: keep, note: "Your purchase is complete. These links last an hour; your library keeps the book for good." })] });
  }

  async function download(token, env) {
    const verified = await verifyDownloadToken({ secret: env.tokenSecret ?? "", token });
    if (!verified.valid) return new Response("This download is no longer available", { status: 403 });
    const entitlement = supportsStore(env.fulfillment) ? await env.fulfillment.getEntitlement(verified.sessionId) : null;
    const [offeringId, key] = String(verified.offeringId).split(/\/(.*)/su);
    if (!entitlement || entitlement.status !== "active" || entitlement.offeringId !== offeringId) return new Response("This download is no longer available", { status: 403 });
    if (key === REVIEW_COPY_KEY && entitlement.kind === "review-copy") {
      try { return await readReviewCopy(entitlement, { goods: env.goods }); } catch { return new Response("This review copy is unavailable", { status: 403 }); }
    }
    const item = offering(offeringId);
    if (key === RELEASE_KEY && item?.release) {
      try { return await readPaidRelease(item.release, { goods: env.goods }, releaseExpectationFor(item)); } catch { return new Response("The download file is unavailable", { status: 503 }); }
    }
    const good = entitlement.goods?.find((candidate) => candidate.key === key);
    if (!good || !safeName(good.key)) return new Response("This download is no longer available", { status: 403 });
    const object = await env.goods.get(`goods/${offeringId}/${good.key}`);
    if (!object) return new Response("Not Found", { status: 404 });
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== good.sha256) return new Response("The download file is unavailable", { status: 503 });
    return new Response(bytes, { headers: { "content-type": good.contentType, "content-length": String(bytes.byteLength), "content-disposition": `attachment; filename="${good.key}"`, "cache-control": "no-store" } });
  }

  const signInFirst = (context) => (signInOpen(context.capabilities.env)
    ? tufteRedirect(`${path.signIn}?return_to=${encodeURIComponent(`${context.url.pathname}${context.url.search}`)}`)
    : message(context, "Sign-in isn't open yet", "Reader accounts open once the shop's sign-in is connected. A gift link works without an account.", 503));

  async function library(context) {
    const { env, reader } = context.capabilities;
    if (!reader) return signInFirst(context);
    const entries = (await env.fulfillment.listAccount(reader.email)).filter((entry) => entry.status === "active");
    const tiles = await Promise.all(entries.map((entry) => entitlementTile(entry, env)));
    return page(context, "library", { title: "Your library", subtitle: `Books kept for ${reader.email}. Each download is the newest accepted edition.`, tiles: tiles.length ? tiles : [{ id: "empty", title: "Nothing here yet", span: 12, content: "Books you buy while signed in, or keep from a receipt, and books given to this address appear here." }] });
  }

  async function keep(context) {
    const { env, reader } = context.capabilities;
    if (!reader) return signInFirst(context);
    const sessionId = (await context.input.formData()).get("session_id");
    const entitlement = typeof sessionId === "string" ? await env.fulfillment.getEntitlement(sessionId) : null;
    if (!entitlement || entitlement.status !== "active" || ["gift", "review-copy"].includes(entitlement.kind)) return message(context, "Purchase not found", "We can't find a completed purchase to keep.", 404);
    const bound = await env.fulfillment.bindEntitlement({ id: sessionId, account: reader.email });
    if (bound.failed) return message(context, "Already kept", "This purchase is already in another account's library.", 409);
    return tufteRedirect(path.library);
  }

  const giftable = () => catalog.offerings.filter((item) => item.release && item.status !== "coming-soon");

  async function gifts(context) {
    const { env, reader } = context.capabilities;
    if (!reader) return signInFirst(context);
    if (!gifter(reader, env)) return message(context, "Not a gifter", "This account can't give books.", 403);
    const chosen = context.url.searchParams.get("offering");
    const form = { id: "give", title: "Give a book", span: 12, form: { action: path.gifts, method: "post", fields: [
      { name: "offering", label: "Book", kind: "select", value: giftable().some((item) => item.id === chosen) ? chosen : "", options: giftable().map((item) => ({ value: item.id, label: item.title })) },
      { name: "email", label: "Recipient's email", kind: "email", description: "They keep the book by signing in with the Google account for this address. The gift link works for them straight away." },
      { name: "note", label: "Note", kind: "textarea", description: "Shown to them with the book." },
    ], submitters: [{ label: "Give this book" }] } };
    const given = (await env.fulfillment.listGrants(reader.email)).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const tiles = await Promise.all(given.map((entry) => entitlementTile(entry, env, { note: `To ${entry.recipientEmail}${entry.createdAt ? ` on ${dated(entry.createdAt)}` : ""}${entry.status === "active" ? "" : " (withdrawn)"}`, extraActions: [
      { kind: "link", label: "Gift link", href: `${path.gifts}/${entry.id}` },
      ...(entry.status === "active" ? [{ kind: "form", form: { action: `${path.gifts}/${entry.id}/revoke`, method: "post", submitters: [{ label: "Withdraw" }] } }] : []),
    ] })));
    return page(context, "gifts", { title: "Gifts", tiles: [form, ...tiles] });
  }

  async function give(context) {
    const { env, reader } = context.capabilities;
    if (!reader) return signInFirst(context);
    if (!gifter(reader, env)) return message(context, "Not a gifter", "This account can't give books.", 403);
    const fields = await context.input.formData();
    const item = giftable().find((candidate) => candidate.id === fields.get("offering"));
    const recipient = accountOf(fields.get("email"));
    if (!item || !recipient) return message(context, "Gift not given", "Choose a book and give a valid email address.", 400);
    const id = `gift-${crypto.randomUUID()}`;
    const granted = await env.fulfillment.grantEntitlement({ id, offeringId: item.id, release: item.release, recipientEmail: recipient, grantedBy: reader.email, note: String(fields.get("note") ?? "").trim(), createdAt: new Date().toISOString() });
    if (granted.failed) return message(context, "Gift not given", "The gift couldn't be recorded. Please try again.", 503);
    return tufteRedirect(`${path.gifts}/${id}`);
  }

  async function withdraw(context) {
    const { env, reader } = context.capabilities;
    if (!reader) return signInFirst(context);
    if (!gifter(reader, env) || !GIFT_ID.test(context.params.id)) return message(context, "Not found", "No such gift.", 404);
    const revoked = await env.fulfillment.revokeEntitlement({ id: context.params.id, grantedBy: reader.email, reason: "withdrawn by the giver", revokedAt: new Date().toISOString() });
    if (revoked.failed) return message(context, "Not found", "No such gift.", 404);
    return tufteRedirect(path.gifts);
  }

  async function gift(context) {
    const { env, reader } = context.capabilities;
    const id = context.params.id;
    const entitlement = GIFT_ID.test(id) && supportsAccounts(env.fulfillment) ? await env.fulfillment.getEntitlement(id) : null;
    if (!entitlement || entitlement.kind !== "gift") return message(context, "Gift not found", "This gift link doesn't name a gift.", 404);
    if (entitlement.status !== "active") return message(context, "Gift withdrawn", "This gift link has been withdrawn.", 410);
    const signedInAs = accountOf(reader?.email);
    const hint = signedInAs === entitlement.recipientEmail
      ? "It's in your library."
      : `It's addressed to ${entitlement.recipientEmail}. ${signInOpen(env) ? "Sign in with that Google account to keep it in your library." : "Keep this link to download it again."}`;
    const tiles = [await entitlementTile(entitlement, env, { note: `${entitlement.note ? `“${entitlement.note}” ` : ""}${hint}`, extraActions: signedInAs || !signInOpen(env) ? [] : [{ kind: "link", label: "Sign in", href: `${path.signIn}?return_to=${encodeURIComponent(path.library)}` }] })];
    if (gifter(reader, env) && entitlement.grantedBy === signedInAs) tiles.unshift({ id: "share", title: "Send this link", span: 12, content: `Send ${origin}${path.gifts}/${id} to ${entitlement.recipientEmail}. Anyone holding the link can download the book, so send it only to them.` });
    return page(context, null, { title: `A gift: ${offering(entitlement.offeringId)?.title ?? "a book"}`, metadata: { robots: "noindex" }, tiles });
  }

  // A review copy's link: the copy, its terms, and the date it stops working.
  async function reviewCopy(context) {
    const { env, reader } = context.capabilities;
    const id = context.params.id;
    const entitlement = REVIEW_COPY_ID.test(id) && supportsAccounts(env.fulfillment) ? await env.fulfillment.getEntitlement(id) : null;
    if (!entitlement || entitlement.kind !== "review-copy") return message(context, "Review copy not found", "This link doesn't name a review copy.", 404);
    const standing = reviewCopyStanding(entitlement);
    if (!standing.deliverable) return message(context, standing.reason === "expired" ? "Review copy expired" : "Review copy withdrawn", standing.reason === "expired" ? `This review copy could be downloaded until ${dated(entitlement.expiresAt)}.` : "This review copy has been withdrawn.", 410);
    const signedInAs = accountOf(reader?.email);
    const terms = "A review is welcome and never required. If you post one, please say you received a free copy. This copy is marked for you; please don't share it.";
    const hint = signedInAs === entitlement.recipientEmail ? "It's in your library." : `It's addressed to ${entitlement.recipientEmail}. ${signInOpen(env) ? "Sign in with that Google account to keep it in your library." : "Keep this link to download it again."}`;
    const tiles = [await entitlementTile(entitlement, env, { note: `${terms} ${hint}`, extraActions: signedInAs || !signInOpen(env) ? [] : [{ kind: "link", label: "Sign in", href: `${path.signIn}?return_to=${encodeURIComponent(path.library)}` }] })];
    return page(context, null, { title: `A review copy: ${offering(entitlement.offeringId)?.title ?? "a book"}`, metadata: { robots: "noindex" }, tiles });
  }

  /** The house agent named by `env.giftAgent`, or the refusal to send when the request does not carry its key. */
  async function authorizedAgent(request, env, api) {
    const agent = env.giftAgent;
    const as = accountOf(agent?.as);
    if (!agent?.key || !as || !supportsAccounts(env.fulfillment)) return { refusal: json({ error: `the ${api} API is not configured` }, 503) };
    if (!(await sameSecret((request.headers.get("authorization") ?? "").replace(/^Bearer\s+/iu, ""), agent.key))) return { refusal: json({ error: "unauthorized" }, 401) };
    return { as };
  }
  async function agentBody(request) {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_API_BYTES) return null;
    try { return text ? JSON.parse(text) : {}; } catch { return null; }
  }

  /**
   * The gift API: a house agent (one sending review copies, say) gives books
   * without a browser. Bearer `env.giftAgent.key`; every gift is recorded as
   * given by `env.giftAgent.as`. A request with a `reference` names the same
   * gift every time, so repeating it never gives twice.
   *   GET  /api/gifts             the books that can be given
   *   POST /api/gifts             {offering, email, note?, reference?} → {id, url, disposition}
   *   GET  /api/gifts/:id         {id, offering, status, createdAt, revokedAt}
   *   POST /api/gifts/:id/revoke  {reason?} → {disposition}
   */
  async function giftApi(request, env, rest) {
    const { as, refusal } = await authorizedAgent(request, env, "gift");
    if (refusal) return refusal;
    const body = () => agentBody(request);
    if (rest === "" && request.method === "GET") return json({ giftable: giftable().map((item) => ({ id: item.id, title: item.title })) });
    if (rest === "" && request.method === "POST") {
      const input = await body();
      const item = giftable().find((candidate) => candidate.id === input?.offering);
      const recipient = accountOf(input?.email);
      if (!item || !recipient) return json({ error: "a gift needs a giftable offering and a valid email" }, 400);
      if (input.reference !== undefined && !REFERENCE.test(String(input.reference))) return json({ error: "a reference is up to 200 letters, digits and ._:/-" }, 400);
      const id = input.reference ? await referencedGiftId(as, input.reference) : `gift-${crypto.randomUUID()}`;
      const granted = await env.fulfillment.grantEntitlement({ id, offeringId: item.id, release: item.release, recipientEmail: recipient, grantedBy: as, note: String(input.note ?? "").trim(), createdAt: new Date().toISOString() });
      if (granted.failed && granted.disposition !== "duplicate") return json({ error: "the gift could not be recorded" }, 503);
      if (granted.disposition === "duplicate") {
        const existing = await env.fulfillment.getEntitlement(id);
        // A deterministic reference may never be reused to gift a different
        // book or recipient, nor to resurrect a withdrawn entitlement.
        if (!existing || existing.kind !== "gift" || existing.grantedBy !== as
          || existing.offeringId !== item.id || existing.recipientEmail !== recipient) {
          return json({ error: "the reference already belongs to another gift" }, 409);
        }
        if (existing.status !== "active") return json({ error: "the referenced gift was withdrawn" }, 410);
      }
      return json({ id, url: `${origin}${path.gifts}/${id}`, offering: item.id, disposition: granted.disposition ?? "granted" }, granted.disposition === "duplicate" ? 200 : 201);
    }
    const [id, action] = rest.slice(1).split("/");
    if (!GIFT_ID.test(id ?? "")) return json({ error: "not found" }, 404);
    const entitlement = await env.fulfillment.getEntitlement(id);
    if (!entitlement || entitlement.kind !== "gift" || entitlement.grantedBy !== as) return json({ error: "not found" }, 404);
    if (!action && request.method === "GET") return json({ id, offering: entitlement.offeringId, status: entitlement.status, createdAt: entitlement.createdAt, revokedAt: entitlement.revokedAt ?? null });
    if (action === "revoke" && request.method === "POST") {
      const input = await body();
      const revoked = await env.fulfillment.revokeEntitlement({ id, grantedBy: as, reason: String(input?.reason ?? "withdrawn by the giver").slice(0, 200), revokedAt: new Date().toISOString() });
      return json({ id, disposition: revoked.failed ? "unknown" : "revoked" }, revoked.failed ? 404 : 200);
    }
    return json({ error: "not found" }, 404);
  }

  /**
   * The review-copy API: the publisher records one reader's review copy after
   * staging its stamped rendition under the grant (stage-review-copy.mjs). The
   * publisher chooses the id (referencedReviewCopyId), because the copy is
   * stamped with it before it is recorded. A review copy may be given while
   * the offering is coming soon; it is refused unless the staged pointer names
   * the same edition and bytes, and it stops downloading at `expiresAt`.
   *   POST /api/review-copies             {id, offering, email, release, artifactSha256, expiresAt, note?} → {id, url, disposition}
   *   GET  /api/review-copies/:id         {id, offering, status, expiresAt, createdAt, revokedAt}
   *   POST /api/review-copies/:id/revoke  {reason?} → {disposition}
   */
  async function reviewCopyApi(request, env, rest) {
    const { as, refusal } = await authorizedAgent(request, env, "review-copy");
    if (refusal) return refusal;
    if (rest === "" && request.method === "POST") {
      const input = await agentBody(request);
      const item = offering(input?.offering), recipient = accountOf(input?.email);
      if (!item || !recipient || !REVIEW_COPY_ID.test(input?.id ?? "")) return json({ error: "a review copy needs an offering, a valid email and a review-<uuid> id" }, 400);
      const edition = item.book?.edition?.digest;
      if (edition && input.release !== edition) return json({ error: "a review copy is a rendition of the offering's accepted edition" }, 400);
      let pointer;
      try {
        const object = await env.goods?.get(reviewCopyPointerKey(item.id, input.id));
        pointer = object ? admitReviewCopyPointer(JSON.parse(await object.text()), item.id, input.id) : null;
      } catch { pointer = null; }
      if (!pointer || pointer.release !== input.release || pointer.bundle.sha256 !== input.artifactSha256) return json({ error: "stage the stamped copy under this grant before recording it" }, 409);
      const granted = await env.fulfillment.grantEntitlement({ kind: "review-copy", id: input.id, offeringId: item.id, release: input.release, artifactSha256: input.artifactSha256, expiresAt: input.expiresAt, recipientEmail: recipient, grantedBy: as, note: String(input.note ?? "").trim(), createdAt: new Date().toISOString() });
      if (granted.failed && granted.disposition !== "duplicate") return json({ error: granted.disposition === "rejected" ? "the review copy is malformed" : "the review copy could not be recorded" }, granted.disposition === "rejected" ? 400 : 503);
      return json({ id: input.id, url: `${origin}${path.reviewCopies}/${input.id}`, offering: item.id, disposition: granted.disposition ?? "granted" }, granted.disposition === "duplicate" ? 200 : 201);
    }
    const [id, action] = rest.slice(1).split("/");
    if (!REVIEW_COPY_ID.test(id ?? "")) return json({ error: "not found" }, 404);
    const entitlement = await env.fulfillment.getEntitlement(id);
    if (!entitlement || entitlement.kind !== "review-copy" || entitlement.grantedBy !== as) return json({ error: "not found" }, 404);
    if (!action && request.method === "GET") return json({ id, offering: entitlement.offeringId, status: entitlement.status, expiresAt: entitlement.expiresAt, createdAt: entitlement.createdAt, revokedAt: entitlement.revokedAt ?? null });
    if (action === "revoke" && request.method === "POST") {
      const input = await agentBody(request);
      const revoked = await env.fulfillment.revokeEntitlement({ id, grantedBy: as, reason: String(input?.reason ?? "withdrawn by the publisher").slice(0, 200), revokedAt: new Date().toISOString() });
      return json({ id, disposition: revoked.failed ? "unknown" : "revoked" }, revoked.failed ? 404 : 200);
    }
    return json({ error: "not found" }, 404);
  }

  function beginSignIn(context) {
    const { env } = context.capabilities;
    if (!signInOpen(env)) return signInFirst(context);
    return admitted(beginGoogleLogin(signIn(env), context.url)) ?? message(context, "Sign-in unavailable", "Sign-in couldn't start. Please try again later.", 503);
  }
  async function finishSignIn(context) {
    const { env } = context.capabilities;
    const result = await completeGoogleLogin(signIn(env), context.request, context.url);
    return admitted(result) ?? message(context, "Sign-in didn't finish", result.error === "login-expired" ? "The sign-in took too long. Please try again." : "Google didn't confirm a verified email address. Please try again.", result.status >= 500 ? 502 : 400);
  }
  const signOut = (context) => admitted(googleLogout(signIn(context.capabilities.env)));

  const application = createTufteStorefront({
    catalog: storefrontCatalog,
    path: path.catalog,
    itemPath: `${path.goods}:id`,
    document: { language: "en" },
    pages: [
      { match: path.thanks, load: thanks },
      { match: path.library, load: library },
      { match: path.gifts, load: gifts },
      { match: `${path.gifts}/:id`, load: gift },
      { match: `${path.reviewCopies}/:id`, load: reviewCopy },
      { match: path.signIn, load: beginSignIn },
      { match: path.callback, load: finishSignIn },
      { match: path.signOut, load: signOut },
      { match: "/catalog.json", load: () => json(catalog) },
    ],
    actions: [
      { match: `${path.checkout}:id`, run: checkout },
      { match: `${path.library}/keep`, run: keep },
      { match: path.gifts, run: give },
      { match: `${path.gifts}/:id/revoke`, run: withdraw },
    ],
  });

  return { catalog, async fetch(request, env) {
    const url = new URL(request.url);
    // Stripe posts without a browser origin, so its webhook stands outside the
    // storefront application's same-origin action guard.
    if (request.method === "POST" && url.pathname === path.webhook) return fulfillStripeCheckoutWebhook(request, env);
    // A download is bytes for any client, never an HTML-or-JSON page.
    if (request.method === "GET" && url.pathname.startsWith(path.download)) return download(url.pathname.slice(path.download.length), env);
    // The gift API answers a house agent in JSON, outside the browser application.
    if (url.pathname === path.giftApi || url.pathname.startsWith(`${path.giftApi}/`)) return giftApi(request, env, url.pathname.slice(path.giftApi.length));
    if (url.pathname === path.reviewCopyApi || url.pathname.startsWith(`${path.reviewCopyApi}/`)) return reviewCopyApi(request, env, url.pathname.slice(path.reviewCopyApi.length));
    return application.fetch(request, { capabilities: { env, reader: readerOf(request, env) } });
  } };
}

