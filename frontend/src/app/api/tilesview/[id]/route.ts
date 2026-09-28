import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { sendRoomToTilesview } from "@/server/services/tilesview";
import { readAiOutput } from "@/server/services/outputStore";
import { toAppError, httpStatusForCode, userMessageForCode } from "@/server/utils/errors";
import { isSafeConversionId } from "@/server/utils/storage";
import { takeRateLimit } from "@/server/utils/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return request.headers.get("x-real-ip") ?? "local";
}

function log(message: string): void {
  console.info(`[tilesview] ${message}`);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = getConfig();

  log(
    `config: url=${config.tilesviewApiUrl} keySet=${Boolean(config.tilesviewAppKey)} secretSet=${Boolean(config.tilesviewAppSecret)}`,
  );

  if (!isSafeConversionId(id)) {
    log(`Rejected for invalid conversion id "${id}".`);
    return errorResponse("INVALID_FILE");
  }

  if (!config.tilesviewAppKey || !config.tilesviewAppSecret) {
    log("Requested but TILESVIEW_APP_KEY/SECRET not configured.");
    return errorResponse("TILESVIEW_ERROR");
  }

  if (!takeRateLimit(clientIp(request), config.rateLimitMax, 60_000)) {
    return errorResponse("RATE_LIMITED");
  }

  const stored = await readAiOutput(id);
  if (!stored) {
    log(`No AI image found for "${id}".`);
    return errorResponse("FILE_NOT_FOUND");
  }

  try {
    const customRoomsId = await sendRoomToTilesview(stored.buffer, config);
    const visualizerUrl = `${config.tilesviewVisualizerBaseUrl}/${customRoomsId}/MySpace`;
    log(`AI image for ${id} uploaded to TilesView (room id ${customRoomsId}, visualizer ${visualizerUrl}).`);
    return Response.json(
      { success: true, conversionId: id, customRoomsId, visualizerUrl },
      { status: 200 },
    );
  } catch (err) {
    const appError = toAppError(err);
    const code = appError.code === "INTERNAL_ERROR" ? "TILESVIEW_ERROR" : appError.code;
    log(`Failed (${code}): ${err instanceof Error ? err.message : String(err)}.`);
    const status = httpStatusForCode(code);
    if (status >= 500) {
      console.error(err);
    }
    return Response.json(
      { success: false, error: userMessageForCode(code) },
      { status },
    );
  }
}

function errorResponse(code: string) {
  return Response.json(
    { success: false, error: userMessageForCode(code as never) },
    { status: httpStatusForCode(code as never) },
  );
}
