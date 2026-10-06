import type {
  ConversionError,
  AiImageResult,
  MultiSheetResult,
  TilesviewResult,
} from "@/types/conversion";

/** Client wrapper for the DWG → PNG API endpoints. */

/** Whether a fetch was cancelled via an AbortController. */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * An error carrying a server message plus any structured fields the error
 * envelope supplied, so callers can react to a machine-readable detail (e.g.
 * `generationsLimit` on a 429) instead of only showing the text.
 */
export interface ApiError extends Error {
  /** Numeric fields echoed by the server's error envelope. */
  details?: Record<string, number>;
}

/** Shared error handling for JSON-shaped API responses. */
async function parseJsonResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
  const data = (await res.json().catch(() => null)) as (T & ConversionError) | ConversionError | null;

  if (!res.ok || !data || !("success" in data) || !data.success) {
    const message =
      data && "error" in data && typeof data.error === "string"
        ? data.error
        : fallbackMessage;
    const error: ApiError = new Error(message);
    // Preserve any numeric extras the route attached (e.g. `generationsLimit`).
    if (data && typeof data === "object") {
      const details: Record<string, number> = {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "number") {
          details[key] = value;
        }
      }
      if (Object.keys(details).length > 0) {
        error.details = details;
      }
    }
    throw error;
  }

  return data as T;
}

/** Post the DWG as multipart form data. */
async function convertViaMultipart(
  file: File,
  options?: { signal?: AbortSignal; onUploadProgress?: (fraction: number) => void }
): Promise<MultiSheetResult> {
  const formData = new FormData();
  formData.append("file", file);

  let res: Response;
  try {
    // fetch() exposes no upload progress, so report the transfer as started and
    // let the stepper move on to the server-side stages.
    options?.onUploadProgress?.(1);
    res = await fetch("/api/convert", {
      method: "POST",
      body: formData,
      signal: options?.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    throw new Error("Could not reach the server. Please try again.");
  }

  if (res.status === 413) {
    // The platform rejected the body before the function ran. Its error page is
    // HTML, so there is nothing useful to parse — say what actually happened.
    throw new Error(
      `This file is too large to send to the server (about ${(file.size / (1024 * 1024)).toFixed(1)} MB). ` +
        `The hosting platform limits request bodies to roughly 4.5 MB.`
    );
  }

  return parseJsonResponse<MultiSheetResult>(res, "Conversion failed. Please try again.");
}

/**
 * Convert a DWG — renders every sheet to its own PNG.
 *
 * Always multipart: the direct-to-storage path is gone, so a DWG is bounded by
 * the platform request-body limit rather than by `MAX_FILE_SIZE_MB`.
 */
export async function convertDwgFile(
  file: File,
  options?: { signal?: AbortSignal; onUploadProgress?: (fraction: number) => void }
): Promise<MultiSheetResult> {
  return convertViaMultipart(file, options);
}

/** Build the download URL for a completed conversion. */
export function downloadUrl(conversionId: string): string {
  return `/api/download/${encodeURIComponent(conversionId)}`;
}

/** Build the download URL for an AI-generated image. */
export function aiDownloadUrl(conversionId: string): string {
  return `/api/download-ai/${encodeURIComponent(conversionId)}`;
}

/**
 * Call the server to generate an AI image from the already-converted DWG sheet
 * PNG. The prompt is configured server-side, so nothing but the regeneration
 * flag is sent.
 */
export async function generateAiImage(
  conversionId: string,
  options?: { signal?: AbortSignal; regenerate?: boolean }
): Promise<AiImageResult> {
  let res: Response;
  try {
    res = await fetch(`/api/generate/${encodeURIComponent(conversionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // An explicit regeneration must bypass the 30-day reuse cache, otherwise
        // the server would replay the identical image and the button would do
        // nothing visible.
        regenerate: options?.regenerate === true ? true : undefined,
      }),
      signal: options?.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    throw new Error("Could not reach the server. Please try again.");
  }

  return parseJsonResponse<AiImageResult>(res, "AI image generation failed. Please try again.");
}

/** Call the server to upload a generated AI image to TilesView. */
export async function sendToTilesview(
  conversionId: string,
  options?: { signal?: AbortSignal }
): Promise<TilesviewResult> {
  let res: Response;
  try {
    res = await fetch(`/api/tilesview/${encodeURIComponent(conversionId)}`, {
      method: "POST",
      signal: options?.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    throw new Error("Could not reach the server. Please try again.");
  }
  return parseJsonResponse<TilesviewResult>(res, "Sending to TilesView failed. Please try again.");
}
