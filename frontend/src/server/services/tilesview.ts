import { AppError } from "../utils/errors";
import type { AppConfig } from "../config";

interface TilesviewResponse {
  status: boolean;
  code?: number;
  message?: string;
  data?: { custom_rooms_id?: number } | null;
}

/**
 * Detect the real image format from the magic bytes. The stored bytes may be
 * JPEG even though every layer of the app calls them `.png` — Gemini returns
 * JPEG — and TilesView must be told the truth about what it is receiving.
 */
function sniffImageType(image: Buffer): { mimeType: string; fileName: string } {
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return { mimeType: "image/jpeg", fileName: "room.jpg" };
  }
  if (image.length >= 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) {
    return { mimeType: "image/png", fileName: "room.png" };
  }
  return { mimeType: "application/octet-stream", fileName: "room.bin" };
}

/**
 * Upload a room image (the AI visualization) to the TilesView room-planner
 * API. Returns the assigned custom_rooms_id.
 */
export async function sendRoomToTilesview(
  image: Buffer,
  config: AppConfig,
): Promise<number> {
  if (!config.tilesviewAppKey || !config.tilesviewAppSecret) {
    throw new AppError(
      "TILESVIEW_ERROR",
      "TilesView credentials are not configured.",
    );
  }

  const { mimeType, fileName } = sniffImageType(image);
  const form = new FormData();
  form.append(
    "image",
    new Blob([image as unknown as BlobPart], { type: mimeType }),
    fileName,
  );

  let res: Response;
  try {
    res = await fetch(config.tilesviewApiUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        app_key: config.tilesviewAppKey,
        app_secret: config.tilesviewAppSecret,
      },
      body: form,
      // Never hang the serverless function: the route has `maxDuration = 60`,
      // so a stuck upstream must be cut off well short of that.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new AppError(
        "TILESVIEW_ERROR",
        "The TilesView request timed out after 30 seconds.",
      );
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new AppError("TILESVIEW_ERROR", "The TilesView request was aborted.");
    }
    throw err;
  }

  const text = await res.text().catch(() => "");
  let data: TilesviewResponse | null = null;
  try {
    data = JSON.parse(text) as TilesviewResponse;
  } catch {
    // Body is not JSON (e.g. an HTML page).
  }

  if (!res.ok || !data || data.status !== true || typeof data.data?.custom_rooms_id !== "number") {
    const contentType = res.headers.get("content-type") ?? "unknown";
    const detail = data?.message ?? `HTTP ${res.status} (${contentType}) — ${text.slice(0, 200)}`;
    throw new AppError("TILESVIEW_ERROR", `TilesView error: ${detail}`);
  }

  return data.data.custom_rooms_id;
}
