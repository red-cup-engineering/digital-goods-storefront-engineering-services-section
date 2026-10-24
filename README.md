# digital-goods-storefront-services-section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

The house digital-goods storefront: checkout-model, delivery, and receipt
semantics usable by every product line (ebooks, newsletters, cohort, merch,
briefing). It composes payment rails rather than re-implementing them —
the card rail is `@red-cup-engineering/stripe-services-section`, pinned
exactly — and derives Stripe's fixed-offerings shape from this package's
own catalog, so the catalog is the one source of truth.

## Source language in search and retailer listings

An offering's optional `book.language` is a BCP 47 language tag describing
the **book's actual content**, not the language of the storefront interface.
Set it only from accepted publisher metadata; for example, `es-MX` or
`zh-Hant-TW`. The original `bookLanguageTag` operation uses JavaScript
`Intl.getCanonicalLocales`, and catalog validation refuses malformed tags.
Existing source records without a declared language retain the pre-existing
English default. Schema.org `Book.inLanguage` and each retailer's English
language-name field consume that same book source. The conversion does not
translate the book, establish an external retailer listing, enable card
checkout, or qualify for Google's distinct Book Actions data-feed program.

## What lives here

- `src/digital-goods-storefront.mjs` — pure domain semantics, Web Crypto
  only: catalog validation (`validateCatalog`; an offering delivers listed
  `goods` or a paid `release`), the view model (`catalogModel`, which never
  grants a buy affordance the caller hasn't honestly declared armed), the
  Stripe-offering projection (`stripeOfferingFor`), signed and expiring
  download tokens, and no-PII receipts (`receiptFor`).
- `src/storefront-presentation.mjs` — each offering as a TUFTE storefront
  item: price, formats, length, contents, the verification record (edition
  digest, file SHA-256s, the independent proof's counts) and schema.org
  data. TUFTE renders it; this package has no HTML renderer of its own.
- `src/paid-release.mjs` — delivery of one accepted bundle named by a
  release pointer in the goods bucket, shared by card purchases, gifts and
  the x402 market.
- `src/review-copy.mjs` — review copies, Web Crypto only: one reader's
  free copy of the ebook section's `advance-reader-v1` rendition, stamped
  for that grant. Unlike a gift it is not the paid release: it may be
  given while the offering is coming soon, it expires when the reading
  window closes, and it is delivered only when its staged pointer
  (`goods/<offering>/review-copies/<grant>/pointer.json`), its entitlement
  and its bytes agree on one digest. `referencedReviewCopyId` derives the
  grant from the giver and a reference, so one invitation names one copy.
- `src/durable-fulfillment.mjs` — the Durable Object: immutable checkout
  records, payment admission, entitlements (purchases, gifts and review copies), an index
  of each account's entitlements and each gifter's gifts, binding a
  purchase to an account, and revocation.
- `src/worker-runtime.mjs` — a receiver's Worker: the TUFTE storefront
  (catalog, product pages), card checkout, the Stripe webhook, delivery,
  reader sign-in through the web server's Google admission (any verified
  Google account; an account is its email), a library per account, gift
  links, a gifts page for the emails the receiver names, and a JSON gift
  API (`/api/gifts`) for a house agent holding the receiver's gift-agent
  key (`env.giftAgent = {key, as}`; the key is compared in constant time,
  and a request's `reference` derives the gift id, so a repeat is a
  `duplicate`, never a second gift), review-copy links
  (`/review-copies/:id`, which state the review terms) and the review-copy
  API (`/api/review-copies`, same key), which records a copy only once its
  stamped rendition is staged under the grant.
- `scripts/` — one operation per effect: `validate-catalog.mjs`,
  `render-catalog.mjs` (static TUFTE pages), `issue-download-token.mjs`,
  `derive-stripe-offerings.mjs`, `stage-paid-release.mjs`,
  `stage-review-copy.mjs` (one reader's stamped copy and its pointer).
- `apps/storefront-cli.mjs` — the composed CLI face; its `render`/`model`
  commands read whether checkout is actually armed from
  stripe-services-section's own `readiness()` rather than deciding that
  locally.

The design is in `engineering-services-section/content/text/documents/articles/notes/2026/09/27/2026-09-27-note-on-the-human-storefront.md`.

## Buyer-specific commissioned-work contract — qualified demand, NOT implemented

The existing `src/paid-release.mjs` publishes **one immutable edition per
offering**, by `goods/<offeringId>/release.json`. The existing
`src/durable-fulfillment.mjs` stores checkout sessions, verified payment
events, account-bound grants and revocations; it does **not** contract, execute,
track or deliver buyer-specific work. Neither mechanism may be represented as
a working personalized review, commissioned illustration, report or other
made-to-order purchase. In particular, changing the offering-wide release
pointer for each customer's output would disclose or substitute another
customer's purchased result. Preserve fixed-goods delivery unchanged.

**Demand and current first consumer:** Causeway Public Games proposes selling
one recoverable Deep Review of a verified 9×9 or 13×13 Go game at a **test
price** of $2.99. Its original customer requirement and Red Cup's
`weiqi-commercial-game-srs.md` (WG-SRS-008/009/013) and game HLD/LLD are
candidate inputs, not independent admission. This is a reusable **commerce
supplier requirement**, not a request for Weiqi to implement payment,
entitlement, title or job scheduling locally. Another valid consumer would
be one named buyer's commissioned creator/research deliverable, whose unique
content must likewise never appear as another buyer's fixed release.

Before an offer is armed, the source-owning Web Commerce engineer shall
independently admit a distinct SRS, architecture and detailed design for
commissioned work through the normal requirements → SRS → HLD → LLD →
native Data/Code fabrication process. These are the necessary **behavioral
contracts** for that admission; this README does not constitute admission
and authorizes no new endpoint, code or live sale:

1. **Offer/capacity.** One authorized merchant shall name its actual payable
   price, currency, beneficiary terms, service-level remedy, cancellation/
   refund policy, rights and territories, immutable work-input eligibility,
   licensed production capability, bounded resource/latency budget and
   evidence of presently reservable capacity. An unfunded, unlicensed,
   unavailable or nonpositive-contribution offer refuses charging rather
   than taking payment for unfulfillable work.
2. **Distinct identities.** A durable commissioned-work identity shall bind
   the exact source/input digest and version, buyer principal, merchant,
   quoted offer revision, Stripe Checkout Session, approved production
   specification and delivery entitlement. The checkout identity is **not**
   the source game identity, worker attempt, payment-event ID or generated
   result digest. A repeat exact intent can recover its original work;
   reusing any identity with a different buyer, input, merchant, price or
   requested effect refuses.
3. **Shared payment and fulfillment authority.** The existing verified
   Stripe checkout/claim semantics and the **same** durable-fulfillment
   authority shall bind payment to exactly one customer-specific obligation.
   A browser redirect, payment-event duplicate or bare downloadable SKU
   never starts an authorized paid entitlement. One work has at most one
   active paid right; provider retries, cancellation and refund cannot
   mint additional work or customer access. Preserve gift, fixed release,
   review-copy and legacy checkout contracts without interpreting them as
   commissioned-work grants.
4. **Execution and result.** A qualified process-capable supplier accepts a
   bounded job carrying immutable, authenticated input, actual model/tool
   provenance, commercial rights and resource ceiling. It may retry after
   crashes, but an accepted work can publish **one authoritative
   content-identified result**, after the domain's correctness and
   completeness assay. Do not equate exactly-once publication with
   exactly-once external computation. A work can be honestly pending,
   fulfilled, canceled, refund-pending or failed; a timeout remains
   uncertain until the original work and provider effect are read back.
   Neither an unconfirmed worker response nor a staged empty pointer
   counts as fulfillment.
5. **Private delivery and recovery.** The existing buyer identity/
   entitlement verifier shall authorize retrieval of the exact result
   through a second independent session. A result is referenced by its
   commissioned-work identity and immutable content digest, **never**
   through the offering-wide `release.json`. Storage and private result
   access must refuse another authenticated buyer, guessed work ID, swapped
   result digest, revoked grant, refunded charge and an old authorization;
   a public bucket path or generic download token cannot bypass the
   entitlement. The customer can revisit/export the accepted output
   without purchasing another copy.
6. **Economic and operator receiving.** Reconcile provider-confirmed gross
   receipts, refunds, fee/chargeback, licensed production cost, job CPU/
   model/network/storage, support and rights expense against the same
   merchant order and commission. Distinguish reserved work, executed
   work, actual customer retrieval and money settlement. Never count a
   sample result, forged account, test charge, configured provider or
   source test as an independently delivered sale or positive profit.

**Mandatory counterexamples before native fabrication:** two buyers of the
same SKU must receive two distinct correct private outputs; an exact
checkout/webhook replay must create no second charge/work/grant; a repeat
identifier with different customer/input must refuse; a forged, missing or
refunded payment must create no usable result; a crash between external
execution and publication must reattach to its original work; a failed job
must resolve through the original financial obligation; a fixed EPUB/PDF
purchase must still resolve its original offering-wide immutable edition;
a distinct non-Weiqi commissioned customer must use the **same** shared
supplier contract. Test caller identity at the actual Worker/DO boundary,
not merely a browser view. The first Weiqi commercial receiving additionally
requires a real completed legal match, paid review, immutable delivered
report, second-device reopen and independently reconciled net contribution.

**Stage boundary:** this is an upstream supplier contract correction only.
`src/durable-fulfillment.mjs`, `src/paid-release.mjs`, the static Go PWA
and all installed payment providers remain unchanged; no new commissioned
work, profitable sale, backend admission or deployed effect is claimed.
Source integration and live buyer receiving remain explicit subsequent
obligations owned by competent Engineering, Operations and Public offices.

## Authenticated external Stripe Payment Link events, without false merchandise sales

The original `src/stripe-checkout-fulfillment.mjs#fulfillStripeCheckoutWebhook` owns the actual Shop webhook receiver. Not every `checkout.session.completed` is a book-store Checkout: Stripe-hosted Payment Links make sessions without a prior `recordCheckout` in the Shop's Durable Object. Previously those signed provider observations reached `claimPayment`, failed its real book-offering/request-digest requirement, and received HTTP 409. Do **not** weaken this requirement to issue an undeserved book entitlement.

This source's narrow `externalPaymentLinks` receiving option admits only bounded, unique Stripe Payment Link **IDs explicitly selected by the Shop operator**. An event must first pass the original raw-body Stripe HMAC verifier and its body-size bound. A matching Checkout receives a redacted, versioned `StripeExternalPaymentLinkObservation` in the **existing** `env.audit.record` Durable Object sink; the record contains the actual provider event/session/link IDs, observed gross amount/currency/payment status and source time, never customer email, raw event, private metadata, copyrighted content, book-rights or a claim of net/settled 561 Group cash. Unknown links, malformed source identities and absent durable audit refuse without creating checkout registrations or goods. The original book Checkout path remains unchanged.

The original `DigitalGoodsFulfillment` `/audit` now receives immutable same-ID economic facts transactionally: retries of the same source event report `duplicate:true` and keep the first stored receipt; an incompatible same-ID record refuses with 409 instead of replacing signed financial history. The returned `SUPPORTS_EXTERNAL_STRIPE_PAYMENT_LINK_AUDIT` export is surfaced by the actual `./worker-runtime` package entry, so Shop can distinguish installed support from a source-only Git branch. This is an observation, not a subscription, paid invoice, refund, royalty, payout or treasury settlement.

The existing native `test/stripe-checkout-fulfillment.test.mjs` and `test/durable-fulfillment.test.mjs` own positive and adverse signed-wire/durable-receiving checks and are listed as mandatory `receivingTests` in the original npm carrier. **The manifest remains at version 0.4.4**; a real versioned immutable registry release and dependent Shop installation must be separately observed. The existing live Stripe webhook is configured only for `checkout.session.completed`, so invoices and recurring renewals require their own authorized event-scope and receipt service; no source edit silently changes that provider setting.

## Five-custody thread

- **Science**: none — this is applied checkout/delivery engineering, not
  a formalized theory.
- **Engineering**: this section.
- **Operations**: a Cloudflare Worker, a Durable Object (checkouts,
  entitlements, accounts) and R2 (goods and release pointers) per site that
  composes this package.
- **561-Group**: the seat decision this section realizes —
  `561-group-enterprise-project-management-services-section/data/records/2026-09-01-house-commerce-platform-seat-question.json`.
- **Public**: `public-services-section/services/public-resources-services-section/services/public-consumer-resources-services-section/sites/shop.561.group`.

## Roadmap

The meet-gap list (checkout, delivery, tax handling, affiliates) this
storefront is closing against is in the first ebook's own offer note —
`artificial-intelligence-education-curriculum-services-section/content/
text/documents/articles/notes/2026/08/31/2026-08-31-note-offering-the-
agent-operators-handbook-ebook.md` — not copied here; read it there.

## Testing

```sh
npm test
```

Plain `node --test`, no framework.
