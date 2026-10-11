# digital-goods-storefront-services-section

The house digital-goods storefront: checkout-model, delivery, and receipt
semantics usable by every product line (ebooks, newsletters, cohort, merch,
briefing). It composes payment rails rather than re-implementing them —
the card rail is `@red-cup-engineering/stripe-services-section`, pinned
exactly — and derives Stripe's fixed-offerings shape from this package's
own catalog, so the catalog is the one source of truth.

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
