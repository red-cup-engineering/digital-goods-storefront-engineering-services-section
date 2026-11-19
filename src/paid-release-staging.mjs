import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { admitReleasePointer, releasePointerKey } from "./paid-release.mjs";

/**
 * Staging is a function of acceptance: an offering's staged release is the
 * edition its acceptance record names, and nothing else. readPaidRelease
 * refuses a pointer that is not the offer's intended edition, so a staging
 * that lags an acceptance makes the offer unsellable everywhere it is sold.
 * reconcilePaidReleases closes that gap by deriving the staging from the
 * catalog's acceptance records and putting only what differs.
 */

const contentAddress = (bytes) => `ni:///sha-256;${createHash("sha256").update(bytes).digest("base64url")}`;
const hexOf = (ni) => Buffer.from(String(ni).replace(/^ni:\/\/\/sha-256;/u, ""), "base64url").toString("hex");

/** The release and artifact identities an accepted edition record names. */
export function acceptedReleaseOf(record) {
  if (record?.type !== "EbookEditionAcceptance" || record.status !== "accepted") throw new Error("stage from the edition's acceptance record; an edition is sold only once accepted");
  if (typeof record.editionInputDigest !== "string" || !record.artifacts?.epub?.sha256 || !record.artifacts?.screenPdf?.sha256) throw new Error("the acceptance record names no EPUB, PDF or edition digest");
  return Object.freeze({ release: record.editionInputDigest, artifacts: Object.freeze({ epub: hexOf(record.artifacts.epub.sha256), screenPdf: hexOf(record.artifacts.screenPdf.sha256) }) });
}

/**
 * Build one paid release from an acceptance record: check that the EPUB and
 * PDF are the bytes the proof accepted, zip them into a bundle whose bytes
 * depend only on the members and the acceptance day, and write the pointer.
 * `dir` names the directory holding the edition's files when the paths the
 * record names went stale because the book moved.
 */
