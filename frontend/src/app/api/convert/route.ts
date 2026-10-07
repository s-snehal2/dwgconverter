import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import type { AppConfig } from "@/server/config";
import { convertDwg } from "@/server/services/convertDwg";
import { sweepExpiredOutputsThrottled, saveOutput } from "@/server/services/outputStore";

import { validateExtension, validateFileSize, validateDwgSignature } from "@/server/utils/fileValidation";
import { toAppError, userMessageForCode, httpStatusForCode } from "@/server/utils/errors";
import { newConversionId } from "@/server/utils/storage";
import { sha256Hex } from "@/server/utils/hash";
import { clientIpFrom, takeRateLimit } from "@/server/utils/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 300;

function clientIp(request: NextRequest): string {
  return clientIpFrom(request.headers);
}

/**
 * Make a caller-supplied value safe to write into one log line.
 *
 * Sheet names and file names come straight from the DWG, so they can contain
 * newlines, CR, or ANSI escapes. Unescaped, a crafted name can forge whole extra
 * log lines (or rewrite a terminal), which is log injection — so control
 * characters are replaced before they reach the console.
 */
function logSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function log(message: string): void {
  console.info(`[convert] ${logSafe(message)}`);
}

/** Slugify a sheet/layout name for use inside a filename. */
function slugifySheetName(name: string, index: number): string {
  const cleaned = name
    .replace(/[^\w\-. ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned : `Sheet ${index + 1}`;
}

function errorResponse(code: Parameters<typeof userMessageForCode>[0]): Response {
  return Response.json({ success: false, error: userMessageForCode(code) }, { status: httpStatusForCode(code) });
}

/** A DWG ready to be converted, from the multipart intake. */
interface IncomingDwg {
  buffer: ArrayBuffer;
  originalFileName: string;
}

type IntakeResult = { ok: true; dwg: IncomingDwg } | { ok: false; response: Response };

/**
 * Intake — multipart/form-data with a `file` field.
 *
 * The bytes are converted straight out of the request buffer and are never
 * written anywhere: a DWG is parsed in-process and discarded, so no DWG is ever
 * persisted to disk or Supabase Storage.
 */
async function readMultipartDwg(request: NextRequest, config: AppConfig): Promise<IntakeResult> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { ok: false, response: errorResponse("INVALID_FILE") };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, response: errorResponse("INVALID_FILE") };
  }

  const extensionCheck = validateExtension(file.name);
  if (!extensionCheck.ok) {
    return { ok: false, response: errorResponse(extensionCheck.error.code) };
  }

  const sizeCheck = validateFileSize(file.size, config.maxFileSizeBytes);
  if (!sizeCheck.ok) {
    return { ok: false, response: errorResponse(sizeCheck.error.code) };
  }

  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const sigCheck = validateDwgSignature(header);
  if (!sigCheck.ok) {
    return { ok: false, response: errorResponse(sigCheck.error.code) };
  }

  return {
    ok: true,
    dwg: {
      buffer: await file.arrayBuffer(),
      originalFileName: file.name,
    },
  };
}

/**
 * POST /api/convert
 *
 * Accepts multipart/form-data with a `file` field. Converts a DWG into one PNG
 * per paper-space layout sheet (or the model space when there are no layouts)
 * and responds with a `sheets` array of self-contained ConversionResult objects.
 */
