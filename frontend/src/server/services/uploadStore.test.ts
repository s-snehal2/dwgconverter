import { describe, expect, it, beforeEach, vi } from "vitest";
import { get, del } from "@vercel/blob";
import { isTrustedUploadUrl, readUploadBlob, deleteUploadBlob } from "./uploadStore";

vi.mock("@vercel/blob", () => ({
  put: vi.fn(),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ blobs: [], hasMore: false })),
  del: vi.fn(async () => undefined),
}));

const mockedGet = vi.mocked(get);
const mockedDel = vi.mocked(del);

const UPLOADS = "https://store.private.blob.vercel-storage.com/uploads/";
const OK = UPLOADS + "drawing.dwg";

function serveBlob(bytes: Uint8Array): void {
  // `readUploadBlob` feeds `result.stream` straight into `new Response(...)`,
  // so the mock has to hand back the bytes, not a nested Response object.
  mockedGet.mockResolvedValueOnce({
    statusCode: 200,
    stream: Buffer.from(bytes),
  } as never);
}

describe("isTrustedUploadUrl", () => {
  it("accepts an https URL under our own uploads/ prefix", () => {
    expect(isTrustedUploadUrl(OK)).toBe(true);
  });

  it("rejects a non-https scheme", () => {
    expect(isTrustedUploadUrl("http://store.private.blob.vercel-storage.com/uploads/a.dwg")).toBe(false);
  });

  it("rejects a non-URL string", () => {
    expect(isTrustedUploadUrl("not a url")).toBe(false);
  });

  it("rejects our own outputs/ prefix", () => {
    expect(isTrustedUploadUrl("https://store.private.blob.vercel-storage.com/outputs/a.png")).toBe(false);
  });

  it("rejects a look-alike prefix that merely starts with the same letters", () => {
    expect(isTrustedUploadUrl("https://store.private.blob.vercel-storage.com/uploads-evil/a.dwg")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isTrustedUploadUrl("")).toBe(false);
  });
});

describe("readUploadBlob", () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedDel.mockClear();
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  it("returns the stored bytes", async () => {
    serveBlob(new Uint8Array([1, 2, 3, 4]));
    const out = await readUploadBlob(OK);
    expect([...out]).toEqual([1, 2, 3, 4]);
  });

  it("throws when the blob is missing", async () => {
    mockedGet.mockResolvedValueOnce(null as never);
    await expect(readUploadBlob(OK)).rejects.toThrow(/not found/i);
  });

  it("throws when the blob reports a non-200 status", async () => {
    mockedGet.mockResolvedValueOnce({ statusCode: 404, stream: Buffer.alloc(0) } as never);
    await expect(readUploadBlob(OK)).rejects.toThrow(/not found/i);
  });

  it("refuses to read when Blob storage is disabled", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
    await expect(readUploadBlob(OK)).rejects.toThrow(/not enabled/i);
  });
});

describe("deleteUploadBlob", () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedDel.mockClear();
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  it("deletes the blob", async () => {
    await deleteUploadBlob(OK);
    expect(mockedDel).toHaveBeenCalledWith(OK);
  });

  it("swallows a delete failure so it cannot fail a conversion", async () => {
    mockedDel.mockRejectedValueOnce(new Error("nope"));
    await expect(deleteUploadBlob(OK)).resolves.toBeUndefined();
  });

  it("is a no-op when Blob storage is disabled", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
    await deleteUploadBlob(OK);
    expect(mockedDel).not.toHaveBeenCalled();
  });
});