export function stageAcceptedRelease({ record, offering, out, dir }) {
  const { release, artifacts } = acceptedReleaseOf(record);
  let epub = record.artifacts.epub.path, pdf = record.artifacts.screenPdf.path;
  if (dir && epub && pdf) { epub = join(resolve(dir), basename(epub)); pdf = join(resolve(dir), basename(pdf)); }
  if (!epub || !pdf) throw new Error("the acceptance record names no EPUB or PDF path");
  for (const [file, expected] of [[epub, record.artifacts.epub.sha256], [pdf, record.artifacts.screenPdf.sha256]]) {
    if (!existsSync(file)) throw new Error(`${file} is missing; refabricate the accepted edition or name its directory`);
    if (contentAddress(readFileSync(file)) !== expected) throw new Error(`${basename(file)} on disk is not the accepted artifact (${expected}); refabricate the accepted edition or accept the new one`);
  }
  const target = resolve(out);
  mkdirSync(target, { recursive: true });
  const bundlePath = join(target, `${offering}.zip`);
  rmSync(bundlePath, { force: true });
  // -X drops extra file attributes and -j stores bare names; the members are
  // copied with a fixed time and mode, and zip writes UTC times.
  const epoch = Date.parse(`${String(record.acceptedAt).slice(0, 10)}T00:00:00Z`) / 1000;
  if (!Number.isFinite(epoch)) throw new Error("the acceptance record names no acceptance date");
  const staging = mkdtempSync(join(tmpdir(), "paid-release-"));
  try {
    const members = [epub, pdf].map((file) => {
      const member = join(staging, basename(file));
      copyFileSync(file, member);
      chmodSync(member, 0o644);
      utimesSync(member, epoch, epoch);
      return member;
    });
    execFileSync("zip", ["-X", "-j", "-q", bundlePath, ...members], { env: { ...process.env, TZ: "UTC" } });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return Object.freeze({ ...writePointer({ bundlePath, release, artifacts, offering, out: target }), members: [basename(epub), basename(pdf)] });
}

/** Stage a bundle built before edition records existed, naming its release by the build it came from. */
export function stageBuiltBundle({ bundle, release, offering, out }) {
  const target = resolve(out);
  mkdirSync(target, { recursive: true });
  const bundlePath = join(target, `${offering}.zip`);
  if (resolve(bundle) !== bundlePath) writeFileSync(bundlePath, readFileSync(resolve(bundle)));
  return writePointer({ bundlePath, release, offering, out: target });
}

function writePointer({ bundlePath, release, artifacts, offering, out }) {
  const bytes = readFileSync(bundlePath);
  const releaseSegment = release.replace(/^ni:\/\/\/sha-256;/u, "").replace(/[^A-Za-z0-9._-]/gu, "-");
  const bundleDigest = createHash("sha256").update(bytes).digest("hex");
  // The bundle key names the release, so a new edition never overwrites the
  // bytes an earlier buyer paid for; only the pointer moves.
  const pointer = admitReleasePointer({
    type: "PaidRelease", version: 1, offeringId: offering, release,
    ...(artifacts ? { artifacts } : {}),
    bundle: { key: `goods/${offering}/${releaseSegment}/${bundleDigest}.zip`, sha256: bundleDigest, bytes: bytes.byteLength, contentType: "application/zip", filename: basename(bundlePath) },
  }, offering);
  const pointerPath = join(out, "release.json");
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  return { pointer, bundle: bundlePath, pointerFile: pointerPath };
}

/** Put a staged release into the goods store: the bundle first, then the pointer that names it. */
export async function putStagedRelease(store, staged) {
  await store.putCurrent(staged.pointer.bundle.key, { body: readFileSync(staged.bundle), mediaType: "application/zip" });
  await store.putCurrent(releasePointerKey(staged.pointer.offeringId), { body: readFileSync(staged.pointerFile), mediaType: "application/json" });
}

/**
 * Reconcile the goods store against the catalog's accepted editions. Every
 * offering with an acceptance record is staged at that edition; an offering
 * whose stored pointer and bundle still match it is left alone, so a run
 * that changed nothing puts nothing. A pointer alone cannot establish that
 * the paid bytes remain deliverable. Missing or damaged bundles are rebuilt
 * from the accepted artifacts; storage read errors remain refusals.
 * @param {{catalog: object, servicesRoot: string, store: {get: Function, putCurrent: Function}, out: string, dryRun?: boolean}} options
 */
export async function reconcilePaidReleases({ catalog, servicesRoot, store, out, dryRun = false }) {
  const rows = [];
  for (const offering of (catalog.offerings ?? []).filter((row) => row.book?.acceptance)) {
    try {
      const record = JSON.parse(readFileSync(join(servicesRoot, offering.book.acceptance), "utf8"));
      const intended = acceptedReleaseOf(record);
      const stored = await store.get(releasePointerKey(offering.id));
      const pointer = stored === null ? undefined : JSON.parse(Buffer.from(stored.body).toString("utf8"));
      const namesIntended = pointer?.release === intended.release && Object.entries(intended.artifacts).every(([format, digest]) => pointer.artifacts?.[format] === digest);
      let current = false;
      if (namesIntended) {
        const admitted = admitReleasePointer(pointer, offering.id);
        const storedBundle = await store.get(admitted.bundle.key);
        if (storedBundle !== null) {
          const bytes = Buffer.from(storedBundle.body);
          current = bytes.byteLength === admitted.bundle.bytes && createHash("sha256").update(bytes).digest("hex") === admitted.bundle.sha256;
        }
      }
      if (current) { rows.push({ offering: offering.id, release: intended.release, state: "current" }); continue; }
      if (dryRun) { rows.push({ offering: offering.id, release: intended.release, state: "would-stage", stored: pointer?.release ?? null }); continue; }
      const staged = stageAcceptedRelease({ record, offering: offering.id, out: join(out, offering.id) });
      await putStagedRelease(store, staged);
      rows.push({ offering: offering.id, release: intended.release, state: "staged", stored: pointer?.release ?? null, bundle: staged.pointer.bundle.key });
    } catch (error) {
      rows.push({ offering: offering.id, state: "refused", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return Object.freeze({
    summary: Object.freeze(Object.fromEntries(["current", "staged", "would-stage", "refused"].map((state) => [state, rows.filter((row) => row.state === state).length]))),
    offerings: Object.freeze(rows),
  });
}

