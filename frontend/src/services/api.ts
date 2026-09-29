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

/** Shared error handling for JSON-shaped API responses. */
async function parseJsonResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
  const data = (await res.json().catch(() => null)) as (T & ConversionError) | ConversionError | null;

  if (!res.ok || !data || !("success" in data) || !data.success) {
    const message =
      data && "error" in data && typeof data.error === "string"
        ? data.error
        : fallbackMessage;
    throw new Error(message);
  }

  return data as T;
}

/** Where the direct-upload capability route lives. */
const UPLOAD_ROUTE = "/api/blob/upload";

/** Uploads at or above this size are sent as parallel multipart parts. */
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;

interface DirectUploadCapability {
  directUpload: boolean;
  access: "private" | "public";
  prefix: string;
  maxBytes: number;
}

let cachedCapability: DirectUploadCapability | undefined;

/**
 * Ask the server whether direct-to-Blob uploads are available.
 * Anything unexpected (offline, 404 in local dev) resolves to `null` so the
 * caller falls back to a normal multipart POST.
 *
 * Only a *positive* answer is cached. A negative one is not, so the next
 * attempt re-checks — e.g. once a suspended Blob store comes back, direct
 * uploads resume without a page reload.
 */
async function getDirectUploadCapability(): Promise<DirectUploadCapability | null> {
  if (cachedCapability !== undefined) {
    return cachedCapability;
  }
  try {
    const res = await fetch(UPLOAD_ROUTE, { method: "GET" });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as Partial<DirectUploadCapability>;
    if (data?.directUpload !== true) {
      return null;
    }
    cachedCapability = {
      directUpload: true,
      access: data.access === "public" ? "public" : "private",
      prefix: typeof data.prefix === "string" ? data.prefix : "uploads/",
      maxBytes: typeof data.maxBytes === "number" ? data.maxBytes : Number.MAX_SAFE_INTEGER,
    };
  } catch {
    return null;
  }
  return cachedCapability;
}

/** Blob pathnames reject separators and control characters. */
function safeBlobName(name: string): string {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-120);
  return cleaned || "drawing.dwg";
}

/** Push the DWG straight to Blob, then convert by URL. */
async function convertViaDirectUpload(
  file: File,
  capability: DirectUploadCapability,
  options?: { signal?: AbortSignal; onUploadProgress?: (fraction: number) => void }
): Promise<MultiSheetResult> {
  const { upload } = await import("@vercel/blob/client");
  const blob = await upload(`${capability.prefix}${safeBlobName(file.name)}`, file, {
    access: capability.access,
    handleUploadUrl: UPLOAD_ROUTE,
    contentType: "application/octet-stream",
    multipart: file.size >= MULTIPART_THRESHOLD_BYTES,
    abortSignal: options?.signal,
    onUploadProgress: ({ percentage }) => options?.onUploadProgress?.(percentage / 100),
  });

  const res = await fetch("/api/convert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadUrl: blob.url, fileName: file.name }),
    signal: options?.signal,
  });

  return parseJsonResponse<MultiSheetResult>(res, "Conversion failed. Please try again.");
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
 * Uses a direct Blob upload when the server supports it, so large drawings are
 * not blocked by the platform request-body limit, and falls back to multipart
 * otherwise.
 */
export async function convertDwgFile(
  file: File,
  options?: { signal?: AbortSignal; onUploadProgress?: (fraction: number) => void }
): Promise<MultiSheetResult> {
  const capability = await getDirectUploadCapability();
  if (capability && file.size <= capability.maxBytes) {
    return convertViaDirectUpload(file, capability, options);
  }
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
 * PNG. The optional `prompt` lets the user describe the image they want; when
 * empty, the server uses the built-in default prompt.
 */
export async function generateAiImage(
  conversionId: string,
  prompt?: string,
  options?: { signal?: AbortSignal }
): Promise<AiImageResult> {
  let res: Response;
  try {
    res = await fetch(`/api/generate/${encodeURIComponent(conversionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt?.trim() || undefined }),
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
