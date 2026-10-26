import { CHECKOUT_EVENTS } from "@red-cup-engineering/stripe-services-section/checkout-events";
import { isCompleteEventReceipt } from "@red-cup-engineering/stripe-services-section";
import { reviewCopyEntitlement } from "./review-copy.mjs";

function reply(value, status = 200) { return Response.json(value ?? null, { status }); }
function sameCheckout(left, right) {
  return left && left.sessionId === right.sessionId && left.offeringId === right.offeringId && left.requestDigest === right.requestDigest && left.amountTotal === right.amountTotal && left.currency === right.currency && left.stripeMode === right.stripeMode && JSON.stringify(left.goods) === JSON.stringify(right.goods) && left.release === right.release && JSON.stringify(left.admittedRelease ?? null) === JSON.stringify(right.admittedRelease ?? null)
    // The same Checkout session cannot switch the bound buyer or status on a
    // retry. Absent and explicit null are equivalent for legacy consumers.
    && (left.account ?? null) === (right.account ?? null)
    && (left.status ?? null) === (right.status ?? null)
    && (left.mode ?? null) === (right.mode ?? null)
    && (left.buyerActor ?? null) === (right.buyerActor ?? null)
    && JSON.stringify(left.buyerPrincipal ?? null) === JSON.stringify(right.buyerPrincipal ?? null)
    && JSON.stringify(left.request ?? null) === JSON.stringify(right.request ?? null)
    && JSON.stringify(left.offering ?? null) === JSON.stringify(right.offering ?? null);
}
const CHECKOUT_AUDIT = "stripe-checkout-session-creation.receipts";
const EVENT_AUDIT = "stripe-webhook-event-admission.events";
const MAX_AUDIT_RECORDS = 2048;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const AUDIT_PAGE = 64;
const PROVIDER_CHECKOUT = /^cs_[A-Za-z0-9_]+$/u;
const NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u;
function dataRecord(value) {
  return !!value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}
function auditSelection(value) {
  return dataRecord(value) && Object.keys(value).every(key => ["category", "limit", "strict"].includes(key))
    && [CHECKOUT_AUDIT, EVENT_AUDIT].includes(value.category) && value.strict === true
    // Stripe's original reader may ask for its larger bound plus one. The
    // complete local scan still has its own stricter fixed bound.
    && (value.limit === undefined || Number.isSafeInteger(value.limit) && value.limit > 0 && value.limit <= 100001);
}
const text = value => typeof value === "string" && value.length > 0 && value.length <= 2048;
/** Check the original receipt envelope before filtering any category. This is
 * the trusted DO's custody read, not a verifier for arbitrarily rewritten
 * storage or proof that a wholly missing historical row once existed. */
function auditEntry(key, entry) {
  if (!dataRecord(entry) || !dataRecord(entry.record) || !dataRecord(entry.told)
      || !text(entry.record.id) || key !== `audit:${entry.record.id}`
      || !text(entry.recordedAt) || !Number.isFinite(Date.parse(entry.recordedAt))) return false;
  const record = entry.record;
  if (entry.category === CHECKOUT_AUDIT) return record.type === "StripeCheckoutSessionReceipt"
    && record.id === `urn:stripe-checkout-receipt:${record.stripeSessionId}`
    && PROVIDER_CHECKOUT.test(record.stripeSessionId ?? "") && NI.test(record.requestDigest ?? "")
    && text(record.customerSettlement) && text(record.offeringId) && text(record.legalMerchant)
    && ["test", "live"].includes(record.stripeMode)
    && entry.told.for === true && entry.told.against === false;
  if (entry.category !== EVENT_AUDIT || !isCompleteEventReceipt(record)) return false;
  return record.type === "StripeWebhookEventConflictReceipt"
    ? entry.told.for === false && entry.told.against === true
    : entry.told.for === true && entry.told.against === false;
}
async function queryAudit(transaction, selection) {
  const entries = []; let startAfter, count = 0, bytes = 0;
  for (;;) {
    const page = await transaction.list({ prefix: "audit:", limit: AUDIT_PAGE, ...(startAfter ? { startAfter } : {}) });
    if (!(page instanceof Map) || page.size > AUDIT_PAGE) throw new Error("audit-custody-unavailable");
    for (const [key, entry] of page) {
      if (typeof key !== "string" || !key.startsWith("audit:") || startAfter && key <= startAfter
          || ++count > MAX_AUDIT_RECORDS || !auditEntry(key, entry)) throw new Error("audit-custody-invalid-or-incomplete");
      bytes += new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      if (bytes > MAX_AUDIT_BYTES) throw new Error("audit-custody-too-large");
      if (entry.category === selection.category && entries.length < (selection.limit ?? MAX_AUDIT_RECORDS)) entries.push(entry);
      startAfter = key;
    }
    if (page.size < AUDIT_PAGE) return { complete: true, entries };
  }
}
async function auditResponse(response) {
  if (!response.ok || !response.body) throw new Error("audit-custody-unavailable");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_AUDIT_BYTES + 4096) throw new Error("audit-custody-too-large");
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch (error) { try { await reader.cancel(); } catch {} throw error; }
  finally { reader.releaseLock(); }
}
// Persist only the immutable, non-PII event facts consumed by Checkout
// receiving. A Stripe event ID cannot be reinterpreted as another amount,
// currency, payment intent or state during a retry.
function paymentClaimFacts(body, eventType) {
  return {
    sessionId: body.sessionId, type: eventType,
    offeringId: body.offeringId, requestDigest: body.requestDigest,
    amountTotal: body.amountTotal, currency: body.currency,
    stripeMode: body.stripeMode, paymentStatus: body.paymentStatus,
    status: body.status, paymentIntentId: body.paymentIntentId ?? null,
    createdAt: body.createdAt ?? null,
  };
}
function matchesPaymentCheckout(checkout, body) {
  return !!checkout && body.status === "complete"
    && checkout.offeringId === body.offeringId && checkout.requestDigest === body.requestDigest
    && checkout.amountTotal === body.amountTotal && checkout.currency === body.currency
    && checkout.stripeMode === body.stripeMode;
}
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const GIFT_ID = /^gift-[0-9a-f-]{36}$/u;
/** The one spelling of an account: its verified email, lowercased. */
export function accountOf(email) { return typeof email === "string" && EMAIL.test(email.trim()) ? email.trim().toLowerCase() : null; }

