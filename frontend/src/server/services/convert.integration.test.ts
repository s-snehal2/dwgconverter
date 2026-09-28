import { describe, expect, it } from "vitest";
import { Line, Viewport, XYZ, XY } from "@node-projects/acad-ts";
import type { CadDocument } from "@node-projects/acad-ts";
import { convertDwg } from "./convertDwg";
import { minimalDwgBytes } from "./testFixture";
import type { AppConfig } from "../config";
import sharp from "sharp";

const TEST_CONFIG: AppConfig = {
  maxFileSizeBytes: 80 * 1024 * 1024,
  conversionBudgetMs: 260_000,
  maxPngDimension: 1000,
  marginPx: 50,
  pngSupersample: 2,
  minStrokePx: 1.2,
  maxLayouts: 100,
  blankSheetInkFraction: 0.005,
  modelClusterGapFraction: 0.03,
  modelClusterMaxDepth: 12,
  maxAiPromptChars: 1000,
  cleanupAgeMs: 30 * 60 * 1000,
  tempRootDir: "",
  uploadsDir: "",
  outputsDir: "",
  rateLimitMax: 30,
  geminiApiKey: "",
  geminiPrompt: "",
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

/** Build a real DWG byte array from a dense model-space grid via acad-ts. */
describe("convertDwg integration", () => {
  it("converts a real DWG into a valid PNG with expected statistics", async () => {
    const bytes = minimalDwgBytes(200);
    expect(bytes.length).toBeGreaterThan(64);
    const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    expect(signature).toBe("AC10");

    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const { sheets, skippedBlankSheets } = await convertDwg(arrayBuffer, TEST_CONFIG);
    expect(sheets).toHaveLength(1);
    expect(skippedBlankSheets).toHaveLength(0);
    const result = sheets[0];

    // The grid fixture contributes 200 horizontal + 200 vertical model lines.
    expect(result.statistics.totalEntities).toBeGreaterThanOrEqual(400);
    expect(result.statistics.renderedEntities).toBe(400);
    expect(result.statistics.skippedEntities).toBe(0);

    // Valid PNG (8-byte magic signature).
    const png = new Uint8Array(result.png);
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(Array.from(png.slice(0, 8))).toEqual(magic);

    const metadata = await sharp(result.png).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
  });

  it("rejects content that is not a DWG", async () => {
    const garbage = new TextEncoder().encode("not a dwg file at all").buffer;
    await expect(convertDwg(garbage, TEST_CONFIG)).rejects.toMatchObject({ code: "CORRUPTED_DWG" });
  });

  it("renders a paper-space page with a viewport at page proportions", async () => {
    // Dense grid filling the viewport window (viewHeight 100 at the 380x280
    // page aspect => viewWidth 135.714, so x spans 50±67.857, y spans 0..100).
    // Dense enough that the sheet is not flagged as sparse.
    const grid: Line[] = [];
    for (let y = 0; y <= 100; y += 2) {
      const line = new Line();
      line.startPoint = new XYZ(-17.857, y, 0);
      line.endPoint = new XYZ(117.857, y, 0);
      grid.push(line);
    }
    for (let x = -17.857; x <= 117.857; x += 2) {
      const line = new Line();
      line.startPoint = new XYZ(x, 0, 0);
      line.endPoint = new XYZ(x, 100, 0);
      grid.push(line);
    }

    const border = new Line();
    border.startPoint = new XYZ(10, 10, 0);
    border.endPoint = new XYZ(390, 290, 0);

    const viewport = new Viewport();
    viewport.id = 2;
    viewport.center = new XYZ(200, 150, 0);
    viewport.width = 380;
    viewport.height = 280;
    viewport.viewCenter = new XY(50, 50);
    viewport.viewHeight = 100;

    const document = {
      layers: [],
      blockRecords: [],
      modelSpace: { entities: grid },
      paperSpace: { entities: [border, viewport] },
    } as unknown as CadDocument;

    const buffer = new TextEncoder().encode("AC1027 page").buffer as ArrayBuffer;

    const { sheets, skippedBlankSheets } = await convertDwg(
      buffer,
      TEST_CONFIG,
      {},
      { read: () => ({ version: "AC1027", document }) }
    );
    // The layout sheet comes first, then the model sheet. Every assertion below
    // targets the layout, which is what this test is about.
    expect(sheets).toHaveLength(2);
    expect(sheets.map((s) => s.viewName)).toEqual(["Layout 1", "Model"]);
    expect(skippedBlankSheets).toHaveLength(0);
    const result = sheets[0];

    expect(result.statistics.page).toEqual({ entityCount: 1, viewportCount: 1 });

    const metadata = await sharp(result.png).metadata();
    // Page bounds (10,10)-(390,290) = 380x280, scaled into maxWidth 1000 with
    // margin 50: scale = min(900/380, 900/280) so width hits 1000 exactly and
    // the height follows the page's 380x280 sheet ratio.
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1000);
    expect(metadata.height).toBe(764);
  });

  it("omits a paper-space sheet whose viewport window frames empty model space", async () => {
    // Model space is drawn as a dense grid, not a single line: a lone diagonal
    // is under the blank threshold and would itself be dropped. The 2-unit
    // spacing is tighter than MODEL_CLUSTER_GAP_FRACTION, so the grid stays a
    // single "Model" crop rather than being split into eight. It sits in
    // 0..100, so the viewport below (centred on 500,500) frames empty space and
    // the layout is the blank sheet under test.
    const modelGrid: Line[] = [];
    for (let i = 0; i <= 100; i += 2) {
      for (const [x1, y1, x2, y2] of [
        [0, i, 100, i],
        [i, 0, i, 100],
      ] as [number, number, number, number][]) {
        const line = new Line();
        line.startPoint = new XYZ(x1, y1, 0);
        line.endPoint = new XYZ(x2, y2, 0);
        modelGrid.push(line);
      }
    }

    const border = new Line();
    border.startPoint = new XYZ(10, 10, 0);
    border.endPoint = new XYZ(390, 290, 0);

    const viewport = new Viewport();
    viewport.id = 2;
    viewport.center = new XYZ(200, 150, 0);
    viewport.width = 380;
    viewport.height = 280;
    viewport.viewCenter = new XY(500, 500);
    viewport.viewHeight = 100;

    const document = {
      layers: [],
      blockRecords: [],
      modelSpace: { entities: modelGrid },
      paperSpace: { entities: [border, viewport] },
    } as unknown as CadDocument;

    const buffer = new TextEncoder().encode("AC1027 blank page").buffer as ArrayBuffer;

    const { sheets, skippedBlankSheets } = await convertDwg(
      buffer,
      TEST_CONFIG,
      {},
      { read: () => ({ version: "AC1027", document }) }
    );
    // The layout frames empty model space, so the page is blank. It is dropped
    // entirely: no PNG, no persisted output. The model sheet survives because
    // model space has its own content.
    expect(sheets).toHaveLength(1);
    expect(sheets[0].viewName).toBe("Model");
    expect(skippedBlankSheets).toContain("Layout 1");
    expect(sheets[0].png.byteLength).toBeGreaterThan(0);
  });

  it("omits blank layouts and keeps the drawn ones", async () => {
    // Two paper-space layouts: one frames a populated region of model space,
    // the other frames empty space and is therefore blank. The blank one yields
    // no PNG at all.
    const grid: Line[] = [];
    for (let y = 0; y <= 100; y += 2) {
      const line = new Line();
      line.startPoint = new XYZ(-17.857, y, 0);
      line.endPoint = new XYZ(117.857, y, 0);
      grid.push(line);
    }
    for (let x = -17.857; x <= 117.857; x += 2) {
      const line = new Line();
      line.startPoint = new XYZ(x, 0, 0);
      line.endPoint = new XYZ(x, 100, 0);
      grid.push(line);
    }

    const makeLayout = (name: string, viewCenter: number) => {
      const border = new Line();
      border.startPoint = new XYZ(10, 10, 0);
      border.endPoint = new XYZ(390, 290, 0);

      const viewport = new Viewport();
      viewport.id = 2;
      viewport.center = new XYZ(200, 150, 0);
      viewport.width = 380;
      viewport.height = 280;
      viewport.viewCenter = new XY(viewCenter, viewCenter);
      viewport.viewHeight = 100;

      return {
        isPaperSpace: true,
        tabOrder: name === "Dense" ? 0 : 1,
        name,
        associatedBlock: { entities: [border, viewport] },
      };
    };

    const document = {
      layers: [],
      blockRecords: [],
      modelSpace: { entities: grid },
      layouts: [makeLayout("Dense", 50), makeLayout("Sparse", 500)],
    } as unknown as CadDocument;

    const buffer = new TextEncoder().encode("AC1027 two layouts").buffer as ArrayBuffer;

    const { sheets, skippedBlankSheets } = await convertDwg(
      buffer,
      TEST_CONFIG,
      {},
      { read: () => ({ version: "AC1027", document }) }
    );

    // Draw order is preserved and the blank layout is gone, so only the drawn
    // layout and the model sheet survive.
    expect(sheets).toHaveLength(2);
    expect(sheets.map((s) => s.viewName)).toEqual(["Dense", "Model"]);
    for (const sheet of sheets) {
      expect(sheet.png.byteLength).toBeGreaterThan(0);
    }
    // Only the layout framing empty model space is dropped.
    expect(skippedBlankSheets).toEqual(["Sparse"]);
  });

  it("rejects a DWG whose every sheet is blank", async () => {
    // Model space is empty and the single layout draws only a title-block
    // frame, so nothing reaches the ink threshold.
    const border = new Line();
    border.startPoint = new XYZ(10, 10, 0);
    border.endPoint = new XYZ(390, 290, 0);

    const viewport = new Viewport();
    viewport.id = 2;
    viewport.center = new XYZ(200, 150, 0);
    viewport.width = 380;
    viewport.height = 280;
    viewport.viewCenter = new XY(500, 500);
    viewport.viewHeight = 100;

    const document = {
      layers: [],
      blockRecords: [],
      modelSpace: { entities: [] },
      paperSpace: { entities: [border, viewport] },
    } as unknown as CadDocument;

    const buffer = new TextEncoder().encode("AC1027 all blank").buffer as ArrayBuffer;

    await expect(
      convertDwg(buffer, TEST_CONFIG, {}, { read: () => ({ version: "AC1027", document }) })
    ).rejects.toMatchObject({ code: "NO_DRAWABLE_CONTENT" });
  });
});
