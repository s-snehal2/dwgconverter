import { describe, expect, it } from "vitest";
import { modelToPagePoint, modelVectorToPage, projectEntityToPage } from "./viewportMapper";
import type { PageViewport } from "../models/page";
import type { Entity } from "../models/entity";

/** scale = height / viewHeight = 200 / 100 = 2. */
const VP: PageViewport = {
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

function lineEntity(start: [number, number], end: [number, number]): Entity {
  return {
    type: "LINE",
    start: { x: start[0], y: start[1] },
    end: { x: end[0], y: end[1] },
    color: "#000000",
    layer: "0",
    lineWeight: 25,
    sourceType: "LINE",
  };
}

describe("modelToPagePoint", () => {
  it("maps the viewport window center to the paper-frame center", () => {
    expect(modelToPagePoint(VP, 50, 50)).toEqual({ x: 200, y: 200 });
  });

  it("scales model deltas by height/viewHeight", () => {
    expect(modelToPagePoint(VP, 60, 50)).toEqual({ x: 220, y: 200 });
    expect(modelToPagePoint(VP, 50, 60)).toEqual({ x: 200, y: 220 });
  });

  it("maps the viewport window corners onto the paper frame corners", () => {
    expect(modelToPagePoint(VP, -25, 0)).toEqual({ x: 50, y: 100 });
    expect(modelToPagePoint(VP, 125, 100)).toEqual({ x: 350, y: 300 });
  });

  it("rotates around the view center when the viewport is twisted", () => {
    const twisted: PageViewport = { ...VP, twist: Math.PI / 2 };
    // (60,50) -> delta (10,0); 90 degree rotation -> (0,10), scaled by 2.
    const p = modelToPagePoint(twisted, 60, 50);
    expect(p.x).toBeCloseTo(200);
    expect(p.y).toBeCloseTo(220);
  });
});

describe("modelVectorToPage", () => {
  it("scales a vector without applying the center translation", () => {
    expect(modelVectorToPage(VP, 10, 5)).toEqual({ x: 20, y: 10 });
  });

  it("rotates and scales a vector under a twisted viewport", () => {
    const twisted: PageViewport = { ...VP, twist: Math.PI / 2 };
    const v = modelVectorToPage(twisted, 10, 0);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(20);
  });
});

describe("projectEntityToPage", () => {
  it("maps a line's endpoints", () => {
    const projected = projectEntityToPage(lineEntity([50, 50], [60, 60]), VP);
    expect(projected).toMatchObject({
      type: "LINE",
      start: { x: 200, y: 200 },
      end: { x: 220, y: 220 },
    });
  });

  it("scales a circle's radius and maps its center", () => {
    const projected = projectEntityToPage(
      { type: "CIRCLE", center: { x: 50, y: 50 }, radius: 25, color: "#000000", layer: "0", lineWeight: 25, sourceType: "CIRCLE" },
      VP
    );
    expect(projected.type).toBe("CIRCLE");
    if (projected.type === "CIRCLE") {
      expect(projected.center).toEqual({ x: 200, y: 200 });
      expect(projected.radius).toBe(50);
    }
  });

  it("adds the twist to an arc's angles", () => {
    const twisted: PageViewport = { ...VP, twist: Math.PI / 2 };
    const projected = projectEntityToPage(
      { type: "ARC", center: { x: 50, y: 50 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, color: "#000000", layer: "0", lineWeight: 25, sourceType: "ARC" },
      twisted
    );
    expect(projected.type).toBe("ARC");
    if (projected.type === "ARC") {
      expect(projected.startAngle).toBeCloseTo(Math.PI / 2);
      expect(projected.endAngle).toBeCloseTo(Math.PI);
    }
  });

  it("maps an ellipse's center and rotates/scales its major axis vector", () => {
    const twisted: PageViewport = { ...VP, twist: Math.PI / 2 };
    const projected = projectEntityToPage(
      { type: "ELLIPSE", center: { x: 50, y: 50 }, majorAxisEndPoint: { x: 10, y: 0 }, radiusRatio: 0.5, startAngle: 0, endAngle: Math.PI, full: false, color: "#000000", layer: "0", lineWeight: 25, sourceType: "ELLIPSE" },
      twisted
    );
    expect(projected.type).toBe("ELLIPSE");
    if (projected.type === "ELLIPSE") {
      expect(projected.center).toEqual({ x: 200, y: 200 });
      expect(projected.majorAxisEndPoint.x).toBeCloseTo(0);
      expect(projected.majorAxisEndPoint.y).toBeCloseTo(20);
    }
  });

  it("maps a polyline's vertices and keeps bulges", () => {
    const projected = projectEntityToPage(
      { type: "POLYLINE", vertices: [{ x: 50, y: 50 }, { x: 60, y: 60 }], closed: false, bulges: [0.5], color: "#000000", layer: "0", lineWeight: 25, sourceType: "LWPOLYLINE" },
      VP
    );
    expect(projected.type).toBe("POLYLINE");
    if (projected.type === "POLYLINE") {
      expect(projected.vertices[0]).toEqual({ x: 200, y: 200 });
      expect(projected.vertices[1]).toEqual({ x: 220, y: 220 });
      expect(projected.bulges).toEqual([0.5]);
    }
  });

  it("maps a solid's vertices through the viewport transform", () => {
    const projected = projectEntityToPage(
      { type: "SOLID", vertices: [{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 60 }], filled: true, color: "#000000", layer: "0", lineWeight: 25, sourceType: "SOLID" },
      VP
    );
    expect(projected.type).toBe("SOLID");
    if (projected.type === "SOLID") {
      expect(projected.vertices[0]).toEqual({ x: 200, y: 200 });
      expect(projected.vertices[1]).toEqual({ x: 220, y: 200 });
      expect(projected.vertices[2]).toEqual({ x: 220, y: 220 });
      expect(projected.filled).toBe(true);
    }
  });

  it("maps an image's vertices through the viewport transform", () => {
    const projected = projectEntityToPage(
      { type: "IMAGE", vertices: [{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 60 }, { x: 50, y: 60 }], color: "#000000", layer: "0", lineWeight: 25, sourceType: "IMAGE" },
      VP
    );
    expect(projected.type).toBe("IMAGE");
    if (projected.type === "IMAGE") {
      expect(projected.vertices).toEqual([
        { x: 200, y: 200 },
        { x: 220, y: 200 },
        { x: 220, y: 220 },
        { x: 200, y: 220 },
      ]);
    }
  });

  it("scales text height and adds the twist to text rotation", () => {
    const twisted: PageViewport = { ...VP, twist: Math.PI / 6 };
    const projected = projectEntityToPage(
      { type: "TEXT", position: { x: 50, y: 50 }, rotation: 0.3, height: 10, text: "hi", alignment: { horizontal: "left", vertical: "baseline" }, color: "#000000", layer: "0", lineWeight: 25, sourceType: "TEXT" },
      twisted
    );
    expect(projected.type).toBe("TEXT");
    if (projected.type === "TEXT") {
      expect(projected.position).toEqual({ x: 200, y: 200 });
      expect(projected.height).toBeCloseTo(20);
      expect(projected.rotation).toBeCloseTo(0.3 + Math.PI / 6);
    }
  });
});