async function index(transaction, key, id) {
  const ids = (await transaction.get(key)) ?? [];
  if (!ids.includes(id)) await transaction.put(key, [...ids, id]);
}

/**
 * Cloudflare Durable Object persistence for a storefront receiver. It owns
 * immutable checkout records, payment-event admission, entitlements, and
 * Stripe receipt storage. An entitlement is either a purchase (keyed by its
 * Stripe Checkout Session id), a gift (keyed `gift-<uuid>`) or a review copy
 * (keyed `review-<uuid>`, see review-copy.mjs), and every
 * entitlement that names an account is listed under `account:<email>`, so a
 * reader's library is one read. A receiver supplies the binding and its
 * durable-object class alias; product policy remains in its catalog.
 */
export class DigitalGoodsFulfillment {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : null;
    if (request.method === "GET" && url.pathname.startsWith("/checkout/")) return reply(await this.ctx.storage.get(`checkout:${decodeURIComponent(url.pathname.slice(10))}`));
    if (request.method === "GET" && url.pathname.startsWith("/entitlement/")) return reply(await this.ctx.storage.get(`entitlement:${decodeURIComponent(url.pathname.slice(13))}`));
    if (request.method === "GET" && (url.pathname.startsWith("/account/") || url.pathname.startsWith("/grants/"))) {
      const [, kind, email] = url.pathname.split("/");
      const ids = (await this.ctx.storage.get(`${kind === "account" ? "account" : "grants"}:${accountOf(decodeURIComponent(email))}`)) ?? [];
      return reply((await Promise.all(ids.map((id) => this.ctx.storage.get(`entitlement:${id}`)))).filter(Boolean));
    }
    if (request.method === "POST" && url.pathname === "/checkout") return this.ctx.storage.transaction(async (transaction) => {
      const key = `checkout:${body.sessionId}`; const existing = await transaction.get(key);
      if (existing && !sameCheckout(existing, body)) return reply({ disposition: "conflict" }, 409);
      if (!existing) await transaction.put(key, body);
      return reply({ disposition: existing ? "duplicate" : "registered" });
    });
    if (request.method === "POST" && url.pathname === "/claim") return this.ctx.storage.transaction(async (transaction) => {
      const eventType = body.eventType ?? "checkout.session.completed";
      if (!CHECKOUT_EVENTS.includes(eventType)) return reply({ disposition: "rejected" }, 409);
      // Recurring orders never become the existing perpetual book entitlement,
      // including a direct internal claim or a retry of an older event.
      if ((await transaction.get(`checkout:${body.sessionId}`))?.mode === "subscription")
        return reply({ disposition: "rejected" }, 409);
      const claimFacts = paymentClaimFacts(body, eventType);
      const priorEvent = await transaction.get(`event:${body.eventId}`);
      if (priorEvent) {
        if (priorEvent.sessionId !== body.sessionId || priorEvent.type !== eventType)
          return reply({ disposition: "rejected" }, 409);
        if (priorEvent.claimFacts !== undefined) {
          // Complete receipts written by this revision are compared against
          // their ORIGINAL facts, not mutable Checkout or entitlement state.
          if (JSON.stringify(priorEvent.claimFacts) !== JSON.stringify(claimFacts))
            return reply({ disposition: "rejected" }, 409);
        } else {
          // Older persisted rows contain only session/type/pending. Do not
          // invent a full original payload: bound legacy retries to the
          // immutable Checkout and any already retained payment intent.
          // Legacy createdAt and other unknown facts remain unverified.
          const originalCheckout = await transaction.get(`checkout:${body.sessionId}`);
          if (!matchesPaymentCheckout(originalCheckout, body))
            return reply({ disposition: "rejected" }, 409);
          const pending = eventType === "checkout.session.completed" && body.paymentStatus === "unpaid";
          if ((priorEvent.pending === true) !== pending || (!pending && body.paymentStatus !== "paid"))
            return reply({ disposition: "rejected" }, 409);
          if (!pending) {
            const entitlement = await transaction.get(`entitlement:${body.sessionId}`);
            if (entitlement?.paymentIntentId != null && entitlement.paymentIntentId !== claimFacts.paymentIntentId)
              return reply({ disposition: "rejected" }, 409);
          }
        }
        return reply({ disposition: "duplicate" });
      }
      const checkout = await transaction.get(`checkout:${body.sessionId}`);
      const matched = matchesPaymentCheckout(checkout, body);
      if (!matched) return reply({ disposition: "rejected" }, 409);
      // Stripe may complete Checkout before an asynchronous method is paid.
      // Retain that original event without manufacturing an entitlement or
      // requiring Stripe to retry a legitimate, still-unpaid completion.
      if (eventType === "checkout.session.completed" && body.paymentStatus === "unpaid") {
        await transaction.put(`event:${body.eventId}`, { sessionId: body.sessionId, type: eventType, pending: true, claimFacts });
        return reply({ disposition: "pending" });
      }
      if (body.paymentStatus !== "paid") return reply({ disposition: "rejected" }, 409);
      const entitlementKey = `entitlement:${body.sessionId}`; const existing = await transaction.get(entitlementKey);
      // A second signed event for one Checkout is not another payment.
      // Compare the original settled payment intent BEFORE recording the new
      // event ID: an acknowledged mismatch would permanently suppress retries.
      if (existing && (existing.paymentIntentId ?? null) !== (body.paymentIntentId ?? null))
        return reply({ disposition: "rejected" }, 409);
      await transaction.put(`event:${body.eventId}`, { sessionId: body.sessionId, type: eventType, claimFacts });
      if (existing) return reply({ disposition: "duplicate-session" });
      const account = accountOf(checkout.account);
      await transaction.put(entitlementKey, { id: body.sessionId, kind: "purchase", sessionId: body.sessionId, offeringId: checkout.offeringId, goods: checkout.goods, release: checkout.release ?? null, admittedRelease: checkout.admittedRelease ?? null, account, status: "active", paymentIntentId: body.paymentIntentId ?? null, createdAt: body.createdAt ?? null });
      if (account) await index(transaction, `account:${account}`, body.sessionId);
      return reply({ disposition: "claimed" });
    });
    if (request.method === "POST" && url.pathname === "/grant") return this.ctx.storage.transaction(async (transaction) => {
      const recipient = accountOf(body?.recipientEmail); const gifter = accountOf(body?.grantedBy);
      // A review copy is a grant of its own stamped rendition with an expiry; a gift is the offering's release.
      const record = body?.kind === "review-copy" ? reviewCopyEntitlement(body, accountOf)
        : GIFT_ID.test(body?.id ?? "") && recipient && gifter && typeof body.offeringId === "string" && typeof body.release === "string"
          ? { id: body.id, kind: "gift", offeringId: body.offeringId, release: body.release, account: recipient, recipientEmail: recipient, grantedBy: gifter, note: typeof body.note === "string" ? body.note.slice(0, 1000) : "", status: "active", createdAt: body.createdAt ?? null }
          : null;
      if (!record) return reply({ disposition: "rejected" }, 400);
      const key = `entitlement:${record.id}`;
      if (await transaction.get(key)) return reply({ disposition: "duplicate" });
      await transaction.put(key, record);
      await index(transaction, `account:${record.account}`, record.id);
      await index(transaction, `grants:${record.grantedBy}`, record.id);
      return reply({ disposition: "granted" });
    });
    if (request.method === "POST" && url.pathname === "/bind") return this.ctx.storage.transaction(async (transaction) => {
      const account = accountOf(body?.account); const key = `entitlement:${body?.id}`; const existing = await transaction.get(key);
      if (!account || !existing || existing.status !== "active") return reply({ disposition: "unknown" }, 404);
      if (existing.account && existing.account !== account) return reply({ disposition: "held-by-another-account" }, 409);
      if (!existing.account) await transaction.put(key, { ...existing, account });
      await index(transaction, `account:${account}`, existing.id ?? body.id);
      return reply({ disposition: existing.account ? "duplicate" : "bound" });
    });
    if (request.method === "POST" && url.pathname === "/revoke") return this.ctx.storage.transaction(async (transaction) => {
      const id = body.id ?? body.sessionId; const existing = await transaction.get(`entitlement:${id}`);
      if (!existing || (body.paymentIntentId && existing.paymentIntentId !== body.paymentIntentId) || (body.grantedBy && existing.grantedBy !== accountOf(body.grantedBy))) return reply({ disposition: "unknown" }, 404);
      await transaction.put(`entitlement:${id}`, { ...existing, status: "revoked", revokedAt: body.revokedAt ?? null, revocationReason: body.reason ?? "withdrawn" });
      return reply({ disposition: "revoked" });
    });
    if (request.method === "POST" && url.pathname === "/audit/query") {
      if (!auditSelection(body)) return reply({ error: "strict-audit-selection-required" }, 400);
      try { return reply(await this.ctx.storage.transaction(transaction => queryAudit(transaction, body))); }
      catch { return reply({ error: "audit-custody-unavailable" }, 503); }
    }
    if (request.method === "POST" && url.pathname === "/audit") return this.ctx.storage.transaction(async (transaction) => {
      const id = body?.record?.id;
      if (typeof id !== "string" || !id) return reply({ error: "receipt-id-required" }, 400);
      const key=`audit:${id}`,existing=await transaction.get(key);
      if(existing){
        // An original signed event keeps one economic observation. Retries
        // may change local recording time, but never rewrite its provider
        // facts, category, or attributed truth.
        if(existing.category!==body.category||
          JSON.stringify(existing.record)!==JSON.stringify(body.record)||
          JSON.stringify(existing.told??null)!==JSON.stringify(body.told??null))
          return reply({error:'receipt-identity-conflict'},409);
        return reply({ok:true,duplicate:true});
      }
      await transaction.put(key,body);
      return reply({ok:true,duplicate:false});
    });
    return reply({ error: "not-found" }, 404);
  }
}

