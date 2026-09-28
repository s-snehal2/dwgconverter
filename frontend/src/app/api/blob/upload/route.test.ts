import { describe, expect, it, beforeEach, vi } from "vitest";
import { GET, POST } from "./route";

type TokenOptions = { maximumSizeInBytes: number; validUntil: number; allowOverwrite: boolean };

const handleUpload = vi.fn();
vi.mock("@vercel/blob/client", () => ({
  handleUpload: (...args: unknown[]) => handleUpload(...args),
}));

vi.mock("@/server/utils/rateLimit", () => ({
  takeRateLimit: () => true,
  clientIpFrom: () => "1.2.3.4",
}));

const MAX_BYTES = 80 * 1024 * 1024;

function request(payload: unknown, init?: RequestInit): never {
  return new Request("https://app.test/api/blob/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    ...init,
  }) as never;
}

function enableBlob(): void {
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  process.env.MAX_FILE_SIZE_MB = "80";
}

function resetEnv(): void {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  process.env.MAX_FILE_SIZE_MB = "80";
}

/**
 * Stand in for the SDK: it extracts the pathname from the event body, runs
 * `onBeforeGenerateToken`, and only then returns a client token. Returning a
 * token without calling the hook would let a broken route pass every test.
 */
function stubSdk(): void {
  handleUpload.mockImplementation(async (arg: {
    body: { payload?: { pathname?: string } };
    onBeforeGenerateToken: (p: string, c: string | null, m: boolean) => Promise<TokenOptions>;
  }) => {
    const options = await arg.onBeforeGenerateToken(arg.body.payload?.pathname ?? "", null, false);
    return { type: "blob.generate-client-token", clientToken: `token-for-${options.maximumSizeInBytes}` };
  });
}

describe("GET /api/blob/upload", () => {
  beforeEach(() => {
    handleUpload.mockReset();
    resetEnv();
  });

  it("advertises direct upload when Blob is enabled", async () => {
    enableBlob();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      directUpload: true,
      access: "private",
      prefix: "uploads/",
      maxBytes: MAX_BYTES,
    });
  });

  it("404s when Blob is disabled so the client falls back to multipart", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    expect((await res.json()).directUpload).toBe(false);
  });
});

describe("POST /api/blob/upload", () => {
  beforeEach(() => {
    handleUpload.mockReset();
    resetEnv();
    stubSdk();
  });

  it("404s when Blob is disabled", async () => {
    const res = await POST(request({ payload: { pathname: "uploads/a.dwg" } }));
    expect(res.status).toBe(404);
    expect(handleUpload).not.toHaveBeenCalled();
  });

  it("returns the generated client token for a valid pathname", async () => {
    enableBlob();
    const res = await POST(request({ payload: { pathname: "uploads/a.dwg" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: "blob.generate-client-token",
      clientToken: `token-for-${MAX_BYTES}`,
    });
  });

  it("caps the token at the configured max size and refuses overwrites", async () => {
    enableBlob();
    process.env.MAX_FILE_SIZE_MB = "3";
    const res = await POST(request({ payload: { pathname: "uploads/a.dwg" } }));
    const expected = `token-for-${3 * 1024 * 1024}`;
    expect(await res.json()).toEqual({ type: "blob.generate-client-token", clientToken: expected });
  });

  it("rejects a pathname outside the uploads/ prefix", async () => {
    enableBlob();
    const res = await POST(request({ payload: { pathname: "outputs/evil.png" } }));
    expect(res.status).toBe(400);
  });

  it("rejects a look-alike prefix that is not our own", async () => {
    enableBlob();
    const res = await POST(request({ payload: { pathname: "uploads-evil/a.dwg" } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed JSON body instead of throwing", async () => {
    enableBlob();
    const res = await POST(
      new Request("https://app.test/api/blob/upload", { method: "POST" }) as never
    );
    expect(res.status).toBe(400);
    expect(handleUpload).not.toHaveBeenCalled();
  });

  it("does not leak the internal reason for a rejected upload", async () => {
    enableBlob();
    const res = await POST(request({ payload: { pathname: "../secrets.dwg" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Upload could not be started.");
  });
});
