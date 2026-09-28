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
 * The prefix check is the only thing standing between "convert this file" and
 * "read this arbitrary URL", so it is deliberately narrow: https only, and
 * only paths under our own `uploads/` prefix.
 */

/**
 * True when `url` is an https Blob URL inside our own `uploads/` prefix.
 *
 * This is a prefix check, not a host check. `@vercel/blob`'s `get` refuses any
 * host that is not the account's own Blob store, so a caller that passes a
 * look-alike host still cannot exfiltrate anything; this only rejects URLs we
 * never issued in the first place.
 */
export function isTrustedUploadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  return parsed.pathname.startsWith(`/${UPLOAD_BLOB_PREFIX}`);
}

/** Read an uploaded DWG back out of Blob. Throws if it is missing or unreadable. */
export async function readUploadBlob(url: string): Promise<Buffer> {
  if (!isBlobEnabled()) {
    throw new Error("Blob storage is not enabled.");
  }

  const result = await get(url, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) {
    throw new Error("Upload not found.");
  }

  return Buffer.from(await new Response(result.stream).arrayBuffer());
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

  try {
    await del(url);
  } catch {
    // Left for the sweep.
  }
}