export async function POST(request: NextRequest) {
  const config = getConfig();

  if (!takeRateLimit(clientIp(request), config.rateLimitMax, 60_000)) {
    return errorResponse("RATE_LIMITED");
  }

  const intake = await readMultipartDwg(request, config);
  if (!intake.ok) {
    return intake.response;
  }

  // Sweep only once intake has succeeded, so rejected or malformed requests
  // never pay for a bucket scan. The pass covers `outputs/`, the legacy
  // `uploads/` prefix, and expired AI-pair cache entries.
  try {
    const removed = await sweepExpiredOutputsThrottled(config.cleanupAgeMs);
    if (removed > 0) {
      log(`Cleanup removed ${removed} expired temporary file(s).`);
    }
  } catch (err) {
    log(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { buffer, originalFileName } = intake.dwg;
  const baseName = originalFileName.replace(/\.dwg$/i, "");
  const receivedBytes = buffer.byteLength;

  try {
    // `log` escapes control characters, so the caller-supplied names below are
    // safe to interpolate even though they come from the DWG.
    log(`File received: ${originalFileName} (${receivedBytes} bytes).`);

    const started = Date.now();
    const { sheets: outputs, omittedBlankSheets } = await convertDwg(buffer, config, { info: log });

    const usedNames = new Map<string, number>();
    const sheets = outputs.map((output, index) => {
      if (!output.png.byteLength) {
        throw new Error("PNG output is empty.");
      }
      const conversionId = newConversionId();
      const displayName = output.viewName?.trim() || slugifySheetName(output.viewName ?? "", index);
      const safeSheet = slugifySheetName(displayName, index);
      const usedCount = usedNames.get(safeSheet.toLowerCase()) ?? 0;
      usedNames.set(safeSheet.toLowerCase(), usedCount + 1);
      const fileName =
        usedCount === 0
          ? `${baseName}-${safeSheet}.png`
          : `${baseName}-${safeSheet} (${usedCount + 1}).png`;
      return { conversionId, fileName, displayName, safeSheet, output };
    });

    // Content identity, computed once for the whole upload: `sourceHash` files
    // the drawing, `pngHash` files each sheet's AI pair. Both are written now so
    // `/api/generate` can find them by id instead of re-hashing a multi-megabyte
    // PNG per request.
    const sourceHash = sha256Hex(new Uint8Array(buffer));

    for (const [index, sheet] of sheets.entries()) {
      const pngHash = sha256Hex(sheet.output.png);
      await saveOutput(sheet.conversionId, sheet.output.png, sheet.fileName, {
        sourceHash,
        pngHash,
        // Derived from the DWG's bytes and the layout's position, never from the
        // per-upload conversion id: this has to survive a re-upload for the AI
        // pair cache to recognise the same drawing.
        sheetId: `${sourceHash}:${index}`,
        viewName: sheet.output.viewName ?? sheet.displayName,
      });
      log(
        `Converted ${originalFileName} → ${sheet.fileName} (${sheet.output.png.byteLength} bytes) for sheet "${sheet.safeSheet}".`
      );
    }

    return Response.json(
      {
        success: true,
        originalFileName,
        sheetCount: sheets.length,
        omittedBlankSheets,
        sheets: sheets.map((sheet) => ({
          success: true,
          conversionId: sheet.conversionId,
          originalFileName,
          fileName: sheet.fileName,
          sheetName: sheet.displayName,
          viewId: sheet.output.isModel ? "model" : "layout",
          size: sheet.output.png.byteLength,
          version: sheet.output.version,
          statistics: sheet.output.statistics,
          warnings: sheet.output.statistics.warnings,
          durationMs: sheet.output.totalDurationMs,
        })),
        version: sheets[0]?.output.version ?? null,
        durationMs: Date.now() - started,
      },
      { status: 200 }
    );
  } catch (err) {
    const appError = toAppError(err);
    log(
      `Conversion failed (${appError.code}): ${err instanceof Error ? err.message : String(err)} for file "${originalFileName}" (${receivedBytes} bytes).`
    );
    const status = httpStatusForCode(appError.code);
    if (status >= 500) {
      console.error(err);
    }
    // MULTIPLE_LAYOUTS carries a count the user can act on, so it is shown
    // verbatim. CONVERSION_TIMEOUT logs its internal detail above and shows the
    // friendly `USER_MESSAGES` text.
    const message =
      appError.code === "MULTIPLE_LAYOUTS"
        ? appError.message
        : userMessageForCode(appError.code);
    return Response.json(
      { success: false, error: message },
      { status }
    );
  }
}

export async function GET() {
  return Response.json(
    { success: false, error: "Use POST /api/convert to convert a DWG file." },
    { status: 405 }
  );
}