#!/usr/bin/env node
/**
 * Validates a catalog JSON file against the storefront's admission rules
 * and reports the result.
 */
import { readFileSync } from "node:fs";

import { validateCatalog } from "../src/digital-goods-storefront.mjs";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Reads and validates a catalog file from disk.
 * @param {string} path path to a catalog JSON file
 * @returns {{catalog: object, result: {valid: boolean, errors: {path: string, message: string}[]}}}
 */
export function validateCatalogFile(path) {
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  return { catalog, result: validateCatalog(catalog) };
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "validate-catalog", description: "Reads and validates a catalog file from disk.", operation: validateCatalogFile }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
