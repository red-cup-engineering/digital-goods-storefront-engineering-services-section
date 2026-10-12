import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcilePaidReleases, stageAcceptedRelease } from "../src/paid-release-staging.mjs";
import { readPaidRelease, releasePointerKey } from "../src/paid-release.mjs";

const identity = (bytes) => `ni:///sha-256;${createHash("sha256").update(bytes).digest("base64url")}`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "paid-release-reconcile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const epub = Buffer.from("accepted EPUB fixture"), pdf = Buffer.from("accepted PDF fixture");
  const record = { type: "EbookEditionAcceptance", status: "accepted", editionInputDigest: identity("edition"), acceptedAt: "2026-10-12T00:00:00Z", artifacts: {
    epub: { path: join(root, "book.epub"), sha256: identity(epub) },
    screenPdf: { path: join(root, "book.pdf"), sha256: identity(pdf) },
  } };
  writeFileSync(record.artifacts.epub.path, epub); writeFileSync(record.artifacts.screenPdf.path, pdf);
  writeFileSync(join(root, "acceptance.json"), JSON.stringify(record));
  const staged = stageAcceptedRelease({ record, offering: "example-book", out: join(root, "original") });
  const objects = new Map([[releasePointerKey("example-book"), readFileSync(staged.pointerFile)], [staged.pointer.bundle.key, readFileSync(staged.bundle)]]);
  const writes = [], reads = [];
  const store = {
    async get(key) { reads.push(key); return objects.has(key) ? { body: objects.get(key) } : null; },
    async putCurrent(key, { body }) { writes.push(key); objects.set(key, body); },
  };
  const options = { catalog: { offerings: [{ id: "example-book", book: { acceptance: "acceptance.json" } }] }, servicesRoot: root, store, out: join(root, "repair") };
  return { options, objects, writes, reads, staged, record };
}

test("unchanged accepted pointer and bytes require no writes", async (t) => {
  const f = fixture(t);
  const result = await reconcilePaidReleases(f.options);
  assert.equal(result.summary.current, 1);
  assert.deepEqual(f.reads, [releasePointerKey("example-book"), f.staged.pointer.bundle.key]);
  assert.deepEqual(f.writes, []);
});

for (const damage of ["missing", "same-size-corruption", "wrong-size"]) {
  test(`matching edition with ${damage} is repaired and delivers accepted bytes`, async (t) => {
    const f = fixture(t), key = f.staged.pointer.bundle.key;
    if (damage === "missing") f.objects.delete(key);
    else f.objects.set(key, damage === "wrong-size" ? Buffer.from([1]) : Buffer.alloc(f.staged.pointer.bundle.bytes));
    const result = await reconcilePaidReleases(f.options);
    assert.equal(result.summary.staged, 1);
    assert.deepEqual(f.writes, [key, releasePointerKey("example-book")]);
    assert.deepEqual(f.objects.get(key), readFileSync(f.staged.bundle));
    const bucket = { head: async () => null, async get(k) { const bytes = f.objects.get(k); return bytes ? { text: async () => bytes.toString(), arrayBuffer: async () => bytes } : null; } };
    const response = await readPaidRelease("example-book", { goods: bucket });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(f.staged.bundle));
    f.writes.length = 0;
    assert.equal((await reconcilePaidReleases(f.options)).summary.current, 1);
    assert.deepEqual(f.writes, []);
  });
}

test("dry-run identifies a missing bundle without putting anything", async (t) => {
  const f = fixture(t); f.objects.delete(f.staged.pointer.bundle.key);
  const result = await reconcilePaidReleases({ ...f.options, dryRun: true });
  assert.equal(result.summary["would-stage"], 1);
  assert.deepEqual(f.writes, []);
  assert.equal(f.objects.has(f.staged.pointer.bundle.key), false);
});

test("a bundle read failure is refused, never interpreted as missing", async (t) => {
  const f = fixture(t), get = f.options.store.get;
  f.options.store.get = async (key) => { if (key === f.staged.pointer.bundle.key) throw new Error("storage unavailable"); return get(key); };
  const result = await reconcilePaidReleases(f.options);
  assert.equal(result.summary.refused, 1);
  assert.match(result.offerings[0].error, /storage unavailable/);
  assert.deepEqual(f.writes, []);
});

test("damaged accepted source artifacts are not published as a repair", async (t) => {
  const f = fixture(t); f.objects.delete(f.staged.pointer.bundle.key);
  writeFileSync(f.record.artifacts.epub.path, "unaccepted replacement");
  const result = await reconcilePaidReleases(f.options);
  assert.equal(result.summary.refused, 1);
  assert.match(result.offerings[0].error, /not the accepted artifact/);
  assert.deepEqual(f.writes, []);
});

test("a matching edition cannot make an invalid cross-offering pointer current", async (t) => {
  const f = fixture(t), pointer = structuredClone(f.staged.pointer);
  pointer.bundle.key = "goods/another-book/file.zip";
  f.objects.set(releasePointerKey("example-book"), Buffer.from(JSON.stringify(pointer)));
  const result = await reconcilePaidReleases(f.options);
  assert.equal(result.summary.refused, 1);
  assert.match(result.offerings[0].error, /outside this offering/);
  assert.deepEqual(f.writes, []);
});
