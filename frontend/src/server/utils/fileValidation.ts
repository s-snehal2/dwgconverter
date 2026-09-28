import { AppError } from "./errors";

/** Supported DWG signature versions (R13 through AutoCAD 2018 and newer). */
const SUPPORTED_DWG_VERSIONS = new Set([
  "AC1012", // R13
  "AC1014", // R14
  "AC1015", // 2000
  "AC1018", // 2004
  "AC1021", // 2007
  "AC1024", // 2010
  "AC1027", // 2013
  "AC1032", // 2018 (also 2019-2027; the format has not changed since)
]);

export interface ValidationResultOk {
  ok: true;
}

export interface ValidationResultError {
  ok: false;
  error: AppError;
}

export type ValidationResult = ValidationResultOk | ValidationResultError;

export function validateExtension(fileName: string | undefined): ValidationResult {
  if (!fileName || fileName.trim().length === 0) {
    return { ok: false, error: new AppError("INVALID_FILE", "No file provided.") };
  }
  if (!fileName.toLowerCase().endsWith(".dwg")) {
    return { ok: false, error: new AppError("UNSUPPORTED_EXTENSION", "Only DWG files are supported.") };
  }
  return { ok: true };
}

export function validateFileSize(size: number, maxBytes: number): ValidationResult {
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: new AppError("INVALID_FILE", "The uploaded file is empty.") };
  }
  if (size > maxBytes) {
    return { ok: false, error: new AppError("FILE_TOO_LARGE", "File size exceeds the allowed limit.") };
  }
  return { ok: true };
}

/**
 * Validate the DWG binary signature ("AC10") and, when possible, the version.
 * `head` must contain at least the first six bytes of the file.
 */
export function validateDwgSignature(head: Uint8Array): ValidationResult {
  if (head.length < 4 || head[0] !== 0x41 || head[1] !== 0x43 || head[2] !== 0x31 || head[3] !== 0x30) {
    return {
      ok: false,
      error: new AppError(
        "CORRUPTED_DWG",
        "This file does not look like a valid DWG drawing. It may be corrupted or password-protected."
      ),
    };
  }
  if (head.length >= 6) {
    const version = String.fromCharCode(head[0], head[1], head[2], head[3], head[4], head[5]);
    if (!SUPPORTED_DWG_VERSIONS.has(version)) {
      return {
        ok: false,
        error: new AppError(
          "UNSUPPORTED_DWG_VERSION",
          `Unsupported DWG version "${version}". R13 (AC1012) and newer are supported.`
        ),
      };
    }
  }
  return { ok: true };
}