import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { generateDrawingImage } from "@/server/services/geminiImage";
import {
  sweepExpiredOutputsThrottled,
  readOutput,
  saveAiOutput,
  saveCacheAiImage,
  readCacheAiImage,
  getAiGenerationCount,
  incrementAiGenerationCount,
} from "@/server/services/outputStore";
import { toAppError, AppError, userMessageForCode, httpStatusForCode, type ErrorCode } from "@/server/utils/errors";
import { isSafeConversionId } from "@/server/utils/storage";
import { sha256Hex } from "@/server/utils/hash";
import { takeRateLimit } from "@/server/utils/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 300;

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return request.headers.get("x-real-ip") ?? "local";
}

function log(message: string): void {
  console.info(`[generate] ${message}`);
}

/** User-supplied prompt from the JSON request body, validated + truncated. */
async function readUserPrompt(request: NextRequest, maxChars: number): Promise<string | undefined> {
  if (request.headers.get("content-type")?.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { prompt?: unknown } | null;
    const raw = typeof body?.prompt === "string" ? body.prompt : "";
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length > maxChars) {
      throw new AppError("INVALID_PROMPT", "The AI prompt is too long.");
    }
    return trimmed;
  }
  return undefined;
}

/**
 * POST /api/generate/:id
 * Reads the already-converted DWG sheet PNG and sends it to Gemini Nano
 * Banana 2 with the architectural-visualization base prompt, optionally
 * steered by a user-supplied `prompt` in the JSON body. Stores the generated
 * AI image as outputs/{id}.ai.png.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = getConfig();

  if (!isSafeConversionId(id)) {
    log(`Rejected generate for invalid conversion id "${id}".`);
    return errorResponse("INVALID_FILE");
  }

  if (!config.geminiApiKey) {
    log("Generate requested but GEMINI_API_KEY is not configured.");
    return errorResponse("AI_NOT_CONFIGURED");
  }

  let userPrompt: string | undefined;
  try {
    userPrompt = await readUserPrompt(request, config.maxAiPromptChars);
  } catch (err) {
    const appError = toAppError(err);
    return Response.json(
      { success: false, error: userMessageForCode(appError.code) },
      { status: httpStatusForCode(appError.code) },
    );
  }

  if (!takeRateLimit(clientIp(request), config.rateLimitMax, 60_000)) {
    return errorResponse("RATE_LIMITED");
  }

  let stored: Awaited<ReturnType<typeof readOutput>> | null;
  try {
    stored = await readOutput(id);
  } catch (err) {
    const appError = toAppError(err);
    log(`readOutput failed for ${id}: ${err instanceof Error ? err.message : String(err)}.`);
    return errorResponse(appError.code === "STORAGE_UNAVAILABLE" ? "STORAGE_UNAVAILABLE" : "DOWNLOAD_ERROR");
  }
  if (!stored) {
    log(`Generate requested for missing output "${id}.png".`);
    return errorResponse("FILE_NOT_FOUND");
  }

  // Best-effort periodic cleanup of expired outputs, *after* the output this
  // handler depends on has been read (sweeping first could delete it mid-flight).
  try {
    await sweepExpiredOutputsThrottled(config.cleanupAgeMs);
  } catch (err) {
    log(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const usedSoFar = await getAiGenerationCount(id);
  if (usedSoFar >= config.aiGenerationLimit) {
    log(`Generate limit reached for ${id} (${usedSoFar}/${config.aiGenerationLimit}).`);
    return limitResponse(config.aiGenerationLimit);
  }

  const baseName = stored.fileName.replace(/\.png$/i, "");
  const png = stored.buffer;

  const hash = sha256Hex(png);
  let cached: Awaited<ReturnType<typeof readCacheAiImage>> = null;
  try {
    cached = await readCacheAiImage(hash);
  } catch (err) {
    // A failed cache *lookup* should never block generation.
    log(`Cache lookup failed, generating fresh: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (cached) {
    const fileName = cached.fileName || `${baseName}-ai.png`;
    // Failure to persist the cached copy surfaces as an error rather than
    // silently paying for a second Gemini call.
    await saveAiOutput(id, cached.buffer, fileName);
    log(
      `Cache hit for ${hash}: reusing earlier AI image (${cached.buffer.byteLength} bytes) without calling Gemini.`
    );
    return Response.json(
      {
        success: true,
        conversionId: id,
        fileName,
        size: cached.buffer.byteLength,
        durationMs: 0,
        generationsUsed: usedSoFar,
        generationsLimit: config.aiGenerationLimit,
        cached: true,
      },
      { status: 200 },
    );
  }

  try {
    log(`Sending ${id}.png (${png.byteLength} bytes) to Gemini for AI generation.`);

    const { image, durationMs } = await generateDrawingImage(png, config, userPrompt);
    log(`Gemini returned AI image (${image.byteLength} bytes) in ${durationMs}ms.`);

    const fileName = `${baseName}-ai.png`;
    await saveAiOutput(id, image, fileName);
    const generationsUsed = await incrementAiGenerationCount(id);
    try {
      await saveCacheAiImage(hash, image, fileName);
    } catch (cacheErr) {
      log(`Cache write failed (non-fatal): ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`);
    }
    log(`AI image written to ${id}.ai.png (generation ${generationsUsed}/${config.aiGenerationLimit}).`);

    return Response.json(
      {
        success: true,
        conversionId: id,
        fileName,
        size: image.byteLength,
        durationMs,
        generationsUsed,
        generationsLimit: config.aiGenerationLimit,
      },
      { status: 200 },
    );
  } catch (err) {
    const appError = toAppError(err);
    const code =
      appError.code === "INTERNAL_ERROR" || appError.code === "PARSER_ERROR"
        ? "AI_GENERATION_ERROR"
        : appError.code;
    log(`Generate failed (${code}): ${err instanceof Error ? err.message : String(err)}.`);
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

function limitResponse(limit: number) {
  return Response.json(
    {
      success: false,
      error: `You've reached the maximum of ${limit} AI image generations for this drawing. Convert the DWG again to generate more.`,
      generationsLimit: limit,
    },
    { status: httpStatusForCode("AI_LIMIT_REACHED") },
  );
}

function errorResponse(code: ErrorCode) {
  return Response.json(
    { success: false, error: userMessageForCode(code) },
    { status: httpStatusForCode(code) },
  );
}

export async function GET() {
  return Response.json(
    { success: false, error: "Use POST /api/generate/<id> to generate an AI image." },
    { status: 405, headers: { allow: "POST" } },
  );
}
