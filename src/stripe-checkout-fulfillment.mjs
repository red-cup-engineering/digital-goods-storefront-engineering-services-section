import { CHECKOUT_EVENTS } from "@red-cup-engineering/stripe-services-section/checkout-events";
import { projectEvent, verifyStripeSignature } from "@red-cup-engineering/stripe-services-section";

const MAX_STRIPE_WEBHOOK_BYTES = 1024 * 1024;
function json(value, status = 200) { return Response.json(value, { status, headers: { "cache-control": "no-store" } }); }
function supportsStore(store) { return store && ["recordCheckout", "getCheckout", "claimPayment", "getEntitlement"].every((name) => typeof store[name] === "function"); }

/** The Stripe signature covers the exact UTF-8 body. Read it once with a
 * byte bound *while streaming*; request.text() reads arbitrarily large bodies
 * before any post-read limit can protect the fulfillment receiver. */
async function boundedStripeWebhookText(request) {
  const reader = request.body?.getReader();
  if (!reader) return { text: "" };
  // Preserve leading BOM bytes through signature validation; JSON admission is separate.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let totalBytes = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STRIPE_WEBHOOK_BYTES) {
        await reader.cancel();
        return { error: "stripe-webhook-body-too-large", status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode() };
  } catch (cause) {
    try { await reader.cancel(); } catch { /* body already closed */ }
    return cause instanceof TypeError
      ? { error: "invalid-json", status: 400 }
      : { error: "stripe-webhook-body-unavailable", status: 503 };
  } finally { reader.releaseLock(); }
}

/** Fulfill either immediate or delayed paid Checkout completion through the same verified, idempotent store. */
export async function fulfillStripeCheckoutWebhook(request, env) {
    if (!supportsStore(env.fulfillment)) return json({ error: "fulfillment-store-unavailable" }, 503);
    const received = await boundedStripeWebhookText(request);
    if (received.error) return json({ error: received.error }, received.status);
    const rawBody = received.text;
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

