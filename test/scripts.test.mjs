import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateCatalogFile } from "../scripts/validate-catalog.mjs";
import { renderCatalogToDirectory } from "../scripts/render-catalog.mjs";
import { deriveStripeOfferings } from "../scripts/derive-stripe-offerings.mjs";
import { issueDownloadTokenFromEnv } from "../scripts/issue-download-token.mjs";
import { verifyDownloadToken } from "../src/digital-goods-storefront.mjs";
import { deriveRetailListings, retailerSubmissionDraftResource } from "../scripts/derive-retail-listings.mjs";
import { retailListings } from "../src/retail-listings.mjs";
import { validateJsonSchema } from "@red-cup-engineering/json-schema-services-section/validation";
import schema from "../schema/retailer-submission-draft-collection.schema.json" with { type: "json" };

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

test("retailer submission resource replaces opaque output keys with scoped producer/consumer fields", () => {
  const listed = [{
    id: "book-1", title: "A Book",
    listings: [{
      channel: "kdp", name: "Amazon Kindle", fields: { title: "A Book", author: "Test Author", publisher: "Test Publisher", language: "English", description: "A source-qualified book.", subjects: [], listPriceUsd: "9.00", files: [], cover: "books/a-cover.png" },
      blocks: [], attention: ["Publisher must independently submit the book."],
    }],
  }];
  const sourceCatalog = {
    repository: "causeway-services/shop.561.group", path: "src/compiled-catalog.mjs",
    contentDigest: "ni:///sha-256;" + "a".repeat(43),
  };
  const sourceBook = { id: "book-1", book: { edition: { record: "editions/first-acceptance.json",
    acceptedAt: "2026-09-27T00:00:00Z", digest: "ni:///sha-256;" + "a".repeat(43),
    files: [{ format: "EPUB", path: "books/a.epub", sha256: "b".repeat(64), bytes: 1024 }] } } };
  const catalog = { offerings: [sourceBook] };
  const result = retailerSubmissionDraftResource(listed, sourceCatalog, catalog);
  assert.equal(validateJsonSchema(result, schema).valid, true);
  assert.equal(result.bookSubmissionDrafts[0].sourceEditionAcceptanceClaim.acceptanceRecordPath,
    "editions/first-acceptance.json");
  assert.equal(result.bookSubmissionDrafts[0].sourceEditionAcceptanceClaim.editionArtifacts[0].sha256Hex,
    "b".repeat(64));
  assert.equal(result.recordKind, "retailer-submission-draft-collection");
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.disposition, "proposed-not-submitted");
  assert.deepEqual(Object.keys(result), [
    "recordKind", "schemaVersion", "disposition", "sourceCatalog", "bookSubmissionDrafts",
  ]);
  assert.equal(result.bookSubmissionDrafts[0].bookOfferingId, "book-1");
  const candidate = result.bookSubmissionDrafts[0].retailerSubmissionDrafts[0];
  assert.equal(candidate.retailerCode, "kdp");
  assert.equal(candidate.disposition, "candidate-needs-publisher-review");
  assert.equal(candidate.proposedSubmissionFields.listPriceUsd, "9.00");
  assert.equal(candidate.operatorReviewNotes.length, 1);
  assert.equal("fields" in candidate, false);
  assert.equal("blocks" in candidate, false);
  for (const rejected of [
    { ...sourceCatalog, repository: "/tmp/machine" },
    { ...sourceCatalog, path: "../../etc/passwd.mjs" },
    { ...sourceCatalog, contentDigest: "unverified" },
  ]) assert.throws(() => retailerSubmissionDraftResource(listed, rejected, catalog), TypeError);
});

test("canonical packaged schema preserves missing byline and separate edition-acceptance claims", () => {
  const catalog = {
    merchant: { name: "561 Group" },
    offerings: [{
      id: "book-without-byline", title: "Book Without Byline",
      status: "coming-soon", priceCents: 900, currency: "usd",
      blurb: "An unaccepted source book.", keywords: [],
      book: { coverFile: "books/unaccepted/cover.png", subjects: [], edition: { files: [] } },
    }],
  };
  const sourceCatalog = {
    repository: "causeway-services/shop.561.group",
    path: "src/compiled-catalog.mjs",
    contentDigest: "ni:///sha-256;" + "a".repeat(43),
  };
  const generated = retailerSubmissionDraftResource(retailListings(catalog), sourceCatalog, catalog);
  const book = generated.bookSubmissionDrafts[0];
  assert.equal(validateJsonSchema(generated, schema).valid, true);
  assert.equal(book.sourceEditionAcceptanceClaim, null, "historical files are not independent edition acceptance");
  for (const candidate of book.retailerSubmissionDrafts) {
    assert.equal(candidate.disposition, "blocked");
    assert.equal(candidate.proposedSubmissionFields.author, null);
    assert.equal(candidate.proposedSubmissionFields.publisher, null);
    assert.match(candidate.submissionBlockers.join(" "), /No source-defined author/u);
    assert.match(candidate.submissionBlockers.join(" "), /No source-defined publisher/u);
  }
  const forged = structuredClone(generated);
  delete forged.bookSubmissionDrafts[0].sourceEditionAcceptanceClaim;
  assert.equal(validateJsonSchema(forged, schema).valid, false,
    "the original shipped v2 contract requires an explicit absent-or-present acceptance claim");
});

