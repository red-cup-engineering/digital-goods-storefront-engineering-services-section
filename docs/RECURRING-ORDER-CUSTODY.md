# Recurring order custody in the original storefront

## Receiving scenario

The same signed-in Shop reader who started an authored recurring Checkout can
recover its original order binding for the original Stripe billing reader. A
different reader, an unsigned event, an incomplete journal, or a changed
contract cannot select that order. One-time purchases, gifts and downloads
retain their existing interpretation.

This component supplies an order relation, not a content entitlement. The
merchant still owns the authored contract, Newswire resource and query profiles,
source rights, current billing qualification and independent editorial release.
No Koios price, paid product, customer, right or production configuration is
created by this source change.

## Allocated guarantees

R1. An authored offering may select `mode: "subscription"` and Stripe's original
`recurring: {interval, intervalCount?}`. Omitted mode means the existing one-time
payment. A recurring offering requires `contractRef` and an immutable
`contractRevision` (`ni:///sha-256;…`); neither is a grant. It cannot also select
perpetual goods or a paid-release download. Invalid/mixed forms are refused.
Public machine and human views disclose the authored interval. The original
Stripe offering projection retains contract identity so the original order
digest binds that exact agreement. Missing tax/refund/merchant terms remain
missing and the original Stripe live admission still refuses them.

R2. A recurring Checkout requires the original authenticated Google reader and
the original fulfillment/audit capabilities before any provider invocation. Its
durable Checkout record retains the normalized verified account, the exact
host `buyerActor`, the original request and Stripe offering projection. The
account is not the Stripe actor or customer ID. A retry cannot replace any of
these bindings. Existing one-time Checkout records need no migration.

R3. `createDurableFulfillment(...).audit.query({category, limit?, strict:true})`
reads the existing `audit:` namespace, using the original Durable Object
transaction/list API. The only query categories are the original Stripe
Checkout receipts and webhook events. All retained audit rows are checked
before category filtering, including key/id and category/type correspondence.
Event completeness is admitted by original Stripe 0.2.1's shared
`isCompleteEventReceipt` export, derived from its own `projectEvent` field set.
The storefront keeps no copied native event schema. Missing dispute/charge or
credit-note/invoice relations, invalid relation values or a missing native
event-content digest refuse the whole read; explicit native nulls,
unrelated events and the original nonbinding external-support variant retain
their distinct meaning. Stripe's billing journal independently enforces that
same completeness rule before selecting related records.
Malformed, misplaced, oversized or incomplete custody refuses the read. Fixed
record, byte and per-list bounds apply; no new index, ledger or store is used.
The complete scan is limited to 2,048 original rows and 2 MiB of serialized
envelopes, fetched in pages of at most 64; exceeding either bound refuses, even
when a caller requests fewer returned rows. The client also bounds response
bytes and requires an explicit complete result. This is structural validation
of the trusted original Durable Object's custody, not cryptographic proof
against arbitrary storage rewriting. An absent entire record cannot be detected
from this store's existing contents. Legacy incomplete rows are not silently
upgraded into qualified recurring evidence.

R4. Only a storefront with an authored recurring offering enables recurring
event receiving. Its existing signed webhook delegates to original Stripe
`ingestWebhook`, retaining native event/conflict receipts in the same audit
store. Subscription Checkout completion never enters the perpetual purchase
grant path. Subscription, invoice, refund, dispute and credit-note observations
are evidence for the original billing reader; no event alone grants access.
Existing outside-catalog support observations and one-time grants stay distinct.

R5. The host-only `runtime.readSubscriptionOrder(request, {subscriptionId}, env)`
uses the same original reader authentication as `fetch`. Selectors cannot
provide an account, actor, order, offering, path or contract. It joins one
unambiguous signed native subscription binding to the original Checkout receipt
and original checkout account, recomputes the original order digest, and checks
the unchanged authored offering/contract. It returns only a private
`StorefrontSubscriptionOrder` with the authenticated subscriber, original
Checkout session, contract reference/revision and exact `billingInput` for
Stripe `resolveSubscriptionAccess`. It creates no HTTP route or access grant.
Unknown/legacy/unbound orders and contradictory evidence return a typed refusal.

R6. The receiving host must pass the resulting `billingInput` to original
Stripe 0.2.1 with this same audit store, source-owned merchant/catalog, actual
merchant account and restricted read credential. It must then independently
admit the original contract's Newswire scope and source rights, and repeat the
original authentication/order/billing/rights reads before delivery. An order
read is not proof that its subscription is active or paid. Billing revision
and validity remain Stripe's; contract scopes never come from event metadata.

## Native receiving and remaining environment obligations

`test/recurring-order.test.mjs` exercises the original Worker, authentication,
Stripe Checkout producer, HMAC receiver, Durable Object class/client and billing
reader with explicit inert provider/storage fixtures. The retained original
catalog, Worker, durable fulfillment and signed Checkout suites cover one-time
compatibility, account/gift custody, revocation and exact retry behavior.

The transaction/list fixture follows the original provider contract:
https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/
Native Node receiving is not Cloudflare installation or live Stripe delivery.
The original merchant must supply a real authored recurring contract, current
content rights, exact published packages and the ordinary installed-host
receiving before offering a paid Koios product.
