import { describe, expect, it } from "vitest";
import { validateDwgSignature } from "./fileValidation";

function head(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

describe("validateDwgSignature", () => {
  it("accepts a supported AC1018 signature", () => {
    const result = validateDwgSignature(head(0x41, 0x43, 0x31, 0x30, 0x31, 0x38));
    expect(result.ok).toBe(true);
  });

  it("accepts R13 (AC1012), the oldest supported version", () => {
    const result = validateDwgSignature(head(0x41, 0x43, 0x31, 0x30, 0x31, 0x32));
    expect(result.ok).toBe(true);
  });

  it("accepts AC1032, which covers AutoCAD 2018 through 2027", () => {
    const result = validateDwgSignature(head(0x41, 0x43, 0x31, 0x30, 0x33, 0x32));
    expect(result.ok).toBe(true);
  });

  it("rejects pre-R13 versions the parser cannot read", () => {
    // AC1009 is AutoCAD R11/R12; acad-ts throws CadNotSupportedException for
    // it, so it must never reach the parser.
    const result = validateDwgSignature(head(0x41, 0x43, 0x31, 0x30, 0x30, 0x39));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED_DWG_VERSION");
      expect(result.error.message).toContain("AC1009");
      expect(result.error.message).toContain("R13");
    }
  });

  it("rejects a non-DWG file", () => {
    const result = validateDwgSignature(head(0x50, 0x4b, 0x03, 0x04));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CORRUPTED_DWG");
    }
  });

  it("rejects an unsupported DWG version", () => {
    const result = validateDwgSignature(head(0x41, 0x43, 0x31, 0x30, 0x31, 0x30));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED_DWG_VERSION");
      expect(result.error.message).toContain("AC1010");
    }
  });

  it("accepts a signature when the version bytes are shorter than 6", () => {
    const result = validateDwgSignature(head(0x41, 0x43, 0x31, 0x30, 0x31));
    expect(result.ok).toBe(true);
  });
});