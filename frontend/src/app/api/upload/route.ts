import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { createSignedUploadUrl, isSupabaseEnabled } from "@/server/services/supabaseStore";
import { validateExtension, validateFileSize } from "@/server/utils/fileValidation";
import { toAppError, userMessageForCode, httpStatusForCode } from "@/server/utils/errors";
import { newConversionId } from "@/server/utils/storage";
import { clientIpFrom, takeRateLimit } from "@/server/utils/rateLimit";

export const runtime = "nodejs";

function errorResponse(code: Parameters<typeof userMessageForCode>[0]): Response {
  return Response.json({ success: false, error: userMessageForCode(code) }, { status: httpStatusForCode(code) });
}

/**
 * GET /api/upload — capability probe, fetched once per session and cached.
 *
 * `directUpload` tells the browser whether large files can be pushed straight
 * to Supabase Storage via a signed URL. It is false when the server has no
 * Supabase credentials (local dev), in which case the client falls back to a
 * multipart POST to `/api/convert`, bounded by the platform's ~4.5 MB
 * request-body cap. `maxBytes` echoes the server's configured limit so the
 * client-side picker cap matches the real authority.
 */
export async function GET() {
  const config = getConfig();
  return Response.json({
    success: true,
    directUpload: isSupabaseEnabled(),
    maxBytes: config.maxFileSizeBytes,
  });
}

/**
 * POST /api/upload — mint a signed direct-upload URL for one DWG.
 *
 * Body: `{ fileName, size }`. Validates what it can before touching storage,
 * then returns `{ uploadId, signedUrl }`. The browser PUTs the raw bytes to
 * `signedUrl` itself (no auth headers needed) and afterwards posts
 * `{ uploadId, fileName, size }` to `/api/convert`, which downloads the staged
 * object, converts it, and deletes it in a `finally`. If a request dies
 * between upload and convert, the `uploads/` retention sweep removes the
 * object once it ages past `UPLOAD_AGE_MINUTES`.
 */
export async function POST(request: NextRequest) {
  const config = getConfig();

  // Minting costs a storage round-trip, so it shares the convert route's
  // per-IP budget rather than opening a new way to hammer Supabase.
  if (!takeRateLimit(clientIpFrom(request.headers), config.rateLimitMax, 60_000)) {
    return errorResponse("RATE_LIMITED");
  }
  if (!isSupabaseEnabled()) {
    return errorResponse("STORAGE_UNAVAILABLE");
  }

  let body: { fileName?: unknown; size?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_FILE");
  }
  const fileName = typeof body.fileName === "string" ? body.fileName : "";
  const size = typeof body.size === "number" ? body.size : Number.NaN;

  const extensionCheck = validateExtension(fileName);
  if (!extensionCheck.ok) {
    return errorResponse(extensionCheck.error.code);
  }
  const sizeCheck = validateFileSize(size, config.maxFileSizeBytes);
  if (!sizeCheck.ok) {
    return errorResponse(sizeCheck.error.code);
  }

  // UUID-shaped id: unguessable, and re-validated by `/api/convert` before it
  // is spliced into an object key, so a client cannot steer the lookup to any
  // other path in the bucket.
  const uploadId = newConversionId();
  try {
    const signedUrl = await createSignedUploadUrl(`uploads/${uploadId}.dwg`);
    return Response.json({ success: true, uploadId, signedUrl, maxBytes: config.maxFileSizeBytes });
  } catch (err) {
    const appError = toAppError(err);
    console.error(`[upload] mint failed (${appError.code}): ${err instanceof Error ? err.message : String(err)}`);
    return errorResponse(appError.code);
  }
}