/** Creates the asynchronous client used by a Worker bound to one DO name. */
export function createDurableFulfillment(namespace, name) {
  if (!namespace || !name) return null;
  const stub = namespace.get(namespace.idFromName(name));
  const call = async (path, value) => {
    try {
      const response = await stub.fetch(`https://fulfillment${path}`, { method: "POST", body: JSON.stringify(value) });
      const body = await response.json();
      if (!body || typeof body !== "object") return { failed: true };
      if (!response.ok) return { ...body, failed: true };
      return body;
    } catch { return { failed: true }; }
  };
  const get = async (kind, id) => (await stub.fetch(`https://fulfillment/${kind}/${encodeURIComponent(id)}`)).json();
  return {
    async recordCheckout(value) { return call("/checkout", value); },
    async getCheckout(id) { return get("checkout", id); },
    async claimPayment(value) { return call("/claim", value); },
    async getEntitlement(id) { return get("entitlement", id); },
    async revokeEntitlement(value) { return call("/revoke", value); },
    async grantEntitlement(value) { return call("/grant", value); },
    async bindEntitlement(value) { return call("/bind", value); },
    async listAccount(email) { return (await get("account", email)) ?? []; },
    async listGrants(email) { return (await get("grants", email)) ?? []; },
    audit: {
      async record(entry) { const result = await call("/audit", entry); if (result.failed||result.ok!==true||typeof result.duplicate!=="boolean") throw new Error("could not record checkout receipt"); return {...entry,duplicate:result.duplicate}; },
      async query(selection) {
        if (!auditSelection(selection)) throw new TypeError("strict-audit-selection-required");
        const response = await stub.fetch("https://fulfillment/audit/query", { method: "POST", body: JSON.stringify(selection) });
        const result = await auditResponse(response);
        if (!dataRecord(result) || result.complete !== true || !Array.isArray(result.entries)
            || result.entries.length > Math.min(selection.limit ?? MAX_AUDIT_RECORDS, MAX_AUDIT_RECORDS)
            || result.entries.some(entry => entry?.category !== selection.category || !auditEntry(`audit:${entry?.record?.id}`, entry)))
          throw new Error("audit-custody-invalid-or-incomplete");
        return result.entries;
      },
    },
  };
}

