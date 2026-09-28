import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/server/services/geminiImage", () => ({
  generateDrawingImage: vi.fn(async () => ({ image: Buffer.from([1, 2, 3, 4]), durationMs: 7 })),
}));

import { POST } from "./route";
import { generateDrawingImage } from "@/server/services/geminiImage";

const mockedGenerate = vi.mocked(generateDrawingImage);

const ID = "73f939c6-1c05-4ee2-83e4-e4e4d64af738";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Fresh sandboxed temp dir + env wiring per test (disk mode, no Blob). */
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwg2png-generate-"));
  mkdirSync(join(dir, "uploads"), { recursive: true });
  mkdirSync(join(dir, "outputs"), { recursive: true });
  process.env.TEMP_DIR = dir;
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.BLOB_STORE_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.CLEANUP_AGE_MINUTES;
  delete process.env.RATE_LIMIT_PER_MINUTE;
  delete process.env.AI_GENERATION_LIMIT;
  delete process.env.MAX_AI_PROMPT_CHARS;
  return dir;
}

const request = (body?: unknown) =>
  new Request("http://localhost/api/generate/x", {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/generate/[id]", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = makeSandbox();
    writeFileSync(join(sandbox, "outputs", `${ID}.png`), PNG_BYTES);
    mockedGenerate.mockClear();
  });

  afterEach(() => {
    if (sandbox) {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("allows 5 generations then rejects the 6th with 429", async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await POST(request(), params(ID));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        generationsUsed: number;
        generationsLimit: number;
      };
      expect(body.success).toBe(true);
      expect(body.generationsUsed).toBe(i);
      expect(body.generationsLimit).toBe(5);
    }

    const sixth = await POST(request(), params(ID));
    expect(sixth.status).toBe(429);
    const body = (await sixth.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/maximum/i);
    expect(mockedGenerate).toHaveBeenCalledTimes(5);
  });

  it("does not count a failed generation against the limit", async () => {
    mockedGenerate.mockRejectedValueOnce(new Error("Gemini API error 500"));

    const failed = await POST(request(), params(ID));
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { success: boolean }).success).toBe(false);

    const ok = await POST(request(), params(ID));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { generationsUsed: number }).generationsUsed).toBe(1);
  });

  it("forwards a user prompt to the Gemini service", async () => {
    const res = await POST(request({ prompt: "make it a luxury bathroom" }), params(ID));
    expect(res.status).toBe(200);
    expect(mockedGenerate).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ geminiApiKey: "test-key" }),
      "make it a luxury bathroom",
    );
  });

  it("treats a missing or blank prompt as undefined", async () => {
    await POST(request({ prompt: "" }), params(ID));
    await POST(request({ prompt: "   " }), params(ID));
    const calls = mockedGenerate.mock.calls;
    expect(calls[0]![2]).toBeUndefined();
    expect(calls[1]![2]).toBeUndefined();
  });

  it("rejects an over-long prompt with 400", async () => {
    const longPrompt = "x".repeat(2001);
    const res = await POST(request({ prompt: longPrompt }), params(ID));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });
});
