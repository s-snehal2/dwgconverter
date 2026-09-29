#!/usr/bin/env node
/**
 * One-time manual purge of expired Vercel Blob outputs + AI-image cache.
 *
 * Use this to reclaim space immediately (e.g. when the Blob meter shows 100%
 * usage) without waiting for the daily /api/cleanup cron to pick everything up.
 *
 * Safe by default: only blobs under the app's own "outputs/" and "cache/"
 * prefixes and older than the cutoff are deleted. Nothing outside them is ever
 * touched.
 *
 * Usage (from the frontend/ directory):
 *   $env:BLOB_READ_WRITE_TOKEN = "<token from Vercel>"; node scripts/cleanup-blobs.mjs
 *
 * Flags:
 *   --older-than-minutes N   delete blobs older than N minutes (default 43200 = 30 days)
 *   --all                    delete every blob under the outputs/ + cache/ prefixes
 */
import { list, del } from "@vercel/blob";

const PREFIXES = ["outputs/", "cache/"];

function parseArgs(argv) {
  const args = { olderThanMinutes: 43200, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      args.all = true;
    } else if (arg === "--older-than-minutes") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(value) || value < 0) {
        console.error("Invalid value for --older-than-minutes.");
        process.exit(2);
      }
      args.olderThanMinutes = value;
      i += 1;
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error(
    "BLOB_READ_WRITE_TOKEN is not set. Grab it from Vercel (Project -> Settings -> Environment Variables) and try again."
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const cutoffMs = args.all ? 0 : Date.now() - args.olderThanMinutes * 60 * 1000;
const label = args.all
  ? "everything under outputs/ and cache/"
  : `blobs older than ${args.olderThanMinutes} minute(s)`;

const expired = [];
for (const prefix of PREFIXES) {
  let cursor;
  do {
    const page = await list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const blob of page.blobs) {
      if (args.all || blob.uploadedAt.getTime() < cutoffMs) {
        expired.push(blob.url);
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

if (expired.length === 0) {
  console.log(`Nothing to delete (no ${label}).`);
  process.exit(0);
}

console.log(`Deleting ${expired.length} blob(s) (${label})...`);
await del(expired);
console.log("Done.");