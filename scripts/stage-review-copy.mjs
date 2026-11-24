#!/usr/bin/env node
/**
 * Stage one reader's review copy: check that the stamped EPUB is the bytes its AdvanceReaderRendition record names,
 * write the ReviewCopyRelease pointer readReviewCopy serves from, and, with --upload, put both into the goods bucket
 * under the grant. Uploading runs `wrangler r2 object put`, which needs a Cloudflare credential in the environment.
 *
 *   node scripts/stage-review-copy.mjs --rendition <advance-reader-rendition.json> --epub <stamped.epub> --offering <id> --out <dir> [--bucket shop-561-group-goods] [--upload]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { reviewCopyPointerKey, stagedReviewCopyPointer } from "../src/review-copy.mjs";

const usage = "usage: stage-review-copy.mjs --rendition <record.json> --epub <stamped.epub> --offering <id> --out <dir> [--bucket <name>] [--upload]";
const { values } = parseArgs({ options: { rendition: { type: "string" }, epub: { type: "string" }, offering: { type: "string" }, out: { type: "string" }, bucket: { type: "string", default: "shop-561-group-goods" }, upload: { type: "boolean", default: false } } });
if (!values.rendition || !values.epub || !values.offering || !values.out) throw new Error(usage);

const cell = JSON.parse(readFileSync(resolve(values.rendition), "utf8"));
const bytes = readFileSync(resolve(values.epub));
const pointer = stagedReviewCopyPointer(cell, values.offering, { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength });
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const pointerPath = join(out, "pointer.json");
writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
if (values.upload) {
  const wrangler = process.env.WRANGLER ? [process.execPath, [process.env.WRANGLER]] : ["npx", ["--no-install", "wrangler"]];
  const put = (key, file, contentType) => execFileSync(wrangler[0], [...wrangler[1], "r2", "object", "put", `${values.bucket}/${key}`, "--file", file, "--content-type", contentType, "--remote"], { stdio: ["ignore", "ignore", "inherit"] });
  put(pointer.bundle.key, resolve(values.epub), "application/epub+zip");
  put(reviewCopyPointerKey(values.offering, pointer.grant), pointerPath, "application/json");
}
process.stdout.write(`${JSON.stringify({ pointer, pointerFile: pointerPath, uploaded: values.upload }, null, 2)}\n`);
