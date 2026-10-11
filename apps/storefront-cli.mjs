#!/usr/bin/env node
/**
 * Composed CLI face over the digital-goods storefront: validate a catalog,
 * render it to static HTML, derive the Stripe fixed-offerings shape, and
 * issue a download token. `checkoutArmed` for `render`/`model` is read
 * honestly from the card rail's own readiness (`@red-cup-engineering/
 * stripe-services-section`'s `readiness()`) unless a caller overrides it —
 * composing the rail, never re-deciding what "armed" means locally.
 */
import { readFileSync } from "node:fs";

import { readiness } from "@red-cup-engineering/stripe-services-section";

import { validateCatalogFile } from "../scripts/validate-catalog.mjs";
import { renderCatalogToDirectory } from "../scripts/render-catalog.mjs";
import { deriveStripeOfferings } from "../scripts/derive-stripe-offerings.mjs";
import { issueDownloadTokenFromEnv } from "../scripts/issue-download-token.mjs";
import { catalogModel } from "../src/digital-goods-storefront.mjs";

/**
 * Whether the card rail can actually accept a live charge right now, per
 * stripe-services-section's own readiness check.
 * @returns {boolean}
 */
function stripeCheckoutArmed() {
  try {
    return readiness().liveReady;
  } catch {
    return false;
  }
}

function resolveArmed(args) {
  if (args.includes("--armed")) return true;
  if (args.includes("--unarmed")) return false;
  return stripeCheckoutArmed();
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "validate") {
    const [catalogPath] = rest;
    if (!catalogPath) throw new Error("usage: storefront-cli.mjs validate <catalog.json>");
    const { catalog, result } = validateCatalogFile(catalogPath);
    if (result.valid) {
      console.log(`${catalogPath}: valid (${catalog.offerings.length} offerings)`);
      return;
    }
    console.error(`${catalogPath}: invalid`);
    for (const error of result.errors) console.error(`  ${error.path}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (command === "model") {
    const [catalogPath] = rest;
    if (!catalogPath) throw new Error("usage: storefront-cli.mjs model <catalog.json> [--armed|--unarmed]");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const checkoutArmed = resolveArmed(rest);
    console.log(JSON.stringify(catalogModel(catalog, { checkoutArmed }), null, 2));
    return;
  }

  if (command === "render") {
    const [catalogPath, outDir] = rest;
    if (!catalogPath || !outDir) throw new Error("usage: storefront-cli.mjs render <catalog.json> <out-dir> [--armed|--unarmed]");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const checkoutArmed = resolveArmed(rest);
    const written = await renderCatalogToDirectory(catalog, outDir, { checkoutArmed });
    for (const path of written) console.log(`wrote ${path}`);
    return;
  }

  if (command === "derive-stripe") {
    const [catalogPath] = rest;
    if (!catalogPath) throw new Error("usage: storefront-cli.mjs derive-stripe <catalog.json>");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    console.log(JSON.stringify(deriveStripeOfferings(catalog), null, 2));
    return;
  }

  if (command === "token") {
    const [offeringId, sessionId, ttlArg] = rest;
    if (!offeringId || !sessionId) throw new Error("usage: storefront-cli.mjs token <offering-id> <session-id> [ttl-seconds]");
    const ttlSeconds = ttlArg ? Number(ttlArg) : 3600;
    const { token, expiresAt } = await issueDownloadTokenFromEnv({ offeringId, sessionId, ttlSeconds });
    console.log(token);
    console.error(`expires ${new Date(expiresAt).toISOString()}`);
    return;
  }

  throw new Error(`unknown command "${command}". commands: validate, model, render, derive-stripe, token`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
