import { describe, expect, it } from "vitest";
import {
  selectViewForConversion,
  selectViewsForConversion,
  supersampleForEntities,
  type InspectedView,
} from "./convertDwg";
import type { Drawing } from "../models/drawing";
import type { Entity, LineEntity } from "../models/entity";

const baseDrawing: Drawing = {
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  entities: [],
  layers: [],
  blocks: [],
};

function view(viewId: string, name: string, isModel: boolean): InspectedView {
  return {
    viewId,
    name,
    isModel,
    drawing: baseDrawing,
    statistics: { totalEntities: 0, renderedEntities: 0, skippedEntities: 0, warnings: [] },
    version: "AC1027",
  };
}

function line(x0: number, y0: number, x1: number, y1: number): LineEntity {
  return {
    type: "LINE",
    color: "#000000",
    layer: "0",
    lineWeight: 100,
    sourceType: "LINE",
    start: { x: x0, y: y0, z: 0 },
    end: { x: x1, y: y1, z: 0 },
  } as Entity as LineEntity;
}

/** A solid unit grid `n` x `n` at (x0, y0), used to stand in for one drawing. */
function grid(x0: number, y0: number, n: number): Entity[] {
  const out: Entity[] = [];
  for (let i = 0; i <= n; i++) {
    out.push(line(x0, y0 + i, x0 + n, y0 + i));
    out.push(line(x0 + i, y0, x0 + i, y0 + n));
  }
  return out;
}

/** A model view carrying real geometry, so clustering has something to split. */
function modelView(entities: Entity[]): InspectedView {
  return {
    ...view("model", "Model", true),
    drawing: { ...baseDrawing, entities },
    statistics: {
      totalEntities: entities.length,
      renderedEntities: entities.length,
      skippedEntities: 0,
      warnings: [],
    },
  };
}

describe("selectViewForConversion", () => {
  it("renders the single paper sheet directly when the DWG has a model space plus one layout", () => {
    const selected = selectViewForConversion([
      view("model", "Model", true),
      view("layout-0", "Model 1", false),
    ]);
    expect(selected.viewId).toBe("layout-0");
  });

  it("rejects a DWG with more than one layout sheet", () => {
    expect(() =>
      selectViewForConversion([
        view("model", "Model", true),
        view("layout-0", "CIVIL LAYOUT", false),
        view("layout-1", "FLOORING LAYOUT -QUARTZ", false),
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "MULTIPLE_LAYOUTS",
      })
    );
  });

  it("rejects layouts with elevation-like names too (no grouping)", () => {
    expect(() =>
      selectViewForConversion([
        view("model", "Model", true),
        view("layout-0", "ELEVATION AA", false),
        view("layout-1", "ELEVATION BB' (3)", false),
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "MULTIPLE_LAYOUTS",
      })
    );
  });

  it("honours a configured maxLayouts limit", () => {
    const selected = selectViewForConversion(
      [
        view("model", "Model", true),
        view("layout-0", "Layout 1", false),
        view("layout-1", "Layout 2", false),
      ],
      2
    );
    expect(selected.viewId).toBe("layout-0");
  });

  it("uses the model space directly when it is the only renderable view", () => {
    const selected = selectViewForConversion([view("model", "Model", true)]);
    expect(selected.viewId).toBe("model");
  });

  it("picks the single sheet when layouts exist but there is no model content", () => {
    const selected = selectViewForConversion([view("layout-0", "Layout 1", false)]);
    expect(selected.viewId).toBe("layout-0");
  });
});

