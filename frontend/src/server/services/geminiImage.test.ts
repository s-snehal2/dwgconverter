import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { composeAiPrompt, generateDrawingImage } from "./geminiImage";
import type { AppConfig } from "../config";

const baseConfig: AppConfig = {
  maxFileSizeBytes: 80 * 1024 * 1024,
  conversionBudgetMs: 260_000,
  maxPngDimension: 3000,
  marginPx: 50,
  pngSupersample: 2,
  minStrokePx: 1,
  modelClusterGapFraction: 0.03,
  modelClusterMaxDepth: 12,
  maxLayouts: 100,
  blankSheetInkFraction: 0.005,
  maxAiPromptChars: 1000,
  cleanupAgeMs: 30 * 60 * 1000,
  tempRootDir: "",
  uploadsDir: "",
  outputsDir: "",
  rateLimitMax: 30,
  geminiApiKey: "test-api-key",
  geminiPrompt: "Turn this drawing into a photorealistic visualization.",
  geminiModel: "gemini-3.1-flash-image",
  aiGenerationLimit: 5,
  geminiTimeoutMs: 240_000,
  tilesviewApiUrl: "https://tilesview.ai/Provider/app/api-room-planner-data",
  tilesviewAppKey: "",
  tilesviewAppSecret: "",
  tilesviewAppKeyHeader: "app_key",
  tilesviewAppSecretHeader: "app_secret",
  tilesviewVisualizerBaseUrl: "https://tilesview.ai/app/EZEnoscu4lODABbT_sHm7Q/visualizer",
};

function makeFakePng(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function fakeGeminiResponse(imageBase64: string) {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: imageBase64,
              },
            },
          ],
        },
      },
    ],
  };
}

describe("composeAiPrompt", () => {
  it("returns the base prompt unchanged when there is no user prompt", () => {
    const prompt = composeAiPrompt(undefined, { geminiPrompt: "Base", maxAiPromptChars: 10 });
    expect(prompt).toBe("Base");
    expect(composeAiPrompt("   ", { geminiPrompt: "Base", maxAiPromptChars: 10 })).toBe("Base");
  });

  it("appends the trimmed user prompt to the base prompt", () => {
    const prompt = composeAiPrompt("  luxury kitchen, evening lighting  ", {
      geminiPrompt: "Base prompt",
      maxAiPromptChars: 100,
    });
    expect(prompt).toContain("Base prompt");
    expect(prompt).toContain("The user wants this specific visualization:\nluxury kitchen, evening lighting");
    expect(prompt).not.toContain("  luxury");
  });

  it("truncates an over-long user prompt to maxAiPromptChars", () => {
    const user = "x".repeat(500);
    const prompt = composeAiPrompt(user, { geminiPrompt: "Base", maxAiPromptChars: 100 });
    expect(prompt.length).toBeLessThanOrEqual("Base\n\nThe user wants this specific visualization:\n".length + 100);
    expect(prompt.endsWith("x".repeat(100))).toBe(true);
  });
});

describe("generateDrawingImage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws AI_NOT_CONFIGURED when no API key is set", async () => {
    const config = { ...baseConfig, geminiApiKey: "" };
    const png = makeFakePng();
    await expect(generateDrawingImage(png, config)).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });
  });

  it("sends the correct request to Gemini and returns the generated image", async () => {
    const outputBase64 = Buffer.from("fake-ai-image").toString("base64");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => fakeGeminiResponse(outputBase64),
    } as Response);

    const png = makeFakePng();
    const { image, durationMs } = await generateDrawingImage(png, baseConfig);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${baseConfig.geminiModel}:generateContent`,
    );
    expect(opts!.method).toBe("POST");
    expect((opts!.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-api-key");
    expect((opts!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts!.body as string);
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE"]);
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("image/png");
    expect(body.contents[0].parts[1].text).toBe(baseConfig.geminiPrompt);

    expect(image).toEqual(Buffer.from("fake-ai-image"));
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it("appends a user prompt to the base prompt in the request body", async () => {
    const outputBase64 = Buffer.from("fake-ai-image").toString("base64");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => fakeGeminiResponse(outputBase64),
    } as Response);

    await generateDrawingImage(makeFakePng(), baseConfig, "make it a spa bathroom");

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.contents[0].parts[1].text).toContain(baseConfig.geminiPrompt);
    expect(body.contents[0].parts[1].text).toContain("make it a spa bathroom");
  });

  it("throws AI_GENERATION_ERROR on 429 rate limit", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    } as Response);

    await expect(generateDrawingImage(makeFakePng(), baseConfig)).rejects.toMatchObject({
      code: "AI_GENERATION_ERROR",
      message: expect.stringContaining("rate limit"),
    });
  });

  it("throws AI_NOT_CONFIGURED on 403 forbidden", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    } as Response);

    await expect(generateDrawingImage(makeFakePng(), baseConfig)).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });
  });

  it("throws AI_GENERATION_ERROR when response has no candidates", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [] }),
    } as Response);

    await expect(generateDrawingImage(makeFakePng(), baseConfig)).rejects.toMatchObject({
      code: "AI_GENERATION_ERROR",
      message: expect.stringContaining("no candidates"),
    });
  });

  it("throws AI_GENERATION_ERROR when response has no image part", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Sorry, I can't generate an image." }] } }],
      }),
    } as Response);

    await expect(generateDrawingImage(makeFakePng(), baseConfig)).rejects.toMatchObject({
      code: "AI_GENERATION_ERROR",
      message: expect.stringContaining("no image"),
    });
  });
});
