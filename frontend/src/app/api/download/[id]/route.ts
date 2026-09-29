import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { readOutput, sweepExpiredOutputsThrottled } from "@/server/services/outputStore";
import { httpStatusForCode, userMessageForCode } from "@/server/utils/errors";
import type { ErrorCode } from "@/server/utils/errors";
import { isSafeConversionId } from "@/server/utils/storage";

export const runtime = "nodejs";

function log(message: string): void {
  console.info(`[download] ${message}`);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!isSafeConversionId(id)) {
    log(`Rejected download for invalid conversion id "${id}".`);
    return errorResponse("FILE_NOT_FOUND");
  }

  let stored: Awaited<ReturnType<typeof readOutput>> | null;
  try {
    stored = await readOutput(id);
  } catch (err) {
    log(`readOutput failed for ${id}: ${err instanceof Error ? err.message : String(err)}.`);
    return errorResponse("DOWNLOAD_ERROR");
  }
  if (!stored) {
    log(`Download requested for missing output "${id}.png".`);
    return errorResponse("FILE_NOT_FOUND");
  }

  const safeBase = stored.fileName.replace(/[^\w.\- ]+/g, "_");

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
  return Response.json(
    { success: false, error: "Use GET /api/download/<id>." },
    { status: 405, headers: { allow: "GET" } }
  );
}
