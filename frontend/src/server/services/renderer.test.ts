import { describe, expect, it } from "vitest";
import { renderToSvg } from "./renderer";
import type { Drawing } from "../models/drawing";
import type { Entity } from "../models/entity";
import type { Page, PageViewport } from "../models/page";

function drawing(entities: Entity[]): Drawing {
  const xs = entities.flatMap((e) => {
    switch (e.type) {
      case "LINE":
        return [e.start.x, e.end.x];
      case "CIRCLE":
      case "ARC":
        return [e.center.x];
      case "ELLIPSE":
        return [e.center.x];
      case "POINT":
        return [e.position.x];
      case "POLYLINE":
        return e.vertices.map((v) => v.x);
      case "SOLID":
        return e.vertices.map((v) => v.x);
      case "IMAGE":
        return e.vertices.map((v) => v.x);
      case "TEXT":
      case "MTEXT":
        return [e.position.x];
    }
  });
  const ys = entities.flatMap((e) => {
    switch (e.type) {
      case "LINE":
        return [e.start.y, e.end.y];
      case "CIRCLE":
      case "ARC":
        return [e.center.y];
      case "ELLIPSE":
        return [e.center.y];
      case "POINT":
        return [e.position.y];
      case "POLYLINE":
        return e.vertices.map((v) => v.y);
      case "SOLID":
        return e.vertices.map((v) => v.y);
      case "IMAGE":
        return e.vertices.map((v) => v.y);
      case "TEXT":
      case "MTEXT":
        return [e.position.y];
    }
  });
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { entities, layers: [], blocks: [], bounds: { minX, minY, maxX, maxY } };
}

const entities: Entity[] = [
  { type: "LINE", start: { x: 0, y: 0 }, end: { x: 100, y: 100 }, color: "#ff0000", layer: "0", lineWeight: 25, sourceType: "LINE" },
  {
    type: "CIRCLE",
    center: { x: 50, y: 50 },
    radius: 10,
    color: "#ff0000",
    layer: "0",
    lineWeight: 25,
    sourceType: "CIRCLE",
  },
];

describe("renderToSvg", () => {
  it("renders line and circle elements", () => {
    const svg = renderToSvg(drawing(entities), { colorMode: "monochrome", maxWidth: 1000, maxHeight: 1000, margin: 50 });
    expect(svg).toContain("<line");
    expect(svg).toContain("<circle");
    expect(svg).toContain("xmlns=\"http://www.w3.org/2000/svg\"");
  });

  it("emits monochrome strokes as black", () => {
    const svg = renderToSvg(drawing(entities), { colorMode: "monochrome", maxWidth: 1000, maxHeight: 1000, margin: 50 });
    expect(svg).toContain("stroke=\"#000000\"");
    expect(svg).not.toContain("stroke=\"#ff0000\"");
  });

  it("keeps entity colors in color mode", () => {
    const svg = renderToSvg(drawing(entities), { colorMode: "color", maxWidth: 1000, maxHeight: 1000, margin: 50 });
    expect(svg).toContain("stroke=\"#ff0000\"");
  });

  it("renders the white background first", () => {
    const svg = renderToSvg(drawing(entities), { colorMode: "monochrome", maxWidth: 1000, maxHeight: 1000, margin: 50 });
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf("<line"));
  });

  it("samples an arc as a polyline path with more than two points", () => {
    const arcEntities: Entity[] = [
      {
        type: "ARC",
        center: { x: 0, y: 0 },
        radius: 100,
        startAngle: 0,
        endAngle: Math.PI,
        color: "#000000",
        layer: "0",
        lineWeight: 25,
        sourceType: "ARC",
      },
    ];
    const svg = renderToSvg(drawing(arcEntities), { colorMode: "monochrome", maxWidth: 800, maxHeight: 800, margin: 50 });
    const m = svg.match(/<path d="(M[^"]+)"/);
    expect(m).not.toBeNull();
    if (m) {
      const commands = m[1].split("L").length;
      expect(commands).toBeGreaterThan(3);
    }
  });

  it("escapes XML special characters in text", () => {
    const textEntities: Entity[] = [
      {
        type: "TEXT",
        position: { x: 0, y: 0 },
        rotation: 0.5,
        height: 10,
        text: "<a & b>",
        alignment: { horizontal: "left", vertical: "baseline" },
        color: "#000000",
        layer: "0",
        lineWeight: 25,
        sourceType: "TEXT",
      },
    ];
    const svg = renderToSvg(drawing(textEntities), { colorMode: "monochrome", maxWidth: 800, maxHeight: 800, margin: 50 });
    expect(svg).toContain("&lt;a &amp; b&gt;");
    expect(svg).not.toContain("<a & b>");
  });

  it("applies a rotation transform when the text is rotated", () => {
    const textEntities: Entity[] = [
      {
        type: "TEXT",
        position: { x: 0, y: 0 },
        rotation: Math.PI / 2,
        height: 10,
        text: "vertical",
        alignment: { horizontal: "left", vertical: "baseline" },
        color: "#000000",
        layer: "0",
        lineWeight: 25,
        sourceType: "TEXT",
      },
    ];
    const svg = renderToSvg(drawing(textEntities), { colorMode: "monochrome", maxWidth: 800, maxHeight: 800, margin: 50 });
    expect(svg).toContain("rotate(-90");
  });

  it("renders a filled solid as a filled polygon", () => {
    const solidEntities: Entity[] = [
      {
        type: "SOLID",
        vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
        filled: true,
        color: "#000000",
        layer: "0",
        lineWeight: 25,
        sourceType: "SOLID",
      },
    ];
    const svg = renderToSvg(drawing(solidEntities), { colorMode: "monochrome", maxWidth: 800, maxHeight: 800, margin: 50 });
    expect(svg).toContain("<polygon");
    expect(svg).toContain('fill="#000000"');
  });

  it("renders a 3D face (unfilled solid) as an outlined polygon", () => {
    const faceEntities: Entity[] = [
      {
        type: "SOLID",
        vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
        filled: false,
        color: "#000000",
        layer: "0",
        lineWeight: 25,
        sourceType: "3DFACE",
      },
    ];
    const svg = renderToSvg(drawing(faceEntities), { colorMode: "monochrome", maxWidth: 800, maxHeight: 800, margin: 50 });
    expect(svg).toContain("<polygon");
    expect(svg).toContain('fill="none"');
  });

  it("renders a raster image as a light placeholder frame", () => {
    const imageEntities: Entity[] = [
      {
        type: "IMAGE",
        vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }],
        color: "#000000",
        layer: "0",
        lineWeight: 25,
        sourceType: "IMAGE",
      },
    ];
    const svg = renderToSvg(drawing(imageEntities), { colorMode: "monochrome", maxWidth: 800, maxHeight: 800, margin: 50 });
    expect(svg).toContain("<polygon");
    expect(svg).toContain('fill="#e5e7eb"');
    expect(svg).toContain('stroke="#000000"');
  });

  it("wraps content in a scaled group when supersampling", () => {
    const svg = renderToSvg(drawing(entities), {
      colorMode: "monochrome",
      maxWidth: 800,
      maxHeight: 800,
      margin: 50,
      supersample: 2,
    });
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600"');
    expect(svg).toContain('<g transform="scale(2)">');
  });
});

