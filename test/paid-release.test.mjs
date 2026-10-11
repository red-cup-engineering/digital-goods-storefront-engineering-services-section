import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { admitPaidRelease, readPaidRelease, releasePointerKey } from "../src/paid-release.mjs";

function bucketWith(objects) {
  const wrap = (bytes) => ({ size: bytes.byteLength, text: async () => Buffer.from(bytes).toString("utf8"), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  return {
    get: async (key) => (objects.has(key) ? wrap(objects.get(key)) : null),
    head: async (key) => (objects.has(key) ? { size: objects.get(key).byteLength } : null),
  };
}

function staged(bundleBytes, overrides = {}) {
  const bundle = { key: "goods/example-book/r1/example-book.zip", sha256: createHash("sha256").update(bundleBytes).digest("hex"), bytes: bundleBytes.byteLength, contentType: "application/zip", filename: "example-book.zip", ...overrides };
  const pointer = { type: "PaidRelease", version: 1, offeringId: "example-book", release: "ni:///sha-256;release", bundle };
  return new Map([[releasePointerKey("example-book"), new Uint8Array(Buffer.from(JSON.stringify(pointer)))], [bundle.key, bundleBytes]]);
}

test("a staged release is admitted and delivered with its release named", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const env = { SHOP_GOODS: bucketWith(staged(bytes)) };
  assert.deepEqual({ ...(await admitPaidRelease("example-book", env)) }, { offeringId: "example-book", release: "ni:///sha-256;release", byteLength: 4 });
  const response = await readPaidRelease("example-book", env);
  assert.equal(response.headers.get("x-release"), "ni:///sha-256;release");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="example-book.zip"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("bytes that do not match the pointer's digest are refused", async () => {
  const objects = staged(new Uint8Array([1, 2, 3, 4]));
  objects.set("goods/example-book/r1/example-book.zip", new Uint8Array([9, 9, 9, 9]));
  await assert.rejects(readPaidRelease("example-book", { goods: bucketWith(objects) }), /does not match/u);
});

test("an offering with nothing staged, or a bundle outside its goods, is unavailable before payment", async () => {
  await assert.rejects(admitPaidRelease("example-book", { SHOP_GOODS: bucketWith(new Map()) }), /no release is staged/u);
  const outside = staged(new Uint8Array([1]), { key: "goods/other-book/r1/x.zip" });
  await assert.rejects(admitPaidRelease("example-book", { SHOP_GOODS: bucketWith(outside) }), /outside this offering/u);
});
