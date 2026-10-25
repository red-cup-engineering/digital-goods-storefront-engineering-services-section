import { digest } from "@red-cup-engineering/stripe-services-section";
import { stripeOfferingFor } from "./digital-goods-storefront.mjs";

const EVENT_CATEGORY = "stripe-webhook-event-admission.events";
const CHECKOUT_CATEGORY = "stripe-checkout-session-creation.receipts";
const SUBSCRIPTION = /^sub_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/u;
const bindingFields = ["requestDigest", "offeringId", "customerSettlement"];
export const subscriptionOrderRefusal = reason => ({ type: "StorefrontSubscriptionOrderRefusal", reason });
function selectionOf(value) {
  return value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === 1 && Object.hasOwn(Object.getOwnPropertyDescriptor(value, "subscriptionId") ?? {}, "value")
    && typeof value.subscriptionId === "string" && value.subscriptionId.length <= 200 && SUBSCRIPTION.test(value.subscriptionId);
}
/** The authenticated account comes only from the original host reader. This
 * projection joins existing order custody; it neither reads current provider
 * billing nor supplies rights, access periods or an entitlement. */
export async function readSubscriptionOrderBinding(selection, { account, buyerActor, catalog, fulfillment, audit }) {
  if (!selectionOf(selection)) return subscriptionOrderRefusal("invalid-subscription-selector");
  if (!account) return subscriptionOrderRefusal("authenticated-reader-required");
  if (!fulfillment || typeof fulfillment.getCheckout !== "function" || !audit || audit !== fulfillment.audit
      || typeof audit.query !== "function") return subscriptionOrderRefusal("original-order-custody-unavailable");
  try {
    const subscriptionId = selection.subscriptionId;
    const events = (await audit.query({ category: EVENT_CATEGORY, strict: true })).map(entry => entry.record);
    const related = events.filter(record => record.subscriptionId === subscriptionId || record.stripeObjectId === subscriptionId
      || record.stripeSubscriptionIdsObserved?.includes(subscriptionId));
    const identities = new Set(related.map(record => record.stripeEventId));
    const originalIdentities = events.filter(record => identities.has(record.stripeEventId));
    if (originalIdentities.some(record => record.conflict === true || record.subscriptionBindingStatus === "conflicting"))
      return subscriptionOrderRefusal("subscription-binding-conflict");
    const bound = related.filter(record => record.type === "StripeWebhookEventReceipt" && record.supported === true
      && record.signatureVerified === true && record.livemode === true && record.subscriptionBindingStatus === "bound"
      && record.subscriptionId === subscriptionId);
    if (!bound.length) return subscriptionOrderRefusal("signed-original-subscription-binding-required");
    const binding = bound[0];
    if (binding.customerSettlement !== buyerActor || bound.some(record => bindingFields.some(field => record[field] !== binding[field]))
        || related.some(record => bindingFields.some(field => record[field] != null && record[field] !== binding[field])
          || record.subscriptionId != null && record.subscriptionId !== subscriptionId))
      return subscriptionOrderRefusal("subscription-binding-conflict");
    const receipts = (await audit.query({ category: CHECKOUT_CATEGORY, strict: true })).map(entry => entry.record)
      .filter(record => record.requestDigest === binding.requestDigest);
    if (!receipts.length || receipts.some(record => record.type !== "StripeCheckoutSessionReceipt"
        || record.customerSettlement !== buyerActor || record.offeringId !== binding.offeringId
        || record.legalMerchant !== catalog.merchant?.legalBody || record.stripeMode !== "live")
        || new Set(receipts.map(record => record.stripeSessionId)).size !== 1)
      return subscriptionOrderRefusal("original-checkout-binding-required");
    const receipt = receipts[0], checkout = await fulfillment.getCheckout(receipt.stripeSessionId);
    if (!checkout || checkout.sessionId !== receipt.stripeSessionId || checkout.account !== account
        || checkout.mode !== "subscription" || checkout.buyerActor !== buyerActor || checkout.stripeMode !== "live"
        || checkout.requestDigest !== binding.requestDigest || checkout.offeringId !== binding.offeringId
        || checkout.request?.offeringId !== binding.offeringId || checkout.offering?.id !== binding.offeringId
        || checkout.offering.mode !== "subscription" || checkout.request?.quantity !== 1
        || digest({ actor: buyerActor, request: checkout.request, offering: checkout.offering }) !== binding.requestDigest)
      return subscriptionOrderRefusal("authenticated-original-checkout-required");
    const offerings = catalog.offerings.filter(item => item.id === binding.offeringId);
    if (offerings.length !== 1 || offerings[0].mode !== "subscription" || offerings[0].status !== "live"
        || digest(stripeOfferingFor(offerings[0])) !== digest(checkout.offering))
      return subscriptionOrderRefusal("original-authored-contract-changed-or-unavailable");
    return { type: "StorefrontSubscriptionOrder", subscriber: account, stripeSessionId: checkout.sessionId,
      contractRef: checkout.offering.contractRef, contractRevision: checkout.offering.contractRevision,
      billingInput: { authenticatedActor: buyerActor, subscriptionId, requestDigest: binding.requestDigest, offeringId: binding.offeringId } };
  } catch { return subscriptionOrderRefusal("original-order-custody-unavailable"); }
}
