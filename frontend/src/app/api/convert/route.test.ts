import { describe, expect, it, afterEach, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, del } from "@vercel/blob";
import { POST } from "./route";
import { minimalDwgBytes } from "@/server/services/testFixture";

vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (pathname: string) => ({ url: `https://blob.test/${pathname}`, pathname })),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ blobs: [], hasMore: false })),
  del: vi.fn(async () => undefined),
}));

const mockedGet = vi.mocked(get);
const mockedDel = vi.mocked(del);

const UPLOAD_URL = "https://store.public.blob.vercel-storage.com/uploads/drawing.dwg";

/** Mirrors the direct-upload intake: JSON naming a DWG already in Blob. */
function blobUrlRequest(payload: Record<string, unknown>): never {
  return new Request("http://localhost/api/convert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) as never;
}

/** Make `get` serve the supplied bytes for the next read. */
function serveBlob(bytes: Buffer | Uint8Array): void {
  mockedGet.mockResolvedValueOnce({ statusCode: 200, stream: bytes } as never);
}


function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwg2png-convert-"));
  mkdirSync(join(dir, "uploads"), { recursive: true });
  mkdirSync(join(dir, "outputs"), { recursive: true });
  process.env.TEMP_DIR = dir;
  delete process.env.CLEANUP_AGE_MINUTES;
  return dir;
}

function multipartRequest(fileName: string, bytes: Uint8Array): never {
  const form = new FormData();
  const blob = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.append("file", new File([blob], fileName, { type: "application/octet-stream" }));
  return new Request("http://localhost/api/convert", { method: "POST", body: form }) as never;
}

interface SheetBody {
  success: boolean;
  conversionId: string;
  originalFileName: string;
  fileName: string;
  size: number;
  version: string | null;
  statistics: { totalEntities: number; renderedEntities: number; skippedEntities: number; warnings: string[] };
  warnings: string[];
}

interface ConvertResultBody {
  success: boolean;
  originalFileName: string;
  sheetCount: number;
  skippedBlankSheets?: string[];
  sheets: SheetBody[];
}

