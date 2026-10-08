import type { NextRequest } from "next/server";
import sharp from "sharp";
import { getConfig } from "@/server/config";
import { computeAiPairId, promptHash, readAiPair, saveAiPair } from "@/server/services/aiPairCache";
import { composeAiPrompt, generateDrawingImage } from "@/server/services/geminiImage";
import {
  claimAiGeneration,
  getAiGenerationCount,
  incrementAiGenerationCount,
  readOutput,
  readOutputSourceMeta,
  releaseAiGenerationClaim,
  saveAiOutput,
  sweepExpiredOutputsThrottled,
} from "@/server/services/outputStore";
import { toAppError, userMessageForCode, httpStatusForCode, type ErrorCode } from "@/server/utils/errors";
import { sha256Hex } from "@/server/utils/hash";
import { clientIpFrom, takeRateLimit } from "@/server/utils/rateLimit";
import { isSafeConversionId } from "@/server/utils/storage";

export const runtime = "nodejs";
export const maxDuration = 300;

function log(message: string): void {
  console.info(`[generate] ${message}`);
}

/**
 * Run a store call, turning a storage failure into a `STORAGE_UNAVAILABLE`
 * response instead of letting it escape the handler as an unhandled 500 with no
 * error envelope. Returns null on failure.
 */
async function storageCall<T>(fn: () => Promise<T>, what: string): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

interface GenerateRequestBody {
  regenerate: boolean;
}

/**
 * Parse the JSON request body once.
 *
 * `request.json()` consumes the body, so everything the handler needs from it
 * has to be read in a single pass. A `prompt` field is accepted and ignored:
 * the prompt is fixed by `GEMINI_PROMPT`, so a per-request one would change the
 * cache key without changing what the model receives.
 */
async function readGenerateBody(request: NextRequest): Promise<GenerateRequestBody> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return { regenerate: false };
  }
  const body = (await request.json().catch(() => null)) as {
    prompt?: unknown;
    regenerate?: unknown;
  } | null;
  return {
    // Only a literal `true` opts out of the cache; anything else is a plain
    // cache-first request, which is what keeps a re-upload free.
    regenerate: body?.regenerate === true,
  };
}

