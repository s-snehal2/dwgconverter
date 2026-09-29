/**
 * Error taxonomy for the conversion pipeline. Internal error messages are
 * never sent to the browser: only the `code`-derived friendly message is.
 */
export type ErrorCode =
  | "INVALID_FILE"
  | "INVALID_PROMPT"
  | "UNSUPPORTED_EXTENSION"
  | "FILE_TOO_LARGE"
  | "CONVERSION_TIMEOUT"
  | "CORRUPTED_DWG"
  | "UNSUPPORTED_DWG_VERSION"
  | "MULTIPLE_LAYOUTS"
  | "PARSER_ERROR"
  | "RENDER_ERROR"
  | "PNG_GENERATION_ERROR"
  | "NO_DRAWABLE_CONTENT"
  | "AI_NOT_CONFIGURED"
  | "AI_GENERATION_ERROR"
  | "AI_LIMIT_REACHED"
  | "FILE_NOT_FOUND"
  | "DOWNLOAD_ERROR"
  | "RATE_LIMITED"
  | "STORAGE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "TILESVIEW_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

const USER_MESSAGES: Record<ErrorCode, string> = {
  INVALID_FILE: "The uploaded file could not be read.",
  INVALID_PROMPT: "The AI prompt is too long. Please use a shorter prompt.",
  UNSUPPORTED_EXTENSION: "Only DWG files are supported.",
  FILE_TOO_LARGE: "File size exceeds the allowed limit.",
  CONVERSION_TIMEOUT: "This drawing is too complex to convert in time. Try a smaller file, or split it and convert one part at a time.",
  CORRUPTED_DWG: "Unable to read DWG file. It may be corrupted or password-protected.",
  UNSUPPORTED_DWG_VERSION: "Unsupported DWG version. R13 (AC1012) and newer are supported.",
  MULTIPLE_LAYOUTS: "This DWG contains more layout sheets than this conversion supports. Raise MAX_LAYOUTS to allow more sheets.",
  PARSER_ERROR: "The DWG file could not be parsed.",
  RENDER_ERROR: "The drawing could not be rendered.",
  PNG_GENERATION_ERROR: "The PNG image could not be generated.",
  NO_DRAWABLE_CONTENT: "No drawable content was found in this DWG file.",
  AI_NOT_CONFIGURED: "AI image generation is not configured on this server.",
  AI_GENERATION_ERROR: "The AI image could not be generated. Please try again.",
  AI_LIMIT_REACHED: "You've reached the maximum number of AI image generations for this drawing. Convert the DWG again to generate more.",
  FILE_NOT_FOUND: "The requested conversion result no longer exists.",
  DOWNLOAD_ERROR: "The PNG could not be downloaded.",
  RATE_LIMITED: "Too many requests. Please try again shortly.",
  STORAGE_UNAVAILABLE: "The storage service is temporarily unavailable. Please try again later.",
  INTERNAL_ERROR: "Conversion failed. Please try again.",
  TILESVIEW_ERROR: "The AI image could not be sent to TilesView.",
};

export function userMessageForCode(code: ErrorCode): string {
  return USER_MESSAGES[code];
}

export function httpStatusForCode(code: ErrorCode): number {
  switch (code) {
    case "INVALID_FILE":
    case "INVALID_PROMPT":
    case "UNSUPPORTED_EXTENSION":
    case "FILE_TOO_LARGE":
      return 400;
    case "CONVERSION_TIMEOUT":
    case "CORRUPTED_DWG":
    case "UNSUPPORTED_DWG_VERSION":
    case "MULTIPLE_LAYOUTS":
    case "PARSER_ERROR":
    case "NO_DRAWABLE_CONTENT":
      return 422;
    case "FILE_NOT_FOUND":
      return 404;
    case "AI_NOT_CONFIGURED":
    case "STORAGE_UNAVAILABLE":
      return 503;
    case "RATE_LIMITED":
    case "AI_LIMIT_REACHED":
      return 429;
    case "RENDER_ERROR":
    case "PNG_GENERATION_ERROR":
    case "AI_GENERATION_ERROR":
    case "DOWNLOAD_ERROR":
    case "TILESVIEW_ERROR":
    case "INTERNAL_ERROR":
      return 500;
    default:
      return 500;
  }
}

/** Convert any thrown value into an AppError without leaking internals. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }
  if (err instanceof Error) {
    const message = err.message;
    const lower = message.toLowerCase();
    // Storage backends must be distinguishable from app bugs so a suspended
    // or down store returns a retryable 503 rather than a generic 500.
    if (
      err.name === "BlobStoreSuspendedError" ||
      lower.includes("store has been suspended") ||
      lower.includes("store is suspended") ||
      lower.includes("usage_threshold_limits_reached") ||
      lower.includes("storage is unavailable")
    ) {
      return new AppError("STORAGE_UNAVAILABLE", message);
    }
    // Rasterization failures must not be misread as "unsupported DWG version",
    // so the PNG/sharp checks come before the generic `unsupported` check.
    if (
      lower.includes("sharp") ||
      lower.includes("input buffer") ||
      lower.includes("png") ||
      lower.includes("vips")
    ) {
      return new AppError("PNG_GENERATION_ERROR", message);
    }
    if (lower.includes("unsupported dwg") || lower.includes("unsupported version") || lower.includes("ac10")) {
      return new AppError("UNSUPPORTED_DWG_VERSION", message);
    }
    if (lower.includes("magic") || lower.includes("corrupt") || lower.includes("header")) {
      return new AppError("CORRUPTED_DWG", message);
    }
    if (lower.includes("entit") || lower.includes("drawable") || lower.includes("model space")) {
      return new AppError("NO_DRAWABLE_CONTENT", message);
    }
    if (lower.includes("render") || lower.includes("svg")) {
      return new AppError("RENDER_ERROR", message);
    }
    if (lower.includes("api key") || lower.includes("apikey")) {
      return new AppError("AI_NOT_CONFIGURED", message);
    }
    if (lower.includes("gemini") || lower.includes("ai image") || lower.includes("generatecontent")) {
      return new AppError("AI_GENERATION_ERROR", message);
    }
    return new AppError("INTERNAL_ERROR", message);
  }
  return new AppError("INTERNAL_ERROR", String(err));
}