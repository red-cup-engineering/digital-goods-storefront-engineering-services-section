#!/usr/bin/env node
/** CLI adapter; reusable retailer draft production belongs to the source module. */
import { generateRetailerSubmissionDrafts } from "../src/retail-submission-drafts.mjs";
export {
  generateRetailerSubmissionDrafts,
  createRetailerSubmissionDraftCollection,
  deriveRetailListings,
  renderRetailListings,
  retailerSubmissionDraftResource,
} from "../src/retail-submission-drafts.mjs";

if (import.meta.main) {
  const [catalogModule, recordPath, guidePath, repository, sourcePath] =
    process.argv.slice(2);
  if (!catalogModule || !recordPath || !guidePath || !repository || !sourcePath)
    throw new Error(
      "usage: derive-retail-listings.mjs <compiled-catalog.mjs> <record.json> <guide.md> <source-owner/repository> <package-relative-source-path>",
    );
  const resource = await generateRetailerSubmissionDrafts(
    catalogModule,
    recordPath,
    guidePath,
    { repository, path: sourcePath },
  );
  const drafts = resource.bookSubmissionDrafts.flatMap(
    (book) => book.retailerSubmissionDrafts,
  );
  console.log(
    JSON.stringify({
      books: resource.bookSubmissionDrafts.length,
      proposals: drafts.length,
      blocked: drafts.filter((d) => d.disposition === "blocked").length,
      sourceCatalog: resource.sourceCatalog,
    }),
  );
}
