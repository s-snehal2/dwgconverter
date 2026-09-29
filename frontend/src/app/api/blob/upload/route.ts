import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { isBlobEnabled, UPLOAD_BLOB_PREFIX } from "@/server/services/outputStore";
import { takeRateLimit, clientIpFrom } from "@/server/utils/rateLimit";

export const runtime = "nodejs";

// Whether Blob is enabled depends on runtime env vars (BLOB_READ_WRITE_TOKEN /
// VERCEL_OIDC_TOKEN). Without this, Next can statically bake the response at
// build time — local builds (no token) would permanently advertise
// `directUpload: false` even on machines that do have it.
export const dynamic = "force-dynamic";

/** Upload tokens are short-lived; a leaked one is only useful for a few minutes. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * GET /api/blob/upload — tell the client whether direct uploads are available.
 *
 * The browser calls this once. Anything that is not an explicit success makes
 * the client fall back to a normal multipart POST, which is what local dev and
 * the tests rely on.
 */
export async function GET() {
  if (!isBlobEnabled()) {
    return Response.json({ success: false, directUpload: false }, { status: 404 });
  }

  return Response.json({
    success: true,
    directUpload: true,
    access: "private",
    prefix: UPLOAD_BLOB_PREFIX,
    maxBytes: getConfig().maxFileSizeBytes,
  });
}

/**
 * POST /api/blob/upload — issue a short-lived token for exactly one upload.
 *
 * The DWG bytes never pass through this function. `@vercel/blob`'s client asks
 * here for a client token, then uploads straight to Blob, so a 20+ MB drawing
 * is not subject to the serverless request-body limit.
 */
export async function POST(request: NextRequest) {
  const config = getConfig();

  if (!isBlobEnabled()) {
    return Response.json({ success: false, error: "Direct uploads are not enabled." }, { status: 404 });
  }

  if (!takeRateLimit(clientIpFrom(request.headers), config.rateLimitMax, 60_000)) {
    return Response.json(
      { success: false, error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "retry-after": "60" } }
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return Response.json({ success: false, error: "Invalid upload request." }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // The client names the blob, so this is the one place an untrusted
        // caller could aim a write outside our own prefix. Reject rather than
        // rewrite: silently redirecting would hide a client bug.
        if (!pathname.startsWith(UPLOAD_BLOB_PREFIX)) {
          throw new Error(`Uploads must live under ${UPLOAD_BLOB_PREFIX}.`);
        }

        // These become constraints inside the token itself, so the size cap is
        // enforced by Blob on the real bytes rather than by anything the client
        // claims. `maximumSizeInBytes` is what actually stops a 500 MB upload.
        return {
          maximumSizeInBytes: config.maxFileSizeBytes,
          validUntil: Date.now() + TOKEN_TTL_MS,
          addRandomSuffix: true,
          allowOverwrite: false,
          allowedContentTypes: ["application/octet-stream"],
          callbackUrl: new URL("/api/blob/upload", request.url).toString(),
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.info(`[blob/upload] Stored ${blob.pathname}.`);
      },
    });

    return Response.json(result);
  } catch (err) {
    console.error(
      `[blob/upload] Token request refused: ${err instanceof Error ? err.message : String(err)}`
    );
    return Response.json({ success: false, error: "Upload could not be started." }, { status: 400 });
  }
}