/**
 * POST /api/generate/:id
 * Reads the already-converted DWG sheet PNG and sends it to Gemini with the
 * fixed architectural-visualization prompt, storing the result as
 * outputs/{id}.ai.png.
 *
 * The AI pair cache is consulted first: the same sheet, prompt and PNG bytes
 * within the retention window replay the earlier image for free, and only an
 * explicit `regenerate: true` spends a generation. A drawing may be generated
 * up to AI_GENERATION_LIMIT times per conversion (3 by default, 0 = unlimited).
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

  let body: GenerateRequestBody;
  try {
    body = await readGenerateBody(request);
  } catch (err) {
    const appError = toAppError(err);
    return Response.json(
      { success: false, error: userMessageForCode(appError.code) },
      { status: httpStatusForCode(appError.code) },
    );
  }

  if (!takeRateLimit(clientIpFrom(request.headers), config.rateLimitMax, 60_000)) {
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

  const baseName = stored.fileName.replace(/\.png$/i, "");
  const png = stored.buffer;

  // Prefer the identity written at convert time; fall back to hashing for
  // conversions stored before the `.meta` sidecar existed. Such a fallback
  // loses cross-upload cache reuse (the sheet id becomes the per-upload id),
  // which is the price of not re-hashing multi-megabyte PNGs for new uploads.
  const meta = await storageCall(() => readOutputSourceMeta(id), "Failed to read the output identity");
  if (!meta) {
    log(`No stored identity for ${id}; hashed the PNG instead.`);
  }
  const pngHash = meta?.pngHash || sha256Hex(png);
  const sheetId = meta?.sheetId || id;
  const viewName = meta?.viewName || "";
  const sourceHash = meta?.sourceHash || "";
  const basePromptHash = promptHash(composeAiPrompt(config));

  const aiPairId = computeAiPairId({ sheetId, viewName, promptHash: basePromptHash, pngHash });

  // Cache-first, and always before the allowance is charged: a re-requested
  // drawing still succeeds after the limit is reached. `regenerate` is the only
  // way past a live pair.
  if (!body.regenerate) {
    const pair = await storageCall(() => readAiPair(aiPairId), "Failed to read the AI pair cache");
    if (pair) {
      const fileName = pair.meta.fileName || `${baseName}-ai.png`;
      // Failure to persist the replayed copy surfaces as an error rather than
      // leaving the download route with nothing to serve.
      try {
        await saveAiOutput(id, pair.output, fileName);
      } catch (err) {
        log(`Storing the cached AI image failed: ${err instanceof Error ? err.message : String(err)}.`);
        return errorResponse("STORAGE_UNAVAILABLE");
      }
      const generationsUsed =
        (await storageCall(() => getAiGenerationCount(id), "Failed to read the generation count")) ?? 0;
      log(
        `Cache hit for ${aiPairId}: reusing an earlier AI image (${pair.output.byteLength} bytes) without calling Gemini.`
      );
      return Response.json(
        {
          success: true,
          conversionId: id,
          fileName,
          size: pair.output.byteLength,
          durationMs: 0,
          generationsUsed,
          generationsLimit: config.aiGenerationLimit,
          cached: true,
          source: "cached-pair",
          blocked: true,
          sourceHash: sourceHash || undefined,
        },
        { status: 200 },
      );
    }
  }

  // Claim the budget before the (up to 240s) Gemini call: checking the count
  // and incrementing afterwards would let two concurrent requests both see a
  // slot free and both spend one, so the pair is serialized per conversion.
  const limit = config.aiGenerationLimit;
  let claimed: Awaited<ReturnType<typeof claimAiGeneration>> | null = null;
  if (limit > 0) {
    const claim = await storageCall(() => claimAiGeneration(id, limit), "Failed to claim an AI generation slot");
    if (claim === null) {
      return errorResponse("STORAGE_UNAVAILABLE");
    }
    if (!claim.claimed) {
      log(`Generate limit reached for ${id} (${claim.generationsUsed}/${limit}).`);
      return limitResponse(limit);
    }
    claimed = claim;
  }

  try {
    log(`Sending ${id}.png (${png.byteLength} bytes) to Gemini for AI generation.`);

    const { image: rawImage, durationMs } = await generateDrawingImage(png, config);
    const image = await ensurePng(rawImage);
    log(`Gemini returned AI image (${rawImage.byteLength} bytes, stored as PNG ${image.byteLength} bytes) in ${durationMs}ms.`);

    const fileName = `${baseName}-ai.png`;
    await saveAiOutput(id, image, fileName);

    // Filing the pair is best-effort: losing it only costs a redundant Gemini
    // call on the next request, and must not fail a generation that already
    // succeeded and was stored.
    try {
      await saveAiPair({ aiPairId, sheetId, viewName, promptHash: basePromptHash, pngHash, fileName }, image);
    } catch (cacheErr) {
      log(`AI pair write failed (non-fatal): ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`);
    }

    let generationsUsed: number;
    if (claimed) {
      generationsUsed = claimed.generationsUsed;
    } else {
      // Unlimited mode keeps the counter for display but enforces nothing.
      generationsUsed =
        (await storageCall(() => incrementAiGenerationCount(id), "Failed to record the AI generation")) ?? 0;
    }
    log(`AI image written to ${id}.ai.png (generation ${generationsUsed}/${limit || "unlimited"}).`);

    return Response.json(
      {
        success: true,
        conversionId: id,
        fileName,
        size: image.byteLength,
        durationMs,
        generationsUsed,
        generationsLimit: limit,
        cached: false,
        source: "generated",
        blocked: false,
        regenerate: body.regenerate,
        sourceHash: sourceHash || undefined,
      },
      { status: 200 },
    );
  } catch (err) {
    // The slot was claimed before Gemini ran, so hand it back: the counter
    // tracks generations that actually produced an image, not attempts.
    if (claimed) {
      const released = await storageCall(
        () => releaseAiGenerationClaim(id),
        "Failed to release the claimed AI generation slot"
      );
      if (released === null) {
        log(`The generation counter may be inflated for ${id}: the claim could not be released.`);
      }
    }
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

/**
 * Re-encode the Gemini result to a true PNG. Gemini returns JPEG bytes, which
 * every layer of this app then calls `.png` — TilesView, the download route's
 * `image/png` header and the Supabase content type all depend on the bytes
 * actually being PNG. A failure here is cosmetic: fall back to the original
 * bytes rather than failing a generation that already succeeded.
 */
async function ensurePng(image: Buffer): Promise<Buffer> {
  try {
    return await sharp(image).png().toBuffer();
  } catch (err) {
    log(`PNG re-encode failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return image;
  }
}

export async function GET() {
  return Response.json(
    { success: false, error: "Use POST /api/generate/<id> to generate an AI image." },
    { status: 405, headers: { allow: "POST" } },
  );
}
