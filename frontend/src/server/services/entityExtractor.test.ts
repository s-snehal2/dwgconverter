import { describe, expect, it } from "vitest";
import {
  Face3D,
  Hatch,
  HatchBoundaryPath,
  HatchBoundaryPathLine,
  LayerFlags,
  Leader,
  RasterImage,
  Solid,
  Spline,
  XY,
  XYZ,
} from "@node-projects/acad-ts";
import type { Entity as AcadEntity, Layer as AcadLayer } from "@node-projects/acad-ts";
import { entityIsVisible, extractEntity, extractHatch, extractLeader, layerIsVisible } from "./entityExtractor";

function layer(overrides: Partial<AcadLayer> = {}): AcadLayer {
  return {
    name: "TEST",
    isOn: true,
    layerFlags: LayerFlags.None,
    ...overrides,
  } as unknown as AcadLayer;
}

function entity(overrides: Partial<AcadEntity> = {}): AcadEntity {
  return {
    layer: layer(),
    isInvisible: false,
    ...overrides,
    // override layer with cast to satisfy TS union problems
  } as unknown as AcadEntity;
}

describe("layerIsVisible", () => {
  it("returns true for a visible layer", () => {
    expect(layerIsVisible(layer())).toBe(true);
  });

  it("returns false when the layer is off", () => {
    expect(layerIsVisible(layer({ isOn: false }))).toBe(false);
  });

  it("returns false when the layer is frozen", () => {
    expect(layerIsVisible(layer({ layerFlags: LayerFlags.Frozen }))).toBe(false);
  });

  it("returns true when there is no layer", () => {
    expect(layerIsVisible(undefined)).toBe(true);
    expect(layerIsVisible(null)).toBe(true);
  });
});

describe("entityIsVisible", () => {
  it("returns false for an invisible entity", () => {
    expect(entityIsVisible(entity({ isInvisible: true }))).toBe(false);
  });

  it("returns false when the entity's layer is off", () => {
    expect(entityIsVisible(entity({ layer: layer({ isOn: false }) }))).toBe(false);
  });

  it("returns true for a plain visible entity", () => {
    expect(entityIsVisible(entity())).toBe(true);
  });
});

describe("extractEntity for formerly-unsupported types", () => {
  it("tessellates a spline into a dense polyline", () => {
    const spline = new Spline();
    spline.fitPoints = [new XYZ(0, 0, 0), new XYZ(10, 5, 0), new XYZ(20, 0, 0)];
    spline.updateFromFitPoints(2);
    const normalized = extractEntity(spline);
    expect(normalized).not.toBeNull();
    expect(normalized?.type).toBe("POLYLINE");
    if (normalized?.type === "POLYLINE") {
      expect(normalized.vertices.length).toBeGreaterThan(2);
      expect(normalized.bulges.every((b) => b === 0)).toBe(true);
    }
  });

  it("maps a SOLID to a filled polygon", () => {
    const solid = new Solid();
    solid.firstCorner = new XYZ(0, 0, 0);
    solid.secondCorner = new XYZ(10, 0, 0);
    solid.thirdCorner = new XYZ(10, 10, 0);
    solid.fourthCorner = new XYZ(0, 10, 0);
    const normalized = extractEntity(solid);
    expect(normalized).toMatchObject({ type: "SOLID", filled: true, sourceType: "SOLID" });
    if (normalized?.type === "SOLID") {
      expect(normalized.vertices).toHaveLength(4);
    }
  });

  it("maps a 3DFACE to an outlined polygon", () => {
    const face = new Face3D();
    face.firstCorner = new XYZ(0, 0, 0);
    face.secondCorner = new XYZ(10, 0, 0);
    face.thirdCorner = new XYZ(10, 10, 0);
    face.fourthCorner = new XYZ(0, 10, 0);
    const normalized = extractEntity(face);
    expect(normalized).toMatchObject({ type: "SOLID", filled: false, sourceType: "3DFACE" });
  });

  it("maps a raster image to its placement quadrilateral", () => {
    const image = new RasterImage();
    image.insertPoint = new XYZ(0, 0, 0);
    image.uVector = new XYZ(10, 0, 0);
    image.vVector = new XYZ(0, 5, 0);
    const normalized = extractEntity(image);
    expect(normalized).toMatchObject({ type: "IMAGE", sourceType: "IMAGE" });
    if (normalized?.type === "IMAGE") {
      expect(normalized.vertices).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ]);
    }
  });

  it("maps a rotated image to its four corners", () => {
    const image = new RasterImage();
    image.insertPoint = new XYZ(0, 0, 0);
    image.uVector = new XYZ(0, 10, 0);
    image.vVector = new XYZ(-5, 0, 0);
    const normalized = extractEntity(image);
    expect(normalized).toBeDefined();
    if (normalized?.type === "IMAGE") {
      expect(normalized.vertices).toHaveLength(4);
      expect(normalized.vertices.map((v) => [Math.round(v.x), Math.round(v.y)])).toEqual([
        [0, 0],
        [0, 10],
        [-5, 10],
        [-5, 0],
      ]);
    }
  });

  it("drops a raster image with no usable geometry", () => {
    const image = new RasterImage();
    image.insertPoint = new XYZ(0, 0, 0);
    image.uVector = new XYZ(0, 0, 0);
    image.vVector = new XYZ(0, 0, 0);
    const normalized = extractEntity(image);
    expect(normalized).toBeNull();
  });
});

