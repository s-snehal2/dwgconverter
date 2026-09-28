import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/server/services/tilesview", () => ({
  sendRoomToTilesview: vi.fn(async () => 54321),
}));
vi.mock("@/server/services/outputStore", () => ({
  readAiOutput: vi.fn(async () => ({ buffer: Buffer.from([1, 2, 3]) })),
}));

import { POST } from "./route";

const ID = "73f939c6-1c05-4ee2-83e4-e4e4d64af738";

function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwg2png-tilesview-"));
  process.env.TEMP_DIR = dir;
  process.env.TILESVIEW_APP_KEY = "k";
  process.env.TILESVIEW_APP_SECRET = "s";
  delete process.env.TILESVIEW_VISUALIZER_BASE_URL;
  delete process.env.RATE_LIMIT_PER_MINUTE;
  return dir;
}

const request = () =>
  new Request("http://localhost/api/tilesview/x", { method: "POST" }) as never;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/tilesview/[id]", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    if (sandbox) {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("returns the visualizer URL built from the configured base", async () => {
    const res = await POST(request(), params(ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      customRoomsId: number;
      visualizerUrl: string;
    };
    expect(body.success).toBe(true);
    expect(body.customRoomsId).toBe(54321);
    expect(body.visualizerUrl).toBe(
      "https://tilesview.ai/app/EZEnoscu4lODABbT_sHm7Q/visualizer/54321/MySpace",
    );
  });

  it("honors an overridden TILESVIEW_VISUALIZER_BASE_URL", async () => {
    process.env.TILESVIEW_VISUALIZER_BASE_URL = "https://example.test/visualizer/";
    const res = await POST(request(), params(ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { visualizerUrl: string };
    expect(body.visualizerUrl).toBe("https://example.test/visualizer/54321/MySpace");
  });

  it("rejects when TilesView credentials are missing", async () => {
    delete process.env.TILESVIEW_APP_KEY;
    const res = await POST(request(), params(ID));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });
});