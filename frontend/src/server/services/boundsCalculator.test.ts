import { describe, expect, it } from "vitest";
import { drawingBounds, entityBounds } from "./boundsCalculator";
import type { Entity } from "../models/entity";

function lineFixture(start = { x: 0, y: 0 }, end = { x: 100, y: 100 }): Entity {
  return {
    type: "LINE",
    start,
    end,
    color: "#000000",
    layer: "0",
    lineWeight: 25,
    sourceType: "LINE",
  };
}

describe("entityBounds", () => {
  it("bounds a line by its endpoints", () => {
    const box = entityBounds(lineFixture({ x: 10, y: 20 }, { x: -5, y: 5 }));
    expect(box).toEqual({ minX: -5, minY: 5, maxX: 10, maxY: 20 });
  });

  it("bounds a circle", () => {
    const box = entityBounds({
      type: "CIRCLE",
      center: { x: 10, y: 20 },
      radius: 4,
      color: "#000000",
      layer: "0",
      lineWeight: 25,
      sourceType: "CIRCLE",
    });
    expect(box.minX).toBeCloseTo(6);
    expect(box.minY).toBeCloseTo(16);
    expect(box.maxX).toBeCloseTo(14);
    expect(box.maxY).toBeCloseTo(24);
  });

  it("bounds a bulge polyline outside its vertices", () => {
    // Bulge -1 = a CW arc from (0,0) to (10,0), which sweeps over the upper
    // semicircle (through y = +5) instead of the straight chord.
    const box = entityBounds({
      type: "POLYLINE",
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      bulges: [-1],
      closed: false,
      color: "#000000",
      layer: "0",
      lineWeight: 25,
      sourceType: "LWPOLYLINE",
    });
    expect(box.minX).toBeCloseTo(0);
    expect(box.maxX).toBeCloseTo(10);
    expect(box.maxY).toBeGreaterThan(4);
    expect(box.minY).toBeCloseTo(0);
  });

  it("bounds a solid by its vertices", () => {
    const box = entityBounds({
      type: "SOLID",
      vertices: [
        { x: 5, y: 10 },
        { x: 40, y: 10 },
        { x: 40, y: 30 },
        { x: 5, y: 30 },
      ],
      filled: true,
      color: "#000000",
      layer: "0",
      lineWeight: 25,
      sourceType: "SOLID",
    });
    expect(box).toEqual({ minX: 5, minY: 10, maxX: 40, maxY: 30 });
  });

  it("bounds an image by its placement corners", () => {
    const box = entityBounds({
      type: "IMAGE",
      vertices: [
        { x: 5, y: 10 },
        { x: 40, y: 10 },
        { x: 40, y: 30 },
        { x: 5, y: 30 },
      ],
      color: "#000000",
      layer: "0",
      lineWeight: 25,
      sourceType: "IMAGE",
    });
    expect(box).toEqual({ minX: 5, minY: 10, maxX: 40, maxY: 30 });
  });

  it("bounds a full horizontal ellipse by both the major and minor radii", () => {
    const box = entityBounds({
      type: "ELLIPSE",
      center: { x: 10, y: 20 },
      majorAxisEndPoint: { x: 4, y: 0 },
      radiusRatio: 0.5,
      startAngle: 0,
      endAngle: Math.PI * 2,
      full: true,
      color: "#000000",
      layer: "0",
      lineWeight: 25,
      sourceType: "ELLIPSE",
    });
    expect(box.minX).toBeCloseTo(6);
    expect(box.minY).toBeCloseTo(18);
    expect(box.maxX).toBeCloseTo(14);
    expect(box.maxY).toBeCloseTo(22);
  });

  it("bounds a rotated full ellipse", () => {
    const box = entityBounds({
      type: "ELLIPSE",
      center: { x: 0, y: 0 },
      majorAxisEndPoint: { x: 4, y: 4 },
      radiusRatio: 0.5,
      startAngle: 0,
      endAngle: Math.PI * 2,
      full: true,
      color: "#000000",
      layer: "0",
      lineWeight: 25,
      sourceType: "ELLIPSE",
    });
    const half = Math.hypot(4, 2);
    expect(box.minX).toBeCloseTo(-half);
    expect(box.minY).toBeCloseTo(-half);
    expect(box.maxX).toBeCloseTo(half);
    expect(box.maxY).toBeCloseTo(half);
  });

  it("bounds a partial ellipse within its sweep", () => {
    // Upper half of a horizontal ellipse: major 10 along +X, ratio 0.5 picks
    // up the y-extreme (t = π/2) inside the sweep.
    const box = entityBounds({
      type: "ELLIPSE",
      center: { x: 0, y: 0 },
      majorAxisEndPoint: { x: 10, y: 0 },
      radiusRatio: 0.5,
      startAngle: 0,
      endAngle: Math.PI,
      full: false,
      color: "#000000",
      layer: "0",
      lineWeight: 25,
      sourceType: "ELLIPSE",
    });
    expect(box.minX).toBeCloseTo(-10);
    expect(box.maxX).toBeCloseTo(10);
    expect(box.minY).toBeCloseTo(0);
    expect(box.maxY).toBeCloseTo(5);
  });

  it("collapses a degenerate ellipse to its center", () => {
    const box = entityBounds({
      type: "ELLIPSE",
      center: { x: 3, y: 7 },
      majorAxisEndPoint: { x: 0, y: 0 },
      radiusRatio: 0.5,
      startAngle: 0,
      endAngle: Math.PI,
      full: false,
      color: "#000000",
      layer: "0",
      lineWeight: 25,
      sourceType: "ELLIPSE",
    });
    expect(box).toEqual({ minX: 3, minY: 7, maxX: 3, maxY: 7 });
  });
});

describe("drawingBounds", () => {
  it("unions every entity", () => {
    const entities: Entity[] = [
      lineFixture(),
      {
        type: "CIRCLE",
        center: { x: 1000, y: 1000 },
        radius: 10,
        color: "#000000",
        layer: "0",
        lineWeight: 25,
        sourceType: "CIRCLE",
      },
    ];
    const bounds = drawingBounds(entities);
    expect(bounds).not.toBeNull();
    if (bounds) {
      expect(bounds.maxX).toBe(1010);
      expect(bounds.maxY).toBe(1010);
    }
  });

  it("returns null for an empty drawing", () => {
    expect(drawingBounds([])).toBeNull();
  });
});