const baseEntity = { color: "#000000", layer: "0", lineWeight: 25, sourceType: "LINE" as const };

/** A drawing with a paper-space page: border + one viewport windowing model space. */
function pageDrawing(viewportOverrides?: Partial<PageViewport>): Drawing {
  const viewport: PageViewport = {
    minX: 50,
    minY: 100,
    maxX: 350,
    maxY: 300,
    centerX: 200,
    centerY: 200,
    width: 300,
    height: 200,
    viewCenterX: 50,
    viewCenterY: 50,
    viewWidth: 150,
    viewHeight: 100,
    twist: 0,
    frozenLayers: [],
    ...viewportOverrides,
  };
  const page: Page = {
    entities: [
      { type: "LINE", start: { x: 50, y: 100 }, end: { x: 350, y: 300 }, ...baseEntity },
    ],
    viewports: [viewport],
    bounds: { minX: 50, minY: 100, maxX: 350, maxY: 300 },
  };
  const modelLine: Entity = { type: "LINE", start: { x: 50, y: 50 }, end: { x: 60, y: 60 }, ...baseEntity };
  return {
    entities: [modelLine],
    layers: [],
    blocks: [],
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    page,
  };
}

const PAGE_OPTIONS = { colorMode: "monochrome", maxWidth: 800, maxHeight: 800, margin: 50 } as const;

describe("renderToSvg with a paper-space page", () => {
  it("emits a clip mask per viewport window", () => {
    const svg = renderToSvg(pageDrawing(), PAGE_OPTIONS);
    expect(svg).toContain('<clipPath id="vp-0">');
    expect(svg).toContain('clip-path="url(#vp-0)"');
  });

  it("draws the sheet entities and the model content through the viewport", () => {
    const svg = renderToSvg(pageDrawing(), PAGE_OPTIONS);
    const lines = svg.match(/<line\b/g);
    expect(lines).not.toBeNull();
    // One sheet border line plus the model line projected into the viewport.
    expect(lines!.length).toBe(2);
    // The model line (50,50)->(60,60) lands at page (200,200)->(220,220):
    // px = 50 + (x-50)*scale, scale = min(700/300, 700/200) = 7/3.
    expect(svg).toContain('x1="400" y1="283.333" x2="446.667" y2="236.667"');
  });

  it("respects layers frozen inside a viewport", () => {
    const svg = renderToSvg(pageDrawing({ frozenLayers: ["0"] }), PAGE_OPTIONS);
    const lines = svg.match(/<line\b/g);
    // Only the page border line survives; the frozen model layer is hidden.
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(1);
  });

  it("sizes the canvas from the page bounds, not the raw model bounds", () => {
    const svg = renderToSvg(pageDrawing(), PAGE_OPTIONS);
    expect(svg).toContain('width="800" height="567"');
  });
});

