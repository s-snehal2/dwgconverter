import type { NextRequest } from "next/server";
import { getConfig, ensureTempDirs } from "@/server/config";
import type { AppConfig } from "@/server/config";
import { convertDwg } from "@/server/services/convertDwg";
import { sweepExpiredOutputs, saveOutput } from "@/server/services/outputStore";
import { deleteUploadBlob, isTrustedUploadUrl, readUploadBlob } from "@/server/services/uploadStore";
import { validateExtension, validateFileSize } from "@/server/utils/fileValidation";
import { toAppError, userMessageForCode, httpStatusForCode } from "@/server/utils/errors";
import { newConversionId, uploadPath, writeBufferFileAtomic, deleteFileIfExists } from "@/server/utils/storage";
import { clientIpFrom, takeRateLimit } from "@/server/utils/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 300;

function clientIp(request: NextRequest): string {
  return clientIpFrom(request.headers);
}

function log(message: string): void {
  console.info(`[convert] ${message}`);
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

/** A DWG ready to be converted, from either intake path. */
interface IncomingDwg {
  buffer: ArrayBuffer;
  originalFileName: string;
  /** Blob to delete afterwards, when the DWG arrived via a direct upload. */
  uploadUrl?: string;
  /** Temp file to delete afterwards, when the DWG arrived as multipart. */
  uploadAbs?: string;
}

type IntakeResult = { ok: true; dwg: IncomingDwg } | { ok: false; response: Response };

/**
 * Intake path A — multipart/form-data with a `file` field.
 *
 * Used whenever direct uploads are unavailable (local dev, tests) and for
 * anything small enough to survive the platform request-body cap.
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

  return {
    ok: true,
    dwg: {
      buffer: await file.arrayBuffer(),
      originalFileName: file.name,
      uploadAbs: uploadPath(config.uploadsDir, newConversionId()),
    },
  };
}

/**
 * Intake path B — JSON `{ uploadUrl, fileName }` naming a blob the browser
 * already pushed straight to storage.
 *
 * This is the only path that survives a real 20+ MB drawing, because the bytes
 * never travel through the serverless request body. The size check runs
 * against the bytes we actually pulled back rather than anything the client
 * claimed.
 */
async function readUploadedDwg(request: NextRequest, config: AppConfig): Promise<IntakeResult> {
  const payload = (await request.json().catch(() => null)) as {
    uploadUrl?: unknown;
    fileName?: unknown;
  } | null;

  const uploadUrl = typeof payload?.uploadUrl === "string" ? payload.uploadUrl : "";
  const fileName = typeof payload?.fileName === "string" ? payload.fileName : "";

  if (!uploadUrl || !isTrustedUploadUrl(uploadUrl)) {
    return { ok: false, response: errorResponse("INVALID_FILE") };
  }

  const extensionCheck = validateExtension(fileName);
  if (!extensionCheck.ok) {
    return { ok: false, response: errorResponse(extensionCheck.error.code) };
  }

  let buffer: Buffer;
  try {
    buffer = await readUploadBlob(uploadUrl);
  } catch (err) {
    log(`Could not read uploaded DWG: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, response: errorResponse("INVALID_FILE") };
  }

  const sizeCheck = validateFileSize(buffer.byteLength, config.maxFileSizeBytes);
  if (!sizeCheck.ok) {
    // Already pulled out of storage, so clean it up here; the success path
    // deletes the upload in `finally` but this request never reaches it.
    await deleteUploadBlob(uploadUrl);
    return { ok: false, response: errorResponse(sizeCheck.error.code) };
  }

  return {
    ok: true,
    dwg: {
      buffer: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      ) as ArrayBuffer,
      originalFileName: fileName,
      uploadUrl,
    },
  };
}

/**
 * POST /api/convert
 *
 * Accepts either multipart/form-data with a `file` field or JSON naming a DWG
 * already uploaded to Blob. Converts a DWG into one PNG per paper-space layout
 * sheet (or the model space when there are no layouts) and responds with a
 * `sheets` array of self-contained ConversionResult objects.
 */
export async function POST(request: NextRequest) {
  const config = getConfig();

  try {
    const removed = await sweepExpiredOutputs(config.cleanupAgeMs);
    if (removed > 0) {
      log(`Cleanup removed ${removed} expired temporary file(s).`);
    }
  } catch (err) {
    log(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!takeRateLimit(clientIp(request), config.rateLimitMax, 60_000)) {
    return errorResponse("RATE_LIMITED");
  }

  ensureTempDirs(config);

  const contentType = request.headers.get("content-type") ?? "";
  const intake = contentType.includes("application/json")
    ? await readUploadedDwg(request, config)
    : await readMultipartDwg(request, config);

  if (!intake.ok) {
    return intake.response;
  }

  const { buffer, originalFileName, uploadUrl, uploadAbs } = intake.dwg;
  const baseName = originalFileName.replace(/\.dwg$/i, "");
  const receivedBytes = buffer.byteLength;

  try {
    if (uploadAbs) {
      writeBufferFileAtomic(uploadAbs, new Uint8Array(buffer));
    }
    log(
      uploadUrl
        ? `File received via direct upload: ${originalFileName} (${receivedBytes} bytes) from ${uploadUrl}.`
        : `File received: ${originalFileName} (${receivedBytes} bytes), stored as ${uploadAbs}.`
    );

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

    for (const sheet of sheets) {
      await saveOutput(sheet.conversionId, sheet.output.png, sheet.fileName);
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
  } finally {
    if (uploadAbs) {
      deleteFileIfExists(uploadAbs);
      deleteFileIfExists(`${uploadAbs}.name`);
    }
    if (uploadUrl) {
      await deleteUploadBlob(uploadUrl);
      log(`Removed uploaded DWG ${uploadUrl}.`);
    }
  }
}

export async function GET() {
  return Response.json(
    { success: false, error: "Use POST /api/convert to convert a DWG file." },
    { status: 405 }
  );
}