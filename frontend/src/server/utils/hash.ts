import { createHash } from "node:crypto";

/** Hex SHA-256 of the given bytes; used as the AI-image cache key. */
export function sha256Hex(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}