describe("selectViewsForConversion", () => {
  it("returns every paper-space layout in order, then the model space", () => {
    // Model space holds every drawing parked side by side, so it is emitted
    // after the layouts as its own sheet rather than replacing them.
    const selected = selectViewsForConversion([
      view("model", "Model", true),
      view("layout-0", "CIVIL LAYOUT", false),
      view("layout-1", "FLOORING LAYOUT", false),
    ]);
    expect(selected.map((v) => v.viewId)).toEqual(["layout-0", "layout-1", "model"]);
  });

  it("falls back to the model space when there are no renderable layouts", () => {
    const selected = selectViewsForConversion([view("model", "Model", true)]);
    expect(selected.map((v) => v.viewId)).toEqual(["model"]);
  });

  it("emits one separately named crop per drawing parked in model space", () => {
    // Two grids 50 units apart are two drawings, so model space becomes two
    // tightly-cropped sheets named Model and Model 2.
    const model = modelView([...grid(0, 0, 10), ...grid(60, 0, 10)]);
    const selected = selectViewsForConversion([
      model,
      view("layout-0", "CIVIL LAYOUT", false),
    ]);
    expect(selected.map((v) => v.name)).toEqual(["CIVIL LAYOUT", "Model", "Model 2"]);
    expect(selected.map((v) => v.viewId)).toEqual(["layout-0", "model-0", "model-1"]);
    // Each crop carries only its own drawing, with tight bounds, which is what
    // produces the zoom.
    expect(selected[1].drawing.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(selected[2].drawing.bounds).toEqual({ minX: 60, minY: 0, maxX: 70, maxY: 10 });
    expect(selected[1].drawing.entities).toHaveLength(22);
    expect(selected[2].drawing.entities).toHaveLength(22);
  });

  it("keeps model crops inside the budget by merging them, never dropping them", () => {
    // Four separate drawings, but only two slots left after one layout, so the
    // crops are coarsened down to two. No entity may be lost.
    const model = modelView([
      ...grid(0, 0, 5),
      ...grid(200, 0, 5),
      ...grid(400, 0, 5),
      ...grid(600, 0, 5),
    ]);
    const selected = selectViewsForConversion([model, view("layout-0", "A", false)], 3);
    expect(selected.map((v) => v.name)).toEqual(["A", "Model", "Model 2"]);
    const modelEntities = selected
      .filter((v) => v.isModel)
      .flatMap((v) => v.drawing.entities);
    expect(modelEntities).toHaveLength(model.drawing.entities.length);
  });

  it("honours the maxLayouts cap and rejects more renderable sheets", () => {
    const views = [
      view("model", "Model", true),
      view("layout-0", "A", false),
      view("layout-1", "B", false),
    ];
    expect(selectViewsForConversion(views, 2).map((v) => v.viewId)).toEqual(["layout-0", "layout-1"]);
    expect(() => selectViewsForConversion(views, 1)).toThrowError(
      expect.objectContaining({ code: "MULTIPLE_LAYOUTS" })
    );
  });

  it("converts a 26-sheet DWG with the default cap of 100", () => {
    const views = [
      view("model", "Model", true),
      ...Array.from({ length: 26 }, (_, i) => view(`layout-${i}`, `Sheet ${i + 1}`, false)),
    ];
    const selected = selectViewsForConversion(views);
    // 26 layouts plus the model sheet, still inside the cap of 100.
    expect(selected).toHaveLength(27);
    expect(selected.map((v) => v.viewId)).toEqual([
      ...Array.from({ length: 26 }, (_, i) => `layout-${i}`),
      "model",
    ]);
  });

  it("uses the default cap of 100 and rejects over-cap DWGs with a count-aware message", () => {
    const views = [
      view("model", "Model", true),
      ...Array.from({ length: 101 }, (_, i) => view(`layout-${i}`, `Sheet ${i + 1}`, false)),
    ];
    expect(() => selectViewsForConversion(views)).toThrowError(
      expect.objectContaining({
        code: "MULTIPLE_LAYOUTS",
        message: expect.stringContaining("101 layout sheets"),
      })
    );
  });

  it("throws NO_DRAWABLE_CONTENT for an empty view list", () => {
    expect(() => selectViewsForConversion([])).toThrowError(
      expect.objectContaining({ code: "NO_DRAWABLE_CONTENT" })
    );
  });
});

describe("supersampleForEntities", () => {
  it("keeps the configured oversample for normal drawings", () => {
    expect(supersampleForEntities(1000, 2)).toBe(2);
  });

  it("renders huge drawings at exact size (no oversample)", () => {
    expect(supersampleForEntities(20000, 2)).toBe(1);
  });
});