describe("extractHatch", () => {
  function squarePath(inset = 0): HatchBoundaryPath {
    const path = new HatchBoundaryPath();
    const edge = (ax: number, ay: number, bx: number, by: number) => {
      const line = new HatchBoundaryPathLine();
      line.start = new XY(ax, ay);
      line.end = new XY(bx, by);
      return line;
    };
    path.edges = [
      edge(0 + inset, 0 + inset, 10 + inset, 0 + inset),
      edge(10 + inset, 0 + inset, 10 + inset, 10 + inset),
      edge(10 + inset, 10 + inset, 0 + inset, 10 + inset),
      edge(0 + inset, 10 + inset, 0 + inset, 0 + inset),
    ];
    return path;
  }

  it("turns a solid hatch into a filled boundary polygon", () => {
    const hatch = new Hatch();
    hatch.isSolid = true;
    hatch.paths = [squarePath()];
    const entities = extractHatch(hatch);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: "SOLID", filled: true, sourceType: "HATCH" });
    if (entities[0].type === "SOLID") {
      expect(entities[0].vertices.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("keeps duplicates out of the boundary loop", () => {
    const hatch = new Hatch();
    hatch.isSolid = true;
    hatch.paths = [squarePath()];
    const entities = extractHatch(hatch);
    if (entities[0].type === "SOLID") {
      const vertices = entities[0].vertices;
      for (let i = 0; i < vertices.length - 1; i++) {
        const dx = Math.abs(vertices[i].x - vertices[i + 1].x);
        const dy = Math.abs(vertices[i].y - vertices[i + 1].y);
        expect(dx + dy).toBeGreaterThan(1e-6);
      }
    }
  });
});

describe("extractLeader", () => {
  function leader(vertices: [number, number][], arrowHeadEnabled = true): Leader {
    const l = new Leader();
    l.vertices = vertices.map(([x, y]) => new XYZ(x, y, 0));
    l.arrowHeadEnabled = arrowHeadEnabled;
    return l;
  }

  it("renders the path plus a filled arrowhead at the tip", () => {
    const entities = extractLeader(leader([[0, 0], [100, 0]]));
    expect(entities).toHaveLength(2);

    expect(entities[0]).toMatchObject({ type: "POLYLINE", closed: false });
    if (entities[0].type === "POLYLINE") {
      expect(entities[0].vertices.map((v) => [v.x, v.y])).toEqual([
        [0, 0],
        [100, 0],
      ]);
    }

    expect(entities[1]).toMatchObject({ type: "SOLID", filled: true });
    if (entities[1].type === "SOLID") {
      expect(entities[1].vertices).toHaveLength(3);
      const vertices = entities[1].vertices;
      const tip = vertices.find((v) => Math.abs(v.x - 100) < 1e-6 && Math.abs(v.y) < 1e-6);
      expect(tip).toBeDefined();
      const base = vertices.filter((v) => v !== tip);
      // The base sits behind the tip on the path and flares symetrically.
      expect(base[0].x).toBeLessThan(100);
      expect(base[1].x).toBeCloseTo(base[0].x);
      expect(base[1].y).toBeCloseTo(-base[0].y);
    }
  });

  it("skips the arrowhead when arrows are disabled", () => {
    const entities = extractLeader(leader([[0, 0], [100, 0]], false));
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: "POLYLINE" });
  });

  it("returns only the path for a single-vertex leader", () => {
    const entities = extractLeader(leader([[50, 50]]));
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: "POLYLINE" });
  });

  it("returns nothing for a leader without vertices", () => {
    expect(extractLeader(leader([]))).toEqual([]);
  });
});