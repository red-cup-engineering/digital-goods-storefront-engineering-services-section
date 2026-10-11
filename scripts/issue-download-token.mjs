#!/usr/bin/env node
/**
 * Issues a signed, expiring download token for one offering/session pair,
 * reading the signing secret from `DIGITAL_GOODS_DOWNLOAD_SECRET`.
 */
import { issueDownloadToken } from "../src/digital-goods-storefront.mjs";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Issues a download token using the secret from `env`.
 * @param {{env?: object, offeringId: string, sessionId: string, ttlSeconds?: number, now?: number}} params
 * @returns {Promise<{token: string, expiresAt: number}>}
 * @throws {Error} when `DIGITAL_GOODS_DOWNLOAD_SECRET` is not set
 */
export async function issueDownloadTokenFromEnv({ env = process.env, offeringId, sessionId, ttlSeconds = 3600, now = Date.now() }) {
  const secret = env.DIGITAL_GOODS_DOWNLOAD_SECRET;
  if (!secret) throw new Error("DIGITAL_GOODS_DOWNLOAD_SECRET is not set");
  const expiresAt = now + ttlSeconds * 1000;
  const token = await issueDownloadToken({ secret, offeringId, sessionId, expiresAt });
  return { token, expiresAt };
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "issue-download-token", description: "Issues a download token using the secret from `env`.", operation: issueDownloadTokenFromEnv }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
