import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateJsonSchema } from "@red-cup-engineering/json-schema-engineering-services-section/validation";
import schema from "../schema/retailer-submission-draft-collection.schema.json" with { type: "json" };
import { retailListings } from "../src/retail-listings.mjs";
import {
  deriveRetailListings,
  retailerSubmissionDraftResource,
  generateRetailerSubmissionDrafts,
  createRetailerSubmissionDraftCollection,
} from "../src/retail-submission-drafts.mjs";
import * as cli from "../scripts/derive-retail-listings.mjs";

const source = {
  repository: "red-cup-engineering/shop.561.group",
  path: "src/compiled-catalog.mjs",
};
const digest = (bytes) =>
  "ni:///sha-256;" + createHash("sha256").update(bytes).digest("base64url");
const catalog = (title = "First Edition") => ({
  offerings: [
    {
      id: "example-book",
      title,
      status: "live",
      priceCents: 900,
      currency: "usd",
      blurb: "A book with explicit source metadata.",
      keywords: [],
      book: {
        author: "Example Author",
        publisher: "Example Publisher",
        coverFile: "books/cover.png",
        subjects: [],
        edition: {
          record: "editions/example.json",
          acceptedAt: "2026-09-27T00:00:00Z",
          digest: digest("edition"),
          files: [
            {
              format: "EPUB",
              path: "books/example.epub",
              sha256: "a".repeat(64),
              bytes: 1024,
            },
          ],
        },
      },
    },
  ],
});
const resource = (value) =>
  retailerSubmissionDraftResource(
    retailListings(value),
    { ...source, contentDigest: digest("source") },
    value,
  );
const temporary = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "retailer-source-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    module: join(dir, "catalog.mjs"),
    record: join(dir, "drafts.json"),
    guide: join(dir, "guide.md"),
  };
};

test("repeated generation binds the new catalog values to the new source bytes", async (t) => {
  const files = temporary(t);
  for (const title of ["First Edition", "Revised Edition", "First Edition"]) {
    const bytes = "export default " + JSON.stringify(catalog(title)) + ";\n";
    writeFileSync(files.module, bytes);
    const generated = await deriveRetailListings(
      files.module,
      files.record,
      files.guide,
      source,
    );
    assert.equal(generated.sourceCatalog.contentDigest, digest(bytes));
    assert.equal(generated.bookSubmissionDrafts[0].bookTitle, title);
    assert.ok(
      generated.bookSubmissionDrafts[0].retailerSubmissionDrafts.every(
        (row) => row.proposedSubmissionFields.title === title,
      ),
    );
    assert.deepEqual(JSON.parse(readFileSync(files.record, "utf8")), generated);
  }
});

test("a source that changes during import is refused before either output is replaced", async (t) => {
  const files = temporary(t);
  const bytes = [
    'import { writeFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    'writeFileSync(fileURLToPath(import.meta.url), "export default {};\\n");',
    "export default " + JSON.stringify(catalog()) + ";",
  ].join("\n");
  writeFileSync(files.module, bytes);
  writeFileSync(files.record, "previous record");
  writeFileSync(files.guide, "previous guide");
  await assert.rejects(
    deriveRetailListings(files.module, files.record, files.guide, source),
    /catalog source changed/u,
  );
  assert.equal(readFileSync(files.record, "utf8"), "previous record");
  assert.equal(readFileSync(files.guide, "utf8"), "previous guide");
});

test("the canonical schema refuses empty candidate author or publisher even when blockers are cleared", () => {
  for (const key of ["author", "publisher"])
    for (const value of [null, "", "   "]) {
      const generated = resource(catalog());
      const altered = structuredClone(generated);
      const candidate =
        altered.bookSubmissionDrafts[0].retailerSubmissionDrafts.find(
          (row) => row.retailerCode === "kdp",
        );
      assert.equal(candidate.disposition, "candidate-needs-publisher-review");
      candidate.proposedSubmissionFields[key] = value;
      assert.equal(
        validateJsonSchema(altered, schema).valid,
        false,
        `${key}=${JSON.stringify(value)}`,
      );
    }
});

test("unknown author and publisher remain explicit nulls in blocked proposals", () => {
  const input = catalog();
  delete input.offerings[0].book.author;
  delete input.offerings[0].book.publisher;
  const generated = resource(input);
  assert.equal(validateJsonSchema(generated, schema).valid, true);
  for (const row of generated.bookSubmissionDrafts[0]
    .retailerSubmissionDrafts) {
    assert.equal(row.disposition, "blocked");
    assert.equal(row.proposedSubmissionFields.author, null);
    assert.equal(row.proposedSubmissionFields.publisher, null);
  }
});

test("the CLI adapter preserves existing callable exports from their source owner", () => {
  assert.equal(cli.deriveRetailListings, deriveRetailListings);
  assert.equal(
    cli.retailerSubmissionDraftResource,
    retailerSubmissionDraftResource,
  );
  assert.equal(deriveRetailListings, generateRetailerSubmissionDrafts);
  assert.equal(
    retailerSubmissionDraftResource,
    createRetailerSubmissionDraftCollection,
  );
});

test("a repeated projection cannot replace a different source book with the same book identity", () => {
  const input = catalog();
  input.offerings.push({
    ...structuredClone(input.offerings[0]),
    id: "second-book",
    title: "Second Book",
  });
  const listings = retailListings(input);
  const substituted = [
    listings[0],
    { ...structuredClone(listings[0]), title: "Different projection" },
  ];
  assert.throws(
    () =>
      createRetailerSubmissionDraftCollection(
        substituted,
        { ...source, contentDigest: digest("source") },
        input,
      ),
    /book identities/u,
  );
  assert.equal(
    createRetailerSubmissionDraftCollection(
      listings,
      { ...source, contentDigest: digest("source") },
      input,
    ).bookSubmissionDrafts.length,
    2,
  );
});
