#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { renderTufteDocument } from "@red-cup-engineering/web-page-tiling-engine/rendering";
import { STOREFRONT_STYLES, storefrontCatalogModel, storefrontDetailModel } from "@red-cup-engineering/web-page-tiling-engine/storefront";

import { catalogModel, validateCatalog } from "../src/digital-goods-storefront.mjs";
import { storefrontFacets, storefrontItemFor } from "../src/storefront-presentation.mjs";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Renders one catalog into `outDir`, refusing an invalid catalog outright.
 * @param {object} catalog `{ merchant, offerings: [...] }`
 * @param {string} outDir directory to write into (created if missing)
 * @param {{checkoutArmed?: boolean}} [options]
 * @returns {Promise<string[]>} the paths written
 * @throws {Error} when the catalog fails validation
 */
export async function renderCatalogToDirectory(catalog, outDir, { checkoutArmed = false } = {}) {
  const validation = validateCatalog(catalog);
  if (!validation.valid) {
    throw new Error(`catalog is invalid: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`);
  }
  const model = catalogModel(catalog, { checkoutArmed });
  // A static page has no checkout route behind it: it states each offering's
  // honest state and links out where another site sells it.
  const items = model.offerings.map((offering) => storefrontItemFor(offering, { cover: offering.cover ?? undefined, actions: [
    offering.status === "external" ? { kind: "link", label: offering.state, href: offering.externalUrl } : { kind: "unavailable", label: offering.state },
  ] }));
  const storefront = { title: `${catalog.merchant?.name ?? "Storefront"}`, items, facets: storefrontFacets(items) };
  const styles = { styles: STOREFRONT_STYLES };
  await mkdir(outDir, { recursive: true });
  const written = [];
  const indexPath = join(outDir, "index.html");
  await writeFile(indexPath, renderTufteDocument(storefrontCatalogModel(storefront, { itemHref: (id) => `${id}.html`, search: false }), styles), "utf8");
  written.push(indexPath);
  for (const offering of model.offerings) {
    const offeringPath = join(outDir, `${offering.id}.html`);
    await writeFile(offeringPath, renderTufteDocument(storefrontDetailModel(storefront, offering.id, { catalogHref: "index.html" }), styles), "utf8");
    written.push(offeringPath);
  }
  return written;
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "render-catalog", description: "Renders one catalog into `outDir`, refusing an invalid catalog outright.", operation: renderCatalogToDirectory }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
