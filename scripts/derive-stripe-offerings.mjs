#!/usr/bin/env node
import { stripeOfferingFor, validateCatalog } from "../src/digital-goods-storefront.mjs";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Derives the Stripe offerings shape from a catalog, refusing an invalid
 * catalog outright. Only `live`/`test-only` offerings are carried over —
 * an `external` or `coming-soon` offering has no meaningful Stripe form.
 * @param {object} catalog `{ merchant, offerings: [...] }`
 * @returns {{merchant: object, offerings: object[]}}
 * @throws {Error} when the catalog fails validation
 */
export function deriveStripeOfferings(catalog) {
  const validation = validateCatalog(catalog);
  if (!validation.valid) {
    throw new Error(`catalog is invalid: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`);
  }
  const offerings = catalog.offerings
    .filter((offering) => offering.status === "live" || offering.status === "test-only")
    .map((offering) => stripeOfferingFor(offering));
  return { merchant: catalog.merchant, offerings };
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "derive-stripe-offerings", description: "Derives the Stripe offerings shape from a catalog, refusing an invalid catalog outright.", operation: deriveStripeOfferings }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
