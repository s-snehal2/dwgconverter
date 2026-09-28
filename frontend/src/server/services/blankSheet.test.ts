import { describe, expect, it } from "vitest";

import {
  DRAWING_ENTITY_TYPES,
  hasSheetDrawing,
  isDrawingEntity,
  partitionRenderable,
} from "./blankSheet";
import type { InspectedView } from "./convertDwg";
import type { Bounds } from "../models/bounds";
import type { Entity } from "../models/entity";
import type { Page, PageViewport } from "../models/page";

const base = {
  color: "#000000",
  lineWeight: 25,
  sourceType: "LINE",
};

function line(x1: number, y1: number, x2: number, y2: number, layer = "0"): Entity {
  return { ...base, type: "LINE", layer, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

function circle(x: number, y: number, radius: number, layer = "0"): Entity {
  return { ...base, type: "CIRCLE", layer, center: { x, y }, radius };
}

function point(x: number, y: number, layer = "0"): Entity {
  return { ...base, type: "POINT", layer, position: { x, y } };
}

function text(x: number, y: number, layer = "0"): Entity {
  return {
    ...base,
    type: "TEXT",
    layer,
    position: { x, y },
    rotation: 0,
    height: 2.5,
    text: "NOTE",
    alignment: { horizontal: "left", vertical: "baseline" },
  };
}

/**
 * A viewport showing model region 0..100 in both axes, drawn as a 100x100 rect
 * centred on the page. With `scaleTo` the page rect shrinks but the model region
 * stays put, which is what a 1:50 viewport looks like.
 */
function viewport(overrides: Partial<PageViewport> = {}): PageViewport {
  return {
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 100,
    centerX: 50,
    centerY: 50,
    width: 100,
    height: 100,
    viewCenterX: 50,
    viewCenterY: 50,
    viewWidth: 100,
    viewHeight: 100,
    twist: 0,
    frozenLayers: [],
    ...overrides,
  };
}

const emptyBounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

function pageOf(viewports: PageViewport[], entities: Entity[] = []): Page {
  return { entities, viewports, bounds: emptyBounds };
}

function layout(name: string, page: Page | undefined, entities: Entity[] = []): InspectedView {
  return {
    viewId: `layout-${name}`,
    name,
    isModel: false,
    version: "AC1027",
    drawing: { bounds: emptyBounds, entities, layers: [], blocks: [], page },
    statistics: { totalEntities: 0, renderedEntities: 0, skippedEntities: 0, warnings: [] },
  };
}

function modelView(name: string, entities: Entity[]): InspectedView {
  return {
    viewId: `model-${name}`,
    name,
    isModel: true,
    version: "AC1027",
    drawing: { bounds: emptyBounds, entities, layers: [], blocks: [] },
    statistics: { totalEntities: entities.length, renderedEntities: entities.length, skippedEntities: 0, warnings: [] },
  };
}

describe("isDrawingEntity", () => {
  it("counts the geometry types that visibly draw something", () => {
    expect(isDrawingEntity(line(0, 0, 10, 10))).toBe(true);
    expect(isDrawingEntity(circle(5, 5, 3))).toBe(true);
    expect(isDrawingEntity({ ...base, type: "ARC", layer: "0", center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: 1 })).toBe(true);
    expect(isDrawingEntity({ ...base, type: "ELLIPSE", layer: "0", center: { x: 0, y: 0 }, majorAxisEndPoint: { x: 5, y: 0 }, radiusRatio: 0.5, startAngle: 0, endAngle: Math.PI * 2, full: true })).toBe(true);
    expect(isDrawingEntity({ ...base, type: "POLYLINE", layer: "0", vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }], closed: false, bulges: [] })).toBe(true);
    expect(isDrawingEntity({ ...base, type: "SOLID", layer: "0", vertices: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], filled: true })).toBe(true);
    expect(isDrawingEntity({ ...base, type: "IMAGE", layer: "0", vertices: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }] })).toBe(true);
  });

  it("does not count text or a lone point", () => {
    expect(isDrawingEntity(text(10, 10))).toBe(false);
    expect(isDrawingEntity(point(10, 10))).toBe(false);
  });

  it("exposes the set so the definition is inspectable", () => {
    expect([...DRAWING_ENTITY_TYPES].sort()).toEqual([
      "ARC",
      "CIRCLE",
      "ELLIPSE",
      "IMAGE",
      "LINE",
      "POLYLINE",
      "SOLID",
    ]);
  });
});

