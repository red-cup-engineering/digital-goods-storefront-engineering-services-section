import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateCatalogFile } from "../scripts/validate-catalog.mjs";
import { renderCatalogToDirectory } from "../scripts/render-catalog.mjs";
import { deriveStripeOfferings } from "../scripts/derive-stripe-offerings.mjs";
import { issueDownloadTokenFromEnv } from "../scripts/issue-download-token.mjs";
import { verifyDownloadToken } from "../src/digital-goods-storefront.mjs";

const CATALOG = {
  merchant: { name: "561 Group", legalBody: "emsenn" },
  offerings: [
    {
      id: "agent-operators-handbook",
      title: "The Agent Operator's Handbook",
      blurb: "A field guide.",
      line: "artificial-intelligence-education-curriculum-services-section",
      status: "live",
      priceCents: 2900,
      currency: "usd",
      goods: [{ name: "EPUB", key: "handbook.epub", contentType: "application/epub+zip", byteLength: 1024, sha256: "a".repeat(64) }],
    },
    { id: "next-book", title: "Next Book", line: "some-line", status: "coming-soon" },
  ],
};

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "digital-goods-storefront-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("validateCatalogFile reads and validates a catalog from disk", () => {
  withTempDir((dir) => {
    const path = join(dir, "catalog.json");
    writeFileSync(path, JSON.stringify(CATALOG), "utf8");
    const { catalog, result } = validateCatalogFile(path);
    assert.equal(result.valid, true);
    assert.equal(catalog.offerings.length, 2);
  });
});

test("renderCatalogToDirectory writes an index page and one page per offering", async () => {
  await withTempDir(async (dir) => {
    const outDir = join(dir, "out");
    const written = await renderCatalogToDirectory(CATALOG, outDir, { checkoutArmed: true });
    assert.equal(written.length, 3);
    const index = readFileSync(join(outDir, "index.html"), "utf8");
    assert.match(index, /The Agent Operator&#39;s Handbook/);
    const product = readFileSync(join(outDir, "agent-operators-handbook.html"), "utf8");
    assert.match(product, /\$29\.00/);
    assert.doesNotMatch(product, /<script/);
  });
});

test("renderCatalogToDirectory refuses an invalid catalog", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => renderCatalogToDirectory({ merchant: {}, offerings: [{ id: "x", title: "X", line: "l", status: "live" }] }, join(dir, "out")),
      /catalog is invalid/,
    );
  });
});

test("deriveStripeOfferings carries over only live/test-only offerings", () => {
  const derived = deriveStripeOfferings(CATALOG);
  assert.equal(derived.offerings.length, 1);
  assert.equal(derived.offerings[0].id, "agent-operators-handbook");
  assert.equal(derived.offerings[0].unitAmount, 2900);
});

test("issueDownloadTokenFromEnv reads the secret from env and round-trips with verifyDownloadToken", async () => {
  const env = { DIGITAL_GOODS_DOWNLOAD_SECRET: "env-secret" };
  const now = Date.parse("2026-09-02T00:00:00Z");
  const { token, expiresAt } = await issueDownloadTokenFromEnv({ env, offeringId: "agent-operators-handbook", sessionId: "cs_1", ttlSeconds: 60, now });
  assert.equal(expiresAt, now + 60_000);
  const result = await verifyDownloadToken({ secret: env.DIGITAL_GOODS_DOWNLOAD_SECRET, token, now: now + 1000 });
  assert.equal(result.valid, true);
});

test("issueDownloadTokenFromEnv throws without the env secret", async () => {
  await assert.rejects(() => issueDownloadTokenFromEnv({ env: {}, offeringId: "x", sessionId: "y" }), /DIGITAL_GOODS_DOWNLOAD_SECRET/);
});
