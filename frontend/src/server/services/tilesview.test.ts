import { describe, it, expect, vi, afterEach } from "vitest";
import { sendRoomToTilesview } from "./tilesview";
import { AppError } from "../utils/errors";
import type { AppConfig } from "../config";

function baseConfig(): AppConfig {
  return {
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
    cleanupAgeMs: 24 * 60 * 60 * 1000,
    tempRootDir: "/tmp",
    uploadsDir: "/tmp/uploads",
    outputsDir: "/tmp/outputs",
    rateLimitMax: 30,
    geminiApiKey: "",
    geminiPrompt: "",
    geminiModel: "gemini-3.1-flash-image",
    aiGenerationLimit: 5,
    geminiTimeoutMs: 240_000,
    tilesviewApiUrl: "https://tilesview.ai/Provider/app/api-room-planner-data",
    tilesviewAppKey: "k",
    tilesviewAppSecret: "s",
    tilesviewAppKeyHeader: "app_key",
    tilesviewAppSecretHeader: "app_secret",
    tilesviewVisualizerBaseUrl: "https://tilesview.ai/app/EZEnoscu4lODABbT_sHm7Q/visualizer",
  };
}

const png = Buffer.from("fakepng");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendRoomToTilesview", () => {
  it("sends app_key and app_secret headers and multipart form", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init;
        return new Response(JSON.stringify({ status: true, data: { custom_rooms_id: 12345 } }), {
          status: 200,
        });
      }),
    );

    const id = await sendRoomToTilesview(png, baseConfig());
    const headers = captured?.headers as Record<string, string>;

    expect(id).toBe(12345);
    expect(headers.app_key).toBe("k");
    expect(headers.app_secret).toBe("s");
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBeInstanceOf(FormData);
  });

  it("throws with message on status:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ status: false, code: 500, message: "Bad image", data: null }),
          { status: 500 },
        ),
      ),
    );

    await expect(sendRoomToTilesview(png, baseConfig())).rejects.toMatchObject({
      code: "TILESVIEW_ERROR",
      message: expect.stringContaining("Bad image"),
    });
  });

  it("throws a readable error when the body is HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html><html>…", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    await expect(sendRoomToTilesview(png, baseConfig())).rejects.toMatchObject({
      code: "TILESVIEW_ERROR",
      message: expect.stringContaining("HTTP 200"),
    });
  });

  it("throws when credentials are missing", async () => {
    const config = { ...baseConfig(), tilesviewAppKey: "", tilesviewAppSecret: "" };
    await expect(sendRoomToTilesview(png, config)).rejects.toBeInstanceOf(AppError);
  });
});