test("original retailer producer reads a selected catalog and writes byte-pinned proposals plus human guide", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "compiled-catalog.mjs"),
      recordPath = join(dir, "retail-drafts.json"), guidePath = join(dir, "retail-guide.md");
    const fixture = {
      offerings: [{
        id: "test-book", title: "Test Book", priceCents: 900, currency: "usd",
        status: "live", blurb: "A source-qualified book.", keywords: ["study"],
        book: { author: "Test Author", publisher: "Test Publisher",
          coverFile: "books/test/cover.png", subjects: [],
          edition: { record: "editions/test-acceptance.json", acceptedAt: "2026-09-27T00:00:00Z",
            digest: "ni:///sha-256;" + "a".repeat(43),
            files: [{ format: "EPUB", path: "books/test/test.epub", sha256: "b".repeat(64) }] },
        },
      }],
    };
    const moduleBytes = "export default " + JSON.stringify(fixture) + ";\n";
    writeFileSync(path, moduleBytes);
    const generated = await deriveRetailListings(path, recordPath, guidePath, {
      repository: "causeway-services/shop.561.group", path: "src/compiled-catalog.mjs",
    });
    const sourceDigest = "ni:///sha-256;" + createHash("sha256").update(moduleBytes).digest("base64url");
    assert.equal(generated.sourceCatalog.contentDigest, sourceDigest);
    assert.equal(generated.bookSubmissionDrafts.length, 1);
    assert.equal(generated.bookSubmissionDrafts[0].retailerSubmissionDrafts.length, 7);
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), generated);
    assert.equal(validateJsonSchema(generated, schema).valid, true);
    const accepted = generated.bookSubmissionDrafts[0].sourceEditionAcceptanceClaim;
    assert.equal(accepted.editionArtifacts[0].fileFormat, "EPUB");
    assert.equal(accepted.contentLanguageTag, "en");
    const guide = readFileSync(guidePath, "utf8");
    assert.match(guide, /# Retailer submission drafts/u);
    assert.ok(guide.includes(sourceDigest));
    assert.ok(!readFileSync(recordPath, "utf8").includes(dir), "machine-local temp paths must not escape");
    const kobo = generated.bookSubmissionDrafts[0].retailerSubmissionDrafts.find(x => x.retailerCode === "kobo");
    assert.equal(kobo.disposition, "blocked");
    assert.ok(kobo.submissionBlockers.length > 0);
  });
});

test("the native JSON Schema refuses forged or ambiguous retailer evidence and false statuses", () => {
  const sourceCatalog={repository:"causeway-services/shop.561.group",
    path:"src/compiled-catalog.mjs", contentDigest:"ni:///sha-256;"+"c".repeat(43)};
  const catalog={offerings:[{id:"test-book",book:{edition:{record:"editions/accepted.json",
    acceptedAt:"2026-09-27T00:00:00Z",digest:"ni:///sha-256;"+"a".repeat(43),
    files:[{format:"EPUB",path:"books/accepted.epub",sha256:"b".repeat(64),bytes:1024}]}}}]};
  const drafts=[{id:"test-book",title:"Test Book",listings:[{channel:"kdp",name:"Amazon KDP",
    fields:{title:"Test Book",author:"Test",publisher:"Test",language:"English",
      description:"Description",subjects:[],listPriceUsd:"9.00",files:[],cover:"cover.png"},
    blocks:[],attention:[]}]}];
  const valid=retailerSubmissionDraftResource(drafts,sourceCatalog,catalog);
  const mutations=[
    d=>{d.bookSubmissionDrafts[0].sourceEditionAcceptanceClaim.editionArtifacts[0].sha256Hex="not-a-digest";},
    d=>{d.bookSubmissionDrafts[0].retailerSubmissionDrafts[0].proposedSubmissionFields.listPriceUsd="nine";},
    d=>{d.bookSubmissionDrafts[0].retailerSubmissionDrafts[0].approval=true;},
    d=>{d.bookSubmissionDrafts[0].retailerSubmissionDrafts[0].disposition="submitted";},
    d=>{d.bookSubmissionDrafts[0].retailerSubmissionDrafts[0].submissionBlockers=["blocked"];}
  ];
  for(const mutate of mutations){const d=structuredClone(valid);mutate(d);
    assert.equal(validateJsonSchema(d,schema).valid,false);
  }
  const missing=structuredClone(catalog); delete missing.offerings[0].book.edition.record;
  assert.throws(()=>retailerSubmissionDraftResource(drafts,sourceCatalog,missing),/cannot be a candidate/u);
  assert.throws(()=>retailerSubmissionDraftResource(drafts,sourceCatalog,{offerings:[]}),/does not agree/u);
});