describe("POST /api/convert — direct multipart upload", () => {
  let sandbox: string;

  afterEach(() => {
    if (sandbox) {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("converts the DWG into one PNG per sheet", async () => {
    sandbox = makeSandbox();
    const res = await POST(multipartRequest("drawing.dwg", minimalDwgBytes()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConvertResultBody;

    expect(body.success).toBe(true);
    expect(body.originalFileName).toBe("drawing.dwg");
    expect(body.sheetCount).toBe(1);
    expect(body.sheets).toHaveLength(1);
    expect(body.skippedBlankSheets).toEqual([]);

    const sheet = body.sheets[0]!;
    expect(/^[0-9a-f-]{36}$/.test(sheet.conversionId)).toBe(true);
    expect(sheet.fileName).toBe("drawing-Model.png");
    expect(sheet.size).toBeGreaterThan(0);
    expect(Array.isArray(sheet.warnings)).toBe(true);
    expect(sheet.statistics.totalEntities).toBeGreaterThan(0);
    expect(existsSync(join(sandbox, "outputs", `${sheet.conversionId}.png`))).toBe(true);
    // The staged upload is consumed after conversion.
    const uploads = join(sandbox, "uploads");
    expect(readdirSync(uploads).some((name) => name.endsWith(".dwg"))).toBe(false);
  });

  it("rejects a non-DWG extension", async () => {
    sandbox = makeSandbox();
    const res = await POST(multipartRequest("notes.txt", new TextEncoder().encode("hello")));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/convert — direct blob upload", () => {
  let sandbox: string;
  let savedMaxMb: string | undefined;
  let savedBudgetMs: string | undefined;
  let savedBlankInk: string | undefined;

  beforeEach(() => {
    mockedGet.mockReset();
    mockedGet.mockResolvedValue(null);
    mockedDel.mockClear();
    // The multipart block leaves Blob disabled; these cases read from it.
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    savedMaxMb = process.env.MAX_FILE_SIZE_MB;
    savedBudgetMs = process.env.CONVERSION_BUDGET_MS;
    savedBlankInk = process.env.BLANK_SHEET_INK_FRACTION;
  });

  afterEach(() => {
    if (sandbox) {
      rmSync(sandbox, { recursive: true, force: true });
    }
    delete process.env.BLOB_READ_WRITE_TOKEN;
    if (savedMaxMb === undefined) {
      delete process.env.MAX_FILE_SIZE_MB;
    } else {
      process.env.MAX_FILE_SIZE_MB = savedMaxMb;
    }
    if (savedBudgetMs === undefined) {
      delete process.env.CONVERSION_BUDGET_MS;
    } else {
      process.env.CONVERSION_BUDGET_MS = savedBudgetMs;
    }
    if (savedBlankInk === undefined) {
      delete process.env.BLANK_SHEET_INK_FRACTION;
    } else {
      process.env.BLANK_SHEET_INK_FRACTION = savedBlankInk;
    }
  });

  it("converts a DWG referenced by upload URL and then deletes the upload", async () => {
    sandbox = makeSandbox();
    serveBlob(minimalDwgBytes());

    const res = await POST(blobUrlRequest({ uploadUrl: UPLOAD_URL, fileName: "drawing.dwg" }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as ConvertResultBody;
    expect(body.success).toBe(true);
    expect(body.sheetCount).toBe(1);
    expect(body.sheets[0]!.size).toBeGreaterThan(0);

    // The upload is consumed, so a repeat conversion cannot reuse it.
    expect(mockedDel).toHaveBeenCalledWith(UPLOAD_URL);
  });

  it("rejects a blob that is not one of our uploads", async () => {
    sandbox = makeSandbox();
    serveBlob(minimalDwgBytes());

    const res = await POST(
      blobUrlRequest({
        uploadUrl: "https://store.public.blob.vercel-storage.com/outputs/abc.png",
        fileName: "drawing.dwg",
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing upload URL", async () => {
    sandbox = makeSandbox();
    const res = await POST(blobUrlRequest({ fileName: "drawing.dwg" }));
    expect(res.status).toBe(400);
  });

  it("reports a friendly error instead of timing out when a drawing is too complex", async () => {
    sandbox = makeSandbox();
    serveBlob(minimalDwgBytes());
    // 1ms is already spent by the time the first stage check runs, so the
    // conversion aborts with a real message rather than a platform 504.
    process.env.CONVERSION_BUDGET_MS = "1";

    const res = await POST(blobUrlRequest({ uploadUrl: UPLOAD_URL, fileName: "drawing.dwg" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/too complex to convert in time/i);
    // The upload is still consumed, so a retry cannot reuse it.
    expect(mockedDel).toHaveBeenCalledWith(UPLOAD_URL);
  });

  it("rejects a DWG whose every sheet renders blank", async () => {
    sandbox = makeSandbox();
    serveBlob(minimalDwgBytes());
    // A threshold no real drawing can clear stands in for a DWG made entirely
    // of empty pages, so the "all sheets dropped" branch is exercised without a
    // blank-file fixture.
    savedBlankInk = process.env.BLANK_SHEET_INK_FRACTION;
    process.env.BLANK_SHEET_INK_FRACTION = "0.99";

    const res = await POST(blobUrlRequest({ uploadUrl: UPLOAD_URL, fileName: "drawing.dwg" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/no drawable content/i);
    // The upload is still consumed, so a retry cannot reuse it.
    expect(mockedDel).toHaveBeenCalledWith(UPLOAD_URL);
  });

  it("rejects a non-DWG filename even when the upload exists", async () => {
    sandbox = makeSandbox();
    serveBlob(minimalDwgBytes());

    const res = await POST(blobUrlRequest({ uploadUrl: UPLOAD_URL, fileName: "notes.txt" }));
    expect(res.status).toBe(400);
  });

  it("enforces the size limit against the bytes actually stored", async () => {
    sandbox = makeSandbox();
    // The client only ever claims a size; the cap has to be re-checked after
    // the read, otherwise a lying client gets a free unlimited conversion.
    process.env.MAX_FILE_SIZE_MB = "1";
    serveBlob(Buffer.alloc(1024 * 1024 + 1, 7));

    const res = await POST(blobUrlRequest({ uploadUrl: UPLOAD_URL, fileName: "drawing.dwg" }));
    expect(res.status).toBe(400);
    // Rejected after the read, so the upload must still be cleaned up.
    expect(mockedDel).toHaveBeenCalledWith(UPLOAD_URL);
  });

  it("returns 400 when the upload cannot be read back", async () => {
    sandbox = makeSandbox();
    mockedGet.mockResolvedValueOnce(null as never);

    const res = await POST(blobUrlRequest({ uploadUrl: UPLOAD_URL, fileName: "drawing.dwg" }));
    expect(res.status).toBe(400);
  });
});
