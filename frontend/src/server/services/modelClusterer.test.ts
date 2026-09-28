import { describe, expect, it } from "vitest";
import {
  clusterModelEntities,
  limitClusters,
  DEFAULT_CLUSTER_OPTIONS,
  type ModelCluster,
} from "./modelClusterer";
import type { Entity, LineEntity } from "../models/entity";

/** A horizontal line from (x0, y0) to (x1, y0). */
function hline(x0: number, x1: number, y0: number): LineEntity {
  return {
    type: "LINE",
    color: "#000000",
    layer: "0",
    lineWeight: 100,
    sourceType: "LINE",
    start: { x: x0, y: y0, z: 0 },
    end: { x: x1, y: y0, z: 0 },
  } as Entity as LineEntity;
}

/** A vertical line from (x, y0) to (x, y1). */
function vline(x: number, y0: number, y1: number): LineEntity {
  return {
    type: "LINE",
    color: "#000000",
    layer: "0",
    lineWeight: 100,
    sourceType: "LINE",
    start: { x, y: y0, z: 0 },
    end: { x, y: y1, z: 0 },
  } as Entity as LineEntity;
}

/** A solid unit grid `n` x `n` spanning the given square. */
function grid(x0: number, y0: number, n: number, step = 1): LineEntity[] {
  const out: LineEntity[] = [];
  for (let i = 0; i <= n; i++) {
    out.push(hline(x0, x0 + n * step, y0 + i * step));
    out.push(vline(x0 + i * step, y0, y0 + n * step));
  }
  return out;
}

const OPTIONS = { gapFraction: 0.03, maxDepth: 12, minEntities: 2 };

