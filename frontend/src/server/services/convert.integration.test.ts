import { describe, expect, it } from "vitest";
import { Line, Point, TextEntity, Viewport, XYZ, XY } from "@node-projects/acad-ts";
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
    const { sheets, omittedBlankSheets } = await convertDwg(arrayBuffer, TEST_CONFIG);
    expect(sheets).toHaveLength(1);
    expect(omittedBlankSheets).toHaveLength(0);
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

    const { sheets, omittedBlankSheets } = await convertDwg(
      buffer,
      TEST_CONFIG,
      {},
      { read: () => ({ version: "AC1027", document }) }
    );
    // The layout sheet comes first, then the model sheet. Every assertion below
    // targets the layout, which is what this test is about.
    expect(sheets).toHaveLength(2);
    expect(sheets.map((s) => s.viewName)).toEqual(["Layout 1", "Model"]);
    expect(omittedBlankSheets).toHaveLength(0);
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

    const { sheets, omittedBlankSheets } = await convertDwg(
      buffer,
      TEST_CONFIG,
      {},
      { read: () => ({ version: "AC1027", document }) }
    );
    // The layout frames empty model space, so the page is blank. It is dropped
    // before rendering: no PNG, no persisted output. The model sheet survives
    // because model space has its own content.
    expect(sheets).toHaveLength(1);
    expect(sheets[0].viewName).toBe("Model");
    expect(omittedBlankSheets).toEqual([{ name: "Layout 1", reason: "no-drawing" }]);
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

    const { sheets, omittedBlankSheets } = await convertDwg(
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
    expect(omittedBlankSheets).toEqual([{ name: "Sparse", reason: "no-drawing" }]);
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

  it("omits a layout whose viewport is empty even when its page ink is dense", async () => {
    // The regression this whole rule exists for. The page carries a dense
    // title-block/hatch grid — far more ink than the 0.5% threshold — while the
    // viewport frames empty model space. An ink-only test keeps this sheet and
    // hands the user a "blank" page full of title-block furniture; the semantic
    // test is what drops it.
    const pageGrid: Line[] = [];
    for (let y = 10; y <= 290; y += 5) {
      const line = new Line();
      line.startPoint = new XYZ(10, y, 0);
      line.endPoint = new XYZ(390, y, 0);
      pageGrid.push(line);
    }
    for (let x = 10; x <= 390; x += 5) {
      const line = new Line();
      line.startPoint = new XYZ(x, 10, 0);
      line.endPoint = new XYZ(x, 290, 0);
      pageGrid.push(line);
    }

    const makeViewport = (viewCenterX: number, viewCenterY: number) => {
      const vp = new Viewport();
      vp.id = 2;
      vp.center = new XYZ(200, 150, 0);
      vp.width = 380;
      vp.height = 280;
      vp.viewCenter = new XY(viewCenterX, viewCenterY);
      vp.viewHeight = 100;
      return vp;
    };

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

    const withViewportAt = (viewCenterX: number, viewCenterY: number) =>
      ({
        layers: [],
        blockRecords: [],
        modelSpace: { entities: modelGrid },
        paperSpace: { entities: [...pageGrid, makeViewport(viewCenterX, viewCenterY)] },
      }) as unknown as CadDocument;

    const run = (document: CadDocument) =>
      convertDwg(
        new TextEncoder().encode("AC1027 dense page").buffer as ArrayBuffer,
        TEST_CONFIG,
        {},
        { read: () => ({ version: "AC1027", document }) }
      );

    // Same dense page, viewport framing the populated model region: kept.
    const drawn = await run(withViewportAt(50, 50));
    expect(drawn.sheets.map((s) => s.viewName)).toEqual(["Layout 1", "Model"]);
    expect(drawn.omittedBlankSheets).toHaveLength(0);

    // Same dense page, viewport framing empty model space: dropped. Ink is
    // identical in both runs, so the page furniture cannot be the deciding
    // factor — only the emptiness of the window is.
    const empty = await run(withViewportAt(500, 500));
    expect(empty.sheets.map((s) => s.viewName)).toEqual(["Model"]);
    expect(empty.omittedBlankSheets).toEqual([{ name: "Layout 1", reason: "no-drawing" }]);
  });

  it("omits a sheet that shows geometry but renders too little detail", async () => {
    // Exercises the second stage. A sparse cluster of three lines far from the
    // main grid, framed by a viewport at a scale where it covers a sliver of the
    // page: the sheet *does* show a drawing, so the semantic test passes, but
    // the render falls under the ink threshold and is dropped anyway.
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
    // A small, self-contained cluster 5,000 units away.
    for (const [x1, y1, x2, y2] of [
      [5000, 5000, 5010, 5000],
      [5010, 5000, 5010, 5010],
      [5010, 5010, 5000, 5010],
    ] as [number, number, number, number][]) {
      const line = new Line();
      line.startPoint = new XYZ(x1, y1, 0);
      line.endPoint = new XYZ(x2, y2, 0);
      modelGrid.push(line);
    }

    const viewport = new Viewport();
    viewport.id = 2;
    viewport.center = new XYZ(200, 150, 0);
    viewport.width = 380;
    viewport.height = 280;
    // A wide window (viewHeight 200) shrinks the far cluster to a sliver.
    viewport.viewCenter = new XY(5005, 5005);
    viewport.viewHeight = 200;

    const document = {
      layers: [],
      blockRecords: [],
      modelSpace: { entities: modelGrid },
      paperSpace: { entities: [viewport] },
    } as unknown as CadDocument;

    const { sheets, omittedBlankSheets } = await convertDwg(
      new TextEncoder().encode("AC1027 sparse sheet").buffer as ArrayBuffer,
      TEST_CONFIG,
      {},
      { read: () => ({ version: "AC1027", document }) }
    );

    // Both model crops survive (each is zoomed to its own content); the layout
    // that showed only a sliver does not.
    expect(sheets.map((s) => s.viewName)).toEqual(["Model", "Model 2"]);
    expect(omittedBlankSheets).toEqual([{ name: "Layout 1", reason: "too-little-detail" }]);
  });

  it("produces no PNG when a model space holds nothing but a stray point", async () => {
    // A lone point renders as a sub-pixel dot, so a crop of one is a blank page
    // by any reading: no drawing, therefore no PNG, therefore a 422 rather than
    // an empty result set.
    const stray = new Point();
    stray.location = new XYZ(50, 50, 0);

    const document = {
      layers: [],
      blockRecords: [],
      modelSpace: { entities: [stray] },
    } as unknown as CadDocument;

    await expect(
      convertDwg(
        new TextEncoder().encode("AC1027 stray point").buffer as ArrayBuffer,
        TEST_CONFIG,
        {},
        { read: () => ({ version: "AC1027", document }) }
      )
    ).rejects.toMatchObject({ code: "NO_DRAWABLE_CONTENT" });
  });

  it("omits a model crop of only text while keeping the drawn crop", async () => {
    // A note in one corner and a real drawing elsewhere. The note's crop is not
    // a drawing, so it yields no PNG; the drawing's crop is unaffected. Two
    // notes, not one: the clusterer folds an isolated entity into its
    // neighbour, so a single note would never form a crop of its own.
    const makeNote = (x: number, y: number) => {
      const note = new TextEntity("SITE NOTE");
      note.insertPoint = new XYZ(x, y, 0);
      note.height = 2.5;
      note.rotation = 0;
      return note;
    };

    const grid: Line[] = [];
    for (let i = 0; i <= 100; i += 2) {
      for (const [x1, y1, x2, y2] of [
        [0, i, 100, i],
        [i, 0, i, 100],
      ] as [number, number, number, number][]) {
        const line = new Line();
        line.startPoint = new XYZ(x1, y1, 0);
        line.endPoint = new XYZ(x2, y2, 0);
        grid.push(line);
      }
    }

    const document = {
      layers: [],
      blockRecords: [],
      modelSpace: { entities: [makeNote(5000, 5000), makeNote(5000, 5010), ...grid] },
    } as unknown as CadDocument;

    const { sheets, omittedBlankSheets } = await convertDwg(
      new TextEncoder().encode("AC1027 note crop").buffer as ArrayBuffer,
      TEST_CONFIG,
      {},
      { read: () => ({ version: "AC1027", document }) }
    );

    // Only the grid crop survives; the crop of the two notes is dropped, and
    // which crop the clusterer names first is not something to assert on.
    expect(sheets).toHaveLength(1);
    expect(sheets[0].statistics.totalEntities).toBe(102);
    expect(omittedBlankSheets).toHaveLength(1);
    expect(omittedBlankSheets[0].reason).toBe("no-drawing");
    expect(omittedBlankSheets[0].name).not.toBe(sheets[0].viewName);
  });
});
