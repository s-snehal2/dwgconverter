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

/** Where the direct-upload capability probe and signed-URL mint live. */
const UPLOAD_ROUTE = "/api/upload";

/** The server's direct-upload capability, as reported by `GET /api/upload`. */
interface UploadCapability {
  directUpload: boolean;
  maxBytes: number;
}

/**
 * Cached capability probe. Only a successful response is cached: a transient
 * network failure must not pin the session to the slow multipart path.
 */
let cachedCapability: UploadCapability | null | undefined;

async function getUploadCapability(): Promise<UploadCapability | null> {
  if (cachedCapability !== undefined) {
    return cachedCapability;
  }
  try {
    const res = await fetch(UPLOAD_ROUTE, { method: "GET" });
    if (!res.ok) {
      cachedCapability = null;
      return cachedCapability;
    }
    const data = (await res.json().catch(() => null)) as Partial<UploadCapability> | null;
    cachedCapability =
      data?.directUpload === true && typeof data.maxBytes === "number"
        ? { directUpload: true, maxBytes: data.maxBytes }
        : null;
    return cachedCapability;
  } catch {
    return null;
  }
}

/** Mint a signed upload URL from the server for one DWG. */
async function mintSignedUpload(
  file: File,
  signal?: AbortSignal
): Promise<{ uploadId: string; signedUrl: string; maxBytes: number }> {
  let res: Response;
  try {
    res = await fetch(UPLOAD_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, size: file.size }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    throw new Error("Could not reach the server. Please try again.");
  }
  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; error?: string; uploadId?: unknown; signedUrl?: unknown; maxBytes?: unknown }
    | null;
  if (!res.ok || !data?.success || typeof data.signedUrl !== "string" || typeof data.uploadId !== "string") {
    throw new Error(typeof data?.error === "string" ? data.error : "Could not start the upload. Please try again.");
  }
  return {
    uploadId: data.uploadId,
    signedUrl: data.signedUrl,
    maxBytes: typeof data.maxBytes === "number" ? data.maxBytes : file.size,
  };
}

/**
 * PUT the file to the signed URL with upload progress.
 *
 * XMLHttpRequest is the only browser API that reports request-body progress,
 * which is what drives the progress bar. The URL carries the auth token, so
 * the request needs no headers of its own and nothing server-side ever sees
 * the bytes.
 */
function putToSignedUrl(
  url: string,
  file: File,
  options?: { signal?: AbortSignal; onProgress?: (fraction: number) => void }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const detach = () => signal?.removeEventListener("abort", onAbort);

    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options?.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      detach();
      if (xhr.status >= 200 && xhr.status < 300) {
        options?.onProgress?.(1);
        resolve();
      } else {
        reject(new Error("The file upload failed. Please try again."));
      }
    };
    xhr.onerror = () => {
      detach();
      reject(new Error("The file upload failed. Please try again."));
    };
    xhr.onabort = () => {
      detach();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort);
    xhr.send(file);
  });
}

/**
 * Direct path: mint a signed URL, PUT the bytes straight to Supabase, then
 * ask `/api/convert` to fetch the staged object. Only the small JSON
 * envelopes travel through the function, so the file is bounded by the
 * server's `maxBytes` rather than the platform request-body cap. The server
 * deletes the staged DWG before the convert response is sent.
 */
async function convertViaDirectUpload(
  file: File,
  capability: UploadCapability,
  options?: { signal?: AbortSignal; onUploadProgress?: (fraction: number) => void }
): Promise<MultiSheetResult> {
  if (file.size > capability.maxBytes) {
    const maxMb = Math.floor(capability.maxBytes / (1024 * 1024));
    throw new Error(`File is larger than the ${maxMb}MB limit.`);
  }

  const signed = await mintSignedUpload(file, options?.signal);
  await putToSignedUrl(signed.signedUrl, file, {
    signal: options?.signal,
    onProgress: options?.onUploadProgress,
  });

  let res: Response;
  try {
    res = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: signed.uploadId, fileName: file.name, size: file.size }),
      signal: options?.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    throw new Error("Could not reach the server. Please try again.");
  }

  return parseJsonResponse<MultiSheetResult>(res, "Conversion failed. Please try again.");
}

/** Post the DWG as multipart form data (fallback when direct upload is off). */
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
 * Picks the transport from the server's capability probe: when Supabase
 * credentials are configured the file is PUTed straight to a signed storage
 * URL, so the limit is `MAX_FILE_SIZE_MB` (40 MB by default). Otherwise it
 * falls back to multipart, bounded by the platform's ~4.5 MB request-body
 * cap.
 */
export async function convertDwgFile(
  file: File,
  options?: { signal?: AbortSignal; onUploadProgress?: (fraction: number) => void }
): Promise<MultiSheetResult> {
  const capability = await getUploadCapability();
  if (capability) {
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
