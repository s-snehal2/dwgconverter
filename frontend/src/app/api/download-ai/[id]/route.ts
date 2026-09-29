import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { readAiOutput, sweepExpiredOutputsThrottled } from "@/server/services/outputStore";
import { httpStatusForCode, userMessageForCode } from "@/server/utils/errors";
import type { ErrorCode } from "@/server/utils/errors";
import { isSafeConversionId } from "@/server/utils/storage";

export const runtime = "nodejs";

function log(message: string): void {
  console.info(`[download-ai] ${message}`);
}

/**
 * GET /api/download-ai/[id]
 * Serves the AI-generated PNG produced by the /api/generate route.
 * Same structure as /api/download/[id] — no deletion on download,
 * age-based sweep reclaims outputs.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!isSafeConversionId(id)) {
    log(`Rejected download for invalid conversion id "${id}".`);
    return errorResponse("FILE_NOT_FOUND");
  }

  const stored = await readAiOutput(id);
  if (!stored) {
    log(`Download requested for missing AI output "${id}.ai.png".`);
    return errorResponse("FILE_NOT_FOUND");
  }

  const safeBase = stored.fileName.replace(/[^\w.\- ]+/g, "_");

  // Best-effort periodic cleanup.
  try {
    await sweepExpiredOutputsThrottled(getConfig().cleanupAgeMs);
  } catch {
    // Best-effort.
  }

  return new Response(new Uint8Array(stored.buffer), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${safeBase}"`,
      "Content-Length": String(stored.buffer.byteLength),
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(code: ErrorCode) {
  return Response.json(
    { success: false, error: userMessageForCode(code) },
    { status: httpStatusForCode(code) }
  );
}

export async function POST() {
  return errorResponse("INVALID_FILE");
}
