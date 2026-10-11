#!/usr/bin/env node
/**
 * Stage one paid release from an ebook edition's acceptance record: check that
 * the EPUB and PDF on disk are the bytes the proof accepted, zip them into one
 * bundle, write the release pointer readPaidRelease
 * serves from, and, with --upload, put both into the goods bucket.
 *
 *   node scripts/stage-paid-release.mjs <edition-acceptance.json> --offering <id> --out <dir> [--dir <edition files>] [--bucket shop-561-group-goods] [--upload]
 *   node scripts/stage-paid-release.mjs --bundle <file.zip> --release <id> --offering <id> --out <dir> [--upload]
 *
 * The second form stages a bundle built before edition records existed (the
 * Handbook's), naming its release by the build it came from.
 * The bundle key names the release (the edition-input digest), so a new
 * edition never overwrites the bytes an earlier buyer paid for; only the
 * pointer moves. --dir names the directory holding the edition's files (the
 * book's data/state/editions/<slug>); without it the paths the record names
 * are used, which go stale when a book moves. The bundle is the same bytes
 * for the same accepted files: its members carry the acceptance day as
 * their time, mode 0644, and times in UTC. Uploading runs `wrangler r2 object put`, which needs a
 * Cloudflare credential in the environment (the Cloudflare section's
 * with-cloudflare-token.mjs, or a wrangler login).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { releasePointerKey } from "../src/paid-release.mjs";
import { stageAcceptedRelease, stageBuiltBundle } from "../src/paid-release-staging.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: "string" }, bundle: { type: "string" }, release: { type: "string" }, offering: { type: "string" }, out: { type: "string" }, bucket: { type: "string", default: "shop-561-group-goods" }, upload: { type: "boolean", default: false } } });
const [recordPath] = positionals;
if ((!recordPath && !(values.bundle && values.release)) || !values.offering || !values.out) throw new Error("usage: stage-paid-release.mjs (<edition-record.json> | --bundle <zip> --release <id>) --offering <id> --out <dir> [--bucket <name>] [--upload]");

const staged = recordPath
  ? stageAcceptedRelease({ record: JSON.parse(readFileSync(resolve(recordPath), "utf8")), offering: values.offering, out: values.out, dir: values.dir })
  : stageBuiltBundle({ bundle: values.bundle, release: values.release, offering: values.offering, out: values.out });
const { pointer, bundle: bundlePath, pointerFile: pointerPath } = staged;

if (values.upload) {
  // WRANGLER names the wrangler entry script when no wrangler is on the path.
  const wrangler = process.env.WRANGLER ? [process.execPath, [process.env.WRANGLER]] : ["npx", ["--no-install", "wrangler"]];
  const put = (key, file, contentType) => execFileSync(wrangler[0], [...wrangler[1], "r2", "object", "put", `${values.bucket}/${key}`, "--file", file, "--content-type", contentType, "--remote"], { stdio: "inherit" });
  put(pointer.bundle.key, bundlePath, "application/zip");
  put(releasePointerKey(values.offering), pointerPath, "application/json");
}
process.stdout.write(`${JSON.stringify({ pointer, bundle: bundlePath, pointerFile: pointerPath, uploaded: values.upload, members: staged.members ?? null }, null, 2)}\n`);