describe("clusterModelEntities", () => {
  it("returns no clusters for an empty entity list", () => {
    expect(clusterModelEntities([], OPTIONS)).toEqual([]);
  });

  it("keeps a single entity as one cluster", () => {
    const clusters = clusterModelEntities([hline(0, 10, 0)], OPTIONS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 0 });
  });

  it("keeps a dense contiguous drawing as one cluster", () => {
    // A 50x50 grid has no internal whitespace wider than one step, so nothing
    // separates it: it must not be shredded into tiles.
    const clusters = clusterModelEntities(grid(0, 0, 50), OPTIONS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].entities.length).toBe(grid(0, 0, 50).length);
  });

  it("splits two drawings separated by a wide gap", () => {
    // Two 10x10 grids 50 units apart: a 30-unit gap on a 70-unit span is well
    // over the 3% threshold, so each grid becomes its own zoomed crop.
    const entities = [...grid(0, 0, 10), ...grid(60, 0, 10)];
    const clusters = clusterModelEntities(entities, OPTIONS);
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) {
      expect(cluster.entities.length).toBe(grid(0, 0, 10).length);
    }
    // Each crop is tight around its own grid, which is what produces the zoom.
    const sorted = [...clusters].sort((a, b) => a.bounds.minX - b.bounds.minX);
    expect(sorted[0].bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(sorted[1].bounds).toEqual({ minX: 60, minY: 0, maxX: 70, maxY: 10 });
  });

  it("splits drawings stacked vertically as well as horizontally", () => {
    const entities = [...grid(0, 0, 10), ...grid(0, 60, 10)];
    const clusters = clusterModelEntities(entities, OPTIONS);
    expect(clusters).toHaveLength(2);
  });

  it("recurses to find three or more separate drawings", () => {
    const entities = [...grid(0, 0, 10), ...grid(60, 0, 10), ...grid(120, 0, 10)];
    const clusters = clusterModelEntities(entities, OPTIONS);
    expect(clusters).toHaveLength(3);
  });

  it("does not split when the gap is below the threshold", () => {
    // 50-unit grid plus a second 50-unit grid separated by a 2-unit gap: on a
    // 102-unit span that is ~2%, under the 3% threshold, so it stays one crop.
    const entities = [...grid(0, 0, 50), ...grid(52, 0, 50)];
    expect(clusterModelEntities(entities, OPTIONS)).toHaveLength(1);
  });

  it("honours a smaller gapFraction by splitting more eagerly", () => {
    const entities = [...grid(0, 0, 50), ...grid(52, 0, 50)];
    const clusters = clusterModelEntities(entities, { ...OPTIONS, gapFraction: 0.01 });
    expect(clusters).toHaveLength(2);
  });

  it("assigns an entity straddling the cut wholly to one cluster", () => {
    // A single long line spans both grids and the gap between them. It must
    // land in exactly one cluster rather than being duplicated.
    const straddler = hline(0, 70, 5);
    const entities = [...grid(0, 0, 10), ...grid(60, 0, 10), straddler];
    const clusters = clusterModelEntities(entities, OPTIONS);
    const total = clusters.reduce((sum, c) => sum + c.entities.length, 0);
    expect(total).toBe(entities.length);
  });

  it("never loses or duplicates entities", () => {
    const entities = [
      ...grid(0, 0, 10),
      ...grid(60, 0, 10),
      ...grid(0, 60, 10),
      ...grid(120, 120, 10),
      hline(-500, 500, -500),
    ];
    const clusters = clusterModelEntities(entities, OPTIONS);
    const total = clusters.reduce((sum, c) => sum + c.entities.length, 0);
    expect(total).toBe(entities.length);
  });

  it("bounds recursion with maxDepth", () => {
    const entities = [
      ...grid(0, 0, 5),
      ...grid(200, 0, 5),
      ...grid(400, 0, 5),
      ...grid(600, 0, 5),
    ];
    const shallow = clusterModelEntities(entities, { ...OPTIONS, maxDepth: 0 });
    expect(shallow).toHaveLength(1);
    const deep = clusterModelEntities(entities, { ...OPTIONS, maxDepth: 10 });
    expect(deep).toHaveLength(4);
  });

  it("merges a lone stray entity into its nearest neighbour", () => {
    // Two real grids plus one stray tick parked off to the side. The stray
    // alone would be a useless mostly-empty PNG, so it is folded into the
    // nearest cluster. It sits a couple of drawing-widths out, which is as far
    // off as a real stray annotation realistically lands; anything further
    // inflates the whole-model span and swamps the real inter-drawing gap.
    const stray = hline(200, 210, 200);
    const entities = [...grid(0, 0, 10), ...grid(60, 0, 10), stray];
    const clusters = clusterModelEntities(entities, OPTIONS);
    expect(clusters).toHaveLength(2);
    const total = clusters.reduce((sum, c) => sum + c.entities.length, 0);
    expect(total).toBe(entities.length);
  });

  it("uses sensible defaults", () => {
    expect(DEFAULT_CLUSTER_OPTIONS.gapFraction).toBeGreaterThan(0);
    expect(DEFAULT_CLUSTER_OPTIONS.maxDepth).toBeGreaterThan(0);
  });
});

function makeCluster(count: number, centreX: number): ModelCluster {
  return {
    entities: Array.from({ length: count }, () => hline(centreX, centreX + 1, 0)),
    bounds: { minX: centreX, minY: 0, maxX: centreX + 1, maxY: 0 },
  };
}

describe("limitClusters", () => {
  it("returns an empty list for a non-positive budget", () => {
    expect(limitClusters([makeCluster(5, 0)], 0)).toEqual([]);
  });

  it("leaves a list within budget untouched", () => {
    const clusters = [makeCluster(5, 0), makeCluster(6, 100)];
    expect(limitClusters(clusters, 5)).toHaveLength(2);
  });

  it("merges the smallest clusters until the budget is met", () => {
    const clusters = [
      makeCluster(50, 0),
      makeCluster(3, 100),
      makeCluster(2, 200),
      makeCluster(1, 300),
    ];
    const limited = limitClusters(clusters, 2);
    expect(limited).toHaveLength(2);
    // Nothing may be discarded, only coarsened.
    const total = limited.reduce((sum, c) => sum + c.entities.length, 0);
    expect(total).toBe(56);
  });

  it("returns one cluster when the budget is 1", () => {
    const clusters = [makeCluster(5, 0), makeCluster(6, 100), makeCluster(7, 200)];
    const limited = limitClusters(clusters, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0].entities.length).toBe(18);
  });
});