/** A heavy page drawing: one sheet border plus thousands of model entities. */
function heavyPageDrawing(): Drawing {
  const viewport: PageViewport = {
    minX: 50,
    minY: 100,
    maxX: 350,
    maxY: 300,
    centerX: 200,
    centerY: 200,
    width: 300,
    height: 200,
    viewCenterX: 50,
    viewCenterY: 50,
    viewWidth: 150,
    viewHeight: 100,
    twist: 0,
    frozenLayers: [],
  };
  const page: Page = {
    entities: [{ type: "LINE", start: { x: 50, y: 100 }, end: { x: 350, y: 300 }, ...baseEntity }],
    viewports: [viewport],
    bounds: { minX: 50, minY: 100, maxX: 350, maxY: 300 },
  };
  const model: Entity[] = [];
  for (let i = 0; i < 4000; i++) {
    model.push({ type: "LINE", start: { x: i, y: 0 }, end: { x: i + 1, y: 1 }, ...baseEntity });
  }
  model.push({ type: "POINT", position: { x: 10, y: 5 }, color: "#000000", layer: "0", lineWeight: 0, sourceType: "POINT" });
  model.push({
    type: "TEXT",
    position: { x: 1, y: 1 },
    rotation: 0,
    height: 2,
    text: "note",
    alignment: { horizontal: "left", vertical: "baseline" },
    color: "#000000",
    layer: "0",
    lineWeight: 25,
    sourceType: "TEXT",
  });
  return { entities: model, layers: [], blocks: [], bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, page };
}

const countLines = (svg: string) => (svg.match(/<line\b/g) ?? []).length;

describe("lite rendering for picker thumbnails", () => {
  it("decimates model content inside viewports", () => {
    const full = renderToSvg(heavyPageDrawing(), PAGE_OPTIONS);
    const lite = renderToSvg(heavyPageDrawing(), { ...PAGE_OPTIONS, lite: true });
    // Full: sheet border + the model lines whose boxes overlap the viewport
    // window (viewCenter 50,50 width 150 => x -25..125, covering i=0..125).
    expect(countLines(full)).toBe(127);
    // Lite: the border stays, but the model is sampled down to a fixed cap.
    expect(countLines(lite)).toBeGreaterThan(0);
    expect(countLines(lite)).toBeLessThanOrEqual(2001);
  });

  it("drops text and points in lite thumbnails but keeps them elsewhere", () => {
    const full = renderToSvg(heavyPageDrawing(), PAGE_OPTIONS);
    const lite = renderToSvg(heavyPageDrawing(), { ...PAGE_OPTIONS, lite: true });
    expect(full).toContain("<text");
    expect(full).toContain("<circle");
    expect(lite).not.toContain("<text");
    expect(lite).not.toContain("<circle");
  });

  it("switches to fast preview frames for very large models", () => {
    // Over the fast-preview threshold (12000): the model must not be projected
    // through the viewport; instead the window is drawn as a dashed frame.
    const viewport: PageViewport = {
      minX: 50,
      minY: 100,
      maxX: 350,
      maxY: 300,
      centerX: 200,
      centerY: 200,
      width: 300,
      height: 200,
      viewCenterX: 50,
      viewCenterY: 50,
      viewWidth: 150,
      viewHeight: 100,
      twist: 0,
      frozenLayers: [],
    };
    const page: Page = {
      entities: [{ type: "LINE", start: { x: 50, y: 100 }, end: { x: 350, y: 300 }, ...baseEntity }],
      viewports: [viewport],
      bounds: { minX: 50, minY: 100, maxX: 350, maxY: 300 },
    };
    const model: Entity[] = [];
    for (let i = 0; i < 12050; i++) {
      model.push({ type: "LINE", start: { x: i, y: 0 }, end: { x: i + 1, y: 1 }, ...baseEntity });
    }
    const big: Drawing = { entities: model, layers: [], blocks: [], bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, page };

    const svg = renderToSvg(big, { ...PAGE_OPTIONS, lite: true });
    // Only the sheet border line survives; the 12050 model lines are skipped.
    expect(countLines(svg)).toBe(1);
    // The viewport rectangle is framed instead of the model content.
    expect(svg).toContain('stroke-dasharray="4 3"');
  });
});