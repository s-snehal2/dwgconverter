import { get, del } from "@vercel/blob";
import { isBlobEnabled, UPLOAD_BLOB_PREFIX } from "@/server/services/outputStore";

/**
 * In-flight upload storage.
 *
 * A large DWG is pushed by the browser straight into Blob rather than through
 * the serverless request body, which the platform caps well below a real
 * drawing. The convert route then receives only a URL, reads the bytes back,
 * and deletes the upload when it is done with them.
 *
 * The URL check is the only thing standing between "convert this file" and
 * "read this arbitrary URL", so it is deliberately narrow: https only, paths
 * under our own `uploads/` prefix, and it only ever produces a bare pathname.
 * The SDK is then handed the pathname instead of the caller-supplied host,
 * so the read-write `BLOB_READ_WRITE_TOKEN` can never be sent to a store URL
 * the caller chose.
 */

const UPLOAD_KEY_RE = /^uploads\/[A-Za-z0-9._-]{1,255}$/;

/** Reduce a caller-supplied URL to a trusted `uploads/…` pathname, or null. */
function trustedUploadPathname(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  const pathname = parsed.pathname.replace(/^\/+/, "");
  if (!UPLOAD_KEY_RE.test(pathname)) {
    return null;
  }

  // Must actually be under our own prefix (the regex above already anchors it).
  if (!pathname.startsWith(UPLOAD_BLOB_PREFIX)) {
    return null;
  }

  return pathname;
}

/** True when `url` is an https Blob URL inside our own `uploads/` prefix. */
export function isTrustedUploadUrl(url: string): boolean {
  return trustedUploadPathname(url) !== null;
}

/** Read an uploaded DWG back out of Blob. Throws if it is missing or unreadable. */
export async function readUploadBlob(url: string): Promise<Buffer> {
  if (!isBlobEnabled()) {
    throw new Error("Blob storage is not enabled.");
  }

  const pathname = trustedUploadPathname(url);
  if (!pathname) {
    throw new Error("Upload path is not trusted.");
  }

  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error("Upload not found.");
  }

  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Remove an upload once it has been consumed.
 *
 * Best-effort: a failed delete must not fail the conversion, and the periodic
 * sweep in `outputStore` picks up anything left behind.
 */
export async function deleteUploadBlob(url: string): Promise<void> {
  if (!isBlobEnabled()) {
    return;
  }

  const pathname = trustedUploadPathname(url);
  if (!pathname) {
    return;
  }

  try {
    await del(pathname);
  } catch {
    // Left for the sweep.
  }
}