describe("hasSheetDrawing for paper-space layouts", () => {
  it("keeps a layout whose viewport frames model geometry", () => {
    const view = layout("Plan", pageOf([viewport()]));
    expect(hasSheetDrawing(view, [line(10, 10, 90, 90)])).toBe(true);
  });

  it("drops a layout whose viewport frames empty model space", () => {
    const view = layout("Blank", pageOf([viewport()]));
    expect(hasSheetDrawing(view, [line(500, 500, 600, 600)])).toBe(false);
    expect(hasSheetDrawing(view, [])).toBe(false);
  });

  it("drops a layout with no viewport at all", () => {
    expect(hasSheetDrawing(layout("NoViewport", pageOf([])), [line(0, 0, 100, 100)])).toBe(false);
    expect(hasSheetDrawing(layout("NoPage", undefined), [line(0, 0, 100, 100)])).toBe(false);
  });

  it("ignores the page's own title-block linework when deciding", () => {
    // A busy border on the page: plenty of geometry, none of it in model space.
    const border = [
      line(0, 0, 840, 0, "TITLE"),
      line(840, 0, 840, 594, "TITLE"),
      line(840, 594, 0, 594, "TITLE"),
      line(0, 594, 0, 0, "TITLE"),
    ];
    const view = layout("TitleBlockOnly", pageOf([viewport()], border));
    expect(hasSheetDrawing(view, [])).toBe(false);
  });

  it("drops a layout whose only model entities are text or points", () => {
    const view = layout("TextOnly", pageOf([viewport()]));
    expect(hasSheetDrawing(view, [text(50, 50)])).toBe(false);
    expect(hasSheetDrawing(view, [point(50, 50)])).toBe(false);
    expect(hasSheetDrawing(view, [text(50, 50), point(10, 10)])).toBe(false);
  });

  it("drops a layout when the only drawing is on a layer frozen in its viewport", () => {
    const view = layout("Frozen", pageOf([viewport({ frozenLayers: ["HIDDEN"] })]));
    expect(hasSheetDrawing(view, [line(10, 10, 90, 90, "HIDDEN")])).toBe(false);
    expect(hasSheetDrawing(view, [line(10, 10, 90, 90, "VISIBLE")])).toBe(true);
  });

  it("keeps a layout where one of several viewports shows geometry", () => {
    const view = layout("TwoViewports", pageOf([viewport(), viewport({ viewCenterX: 500, viewCenterY: 500 })]));
    expect(hasSheetDrawing(view, [line(490, 490, 510, 510)])).toBe(true);
  });

  it("respects viewport scale (a 1:50 window still shows the same model region)", () => {
    // Page rect 2x2 units showing model 0..100 → scale 0.02.
    const small = viewport({ minX: 0, minY: 0, maxX: 2, maxY: 2, centerX: 1, centerY: 1, width: 2, height: 2 });
    const view = layout("Scaled", pageOf([small]));
    expect(hasSheetDrawing(view, [line(10, 10, 90, 90)])).toBe(true);
    expect(hasSheetDrawing(view, [line(400, 400, 500, 500)])).toBe(false);
  });

  it("finds geometry inside a twisted viewport", () => {
    // 90° twist: model +X maps to page +Y, so the window still covers the
    // same model region and the line inside it must still be detected.
    const twisted = viewport({ twist: Math.PI / 2 });
    const view = layout("Twisted", pageOf([twisted]));
    expect(hasSheetDrawing(view, [line(10, 10, 90, 90)])).toBe(true);
    expect(hasSheetDrawing(view, [line(500, 500, 600, 600)])).toBe(false);
  });

  it("keeps a layout when a large entity merely overlaps the window edge", () => {
    // A big circle straddling the boundary is genuinely partly visible.
    const view = layout("Straddling", pageOf([viewport()]));
    expect(hasSheetDrawing(view, [circle(100, 50, 40)])).toBe(true);
  });
});

describe("hasSheetDrawing for model crops", () => {
  it("keeps a crop holding geometry", () => {
    expect(hasSheetDrawing(modelView("Model", [line(0, 0, 10, 10)]), [])).toBe(true);
    expect(hasSheetDrawing(modelView("Model", [circle(0, 0, 5)]), [])).toBe(true);
  });

  it("drops a crop of a single stray point", () => {
    expect(hasSheetDrawing(modelView("Model", [point(3, 3)]), [])).toBe(false);
  });

  it("drops a crop of only text", () => {
    expect(hasSheetDrawing(modelView("Model", [text(1, 1), text(5, 5)]), [])).toBe(false);
  });

  it("drops an empty crop", () => {
    expect(hasSheetDrawing(modelView("Model", []), [])).toBe(false);
  });

  it("ignores the model entities argument, since a crop stands alone", () => {
    expect(hasSheetDrawing(modelView("Model", [line(0, 0, 1, 1)]), [point(9, 9)])).toBe(true);
  });
});

describe("partitionRenderable", () => {
  it("keeps drawable sheets in order and records the rest with a reason", () => {
    const views = [
      layout("Good", pageOf([viewport()])),
      layout("Empty", pageOf([viewport({ viewCenterX: 5000, viewCenterY: 5000 })])),
      modelView("Model", [line(0, 0, 10, 10)]),
      modelView("Model 2", [point(1, 1)]),
    ];
    const { renderable, omitted } = partitionRenderable(views, [line(10, 10, 90, 90)]);
    expect(renderable.map((view) => view.name)).toEqual(["Good", "Model"]);
    expect(omitted).toEqual([
      { name: "Empty", reason: "no-drawing" },
      { name: "Model 2", reason: "no-drawing" },
    ]);
  });

  it("omits everything when nothing is drawable", () => {
    const { renderable, omitted } = partitionRenderable([layout("Empty", pageOf([viewport()]))], []);
    expect(renderable).toEqual([]);
    expect(omitted).toHaveLength(1);
  });
});
