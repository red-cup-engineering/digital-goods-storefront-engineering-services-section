import { CHECKOUT_EVENTS } from "@red-cup-engineering/stripe-services-section/checkout-events";
import { projectEvent, verifyStripeSignature } from "@red-cup-engineering/stripe-services-section";

const MAX_STRIPE_WEBHOOK_BYTES = 1024 * 1024;
function json(value, status = 200) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function supportsStore(store) { return store && ["recordCheckout", "getCheckout", "claimPayment", "getEntitlement"].every((name) => typeof store[name] === "function"); }

/** Fulfill either immediate or delayed paid Checkout completion through the same verified, idempotent store. */
export async function fulfillStripeCheckoutWebhook(request, env) {
    if (!supportsStore(env.fulfillment)) return json({ error: "fulfillment-store-unavailable" }, 503);
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_STRIPE_WEBHOOK_BYTES) return json({ error: "stripe-webhook-body-too-large" }, 413);
    if (!verifyStripeSignature({ rawBody, signatureHeader: request.headers.get("stripe-signature") ?? "", secret: env.STRIPE_WEBHOOK_SECRET })) return json({ error: "invalid-or-stale-stripe-signature" }, 400);
    let event; try { event = JSON.parse(rawBody); } catch { return json({ error: "invalid-json" }, 400); }
    if (!CHECKOUT_EVENTS.includes(event?.type)) return json({ accepted: true });
    const projection = projectEvent(event);
    if (!projection.stripeEventId || !projection.stripeObjectId || typeof projection.livemode !== "boolean") return json({ error: "payment-does-not-match-checkout-intent" }, 409);
    const result = await env.fulfillment.claimPayment({ eventId: projection.stripeEventId, eventType: projection.eventType, sessionId: projection.stripeObjectId, offeringId: projection.offeringId, requestDigest: projection.requestDigest, amountTotal: projection.amountTotal, currency: projection.currency, paymentStatus: projection.paymentStatus, status: projection.status, stripeMode: projection.livemode ? "live" : "test", paymentIntentId: projection.paymentIntentId, createdAt: projection.created });
    const claimed = typeof result === "string" ? result : result?.disposition;
    if (claimed === "rejected") return json({ error: "payment-does-not-match-checkout-intent" }, 409);
    if (!["claimed", "duplicate", "duplicate-session"].includes(claimed)) return json({ error: "fulfillment-store-unavailable" }, 503);
    return json({ accepted: true, duplicate: claimed === "duplicate" || claimed === "duplicate-session" });
  }

