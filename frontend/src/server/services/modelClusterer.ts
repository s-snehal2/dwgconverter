import type { Bounds } from "../models/bounds";
import { boundsAreValid, boundsHeight, boundsWidth } from "../models/bounds";
import type { Entity } from "../models/entity";
import { entityBounds } from "./boundsCalculator";

/** A group of model-space entities that will be rendered as one PNG. */
export interface ModelCluster {
  entities: Entity[];
  bounds: Bounds;
}

export interface ClusterOptions {
  /**
   * Fraction of the whole model's extent that must be empty before a cut is
   * made. A gap smaller than this is part of the same drawing. Measured against
   * the full model span, not the current cluster's, so descending into a single
   * drawing does not make its internal line spacing look like a separation.
   */
  gapFraction: number;
  /** Recursion ceiling; bounds worst-case cluster count to 2^maxDepth. */
  maxDepth: number;
  /** Clusters with fewer entities than this are merged into a neighbour. */
  minEntities: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  gapFraction: 0.03,
  maxDepth: 12,
  minEntities: 2,
};

interface Boxed {
  entity: Entity;
  bounds: Bounds;
}

/**
 * Split model space into per-drawing clusters.
 *
 * Model space in a multi-layout DWG holds every layout's geometry parked side
 * by side, so fitting all of it to one canvas makes each individual drawing
 * unreadable. This cuts at the widest whitespace gap and recurses until no gap
 * is wide enough to count as a separation. A single coherent drawing has no
 * such gap and stays one cluster; drawings parked apart separate cleanly.
 *
 * Entities are assigned to a side by the centre of their bounds, so an entity
 * straddling the cut lands wholly in one cluster and only widens that crop.
 * Bounds are computed once and partitioned alongside the entities, so the whole
 * pass is O(n log^2 n) rather than the O(n^2) of pairwise proximity testing.
 */
export function clusterModelEntities(
  entities: Entity[],
  options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS
): ModelCluster[] {
  const boxed = entities
    .map((entity): Boxed | null => {
      // Labels are never rendered, so they must not pull the crop or split a
      // drawing: cluster on line work only.
      if (entity.type === "TEXT" || entity.type === "MTEXT") {
        return null;
      }
      const bounds = entityBounds(entity);
      return boundsAreValid(bounds) ? { entity, bounds } : null;
    })
    .filter((entry): entry is Boxed => entry !== null);

  if (boxed.length === 0) {
    return [];
  }

  // The whole-model span is the yardstick for every cut at every depth. Both
  // axes are scored against the same characteristic size: scoring a vertical
  // gap against the model's (possibly tiny) height would make ordinary line
  // spacing in a wide, shallow drawing look like a separation.
  const reference = unionBounds(boxed.map((entry) => entry.bounds));
  const referenceSpan = Math.max(boundsWidth(reference), boundsHeight(reference));
  const clusters = split(
    boxed,
    Math.max(0, options.gapFraction),
    Math.max(0, Math.floor(options.maxDepth)),
    Math.max(referenceSpan, Number.EPSILON)
  );

  return coalesceClusters(clusters, Math.max(1, Math.floor(options.minEntities)));
}

/** Recursive widest-gap split. Returns clusters with the input AABBs intact. */
function split(
  boxed: Boxed[],
  gapFraction: number,
  depthRemaining: number,
  referenceSpan: number
): ModelCluster[] {
  const bounds = unionBounds(boxed.map((entry) => entry.bounds));
  if (boxed.length <= 1 || depthRemaining <= 0) {
    return [{ entities: boxed.map((entry) => entry.entity), bounds }];
  }

  const horizontal = widestGap(boxed, (box) => box.minX, (box) => box.maxX);
  const vertical = widestGap(boxed, (box) => box.minY, (box) => box.maxY);

  // Both axes are measured against the same whole-model span, so the question
  // is always "is this whitespace worth a cut for this drawing?" regardless of
  // which direction the drawings were parked in.
  const horizontalScore = horizontal.gap / referenceSpan;
  const verticalScore = vertical.gap / referenceSpan;

  const useHorizontal = horizontalScore >= verticalScore;
  const gap = useHorizontal ? horizontal.gap : vertical.gap;
  const score = useHorizontal ? horizontalScore : verticalScore;

  if (gap <= 0 || score < gapFraction) {
    return [{ entities: boxed.map((entry) => entry.entity), bounds }];
  }

  const cut = useHorizontal
    ? (horizontal.lo + horizontal.hi) / 2
    : (vertical.lo + vertical.hi) / 2;

  const left: Boxed[] = [];
  const right: Boxed[] = [];
  for (const entry of boxed) {
    const centre = useHorizontal
      ? (entry.bounds.minX + entry.bounds.maxX) / 2
      : (entry.bounds.minY + entry.bounds.maxY) / 2;
    (centre < cut ? left : right).push(entry);
  }

  // A single entity spanning the gap leaves one side empty; keep it whole
  // rather than emitting a cluster that is really the same drawing.
  if (left.length === 0 || right.length === 0) {
    return [{ entities: boxed.map((entry) => entry.entity), bounds }];
  }

  return [
    ...split(left, gapFraction, depthRemaining - 1, referenceSpan),
    ...split(right, gapFraction, depthRemaining - 1, referenceSpan),
  ];
}

/**
 * Widest empty span on one axis. The returned `lo`/`hi` are the gap's edges, so
 * the cut sits at their midpoint.
 */
function widestGap(
  boxed: Boxed[],
  lowOf: (bounds: Bounds) => number,
  highOf: (bounds: Bounds) => number
): { gap: number; lo: number; hi: number } {
  const spans = boxed.map((entry) => ({ lo: lowOf(entry.bounds), hi: highOf(entry.bounds) }));
  spans.sort((a, b) => a.lo - b.lo || a.hi - b.hi);

  let best = { gap: 0, lo: 0, hi: 0 };
  for (let i = 1; i < spans.length; i++) {
    const gap = spans[i].lo - spans[i - 1].hi;
    if (gap > best.gap) {
      best = { gap, lo: spans[i - 1].hi, hi: spans[i].lo };
    }
  }
  return best;
}

/**
 * Fold clusters holding fewer than `minEntities` into their nearest neighbour,
 * so a stray line or lone point cannot become its own mostly-empty PNG. Stops
 * as soon as the smallest remaining cluster is big enough, which leaves a model
 * of well-populated drawings untouched.
 */
export function coalesceClusters(
  clusters: ModelCluster[],
  minEntities: number
): ModelCluster[] {
  if (minEntities <= 1 || clusters.length <= 1) {
    return clusters;
  }
  const working = [...clusters];
  while (working.length > 1) {
    const smallest = indexOfSmallest(working);
    if (working[smallest].entities.length >= minEntities) {
      break;
    }
    const neighbour = nearestClusterIndex(working, smallest);
    if (neighbour === smallest) {
      break;
    }
    mergeAt(working, neighbour, smallest);
  }
  return working;
}

/**
 * Reduce a cluster list to at most `budget` entries by repeatedly folding the
 * smallest cluster into its nearest neighbour. Entities are never discarded, so
 * capping output can only coarsen crops, never lose drawing content.
 */
export function limitClusters(clusters: ModelCluster[], budget: number): ModelCluster[] {
  if (budget <= 0) {
    return [];
  }
  const working = [...clusters];
  while (working.length > budget) {
    const smallest = indexOfSmallest(working);
    const neighbour = nearestClusterIndex(working, smallest);
    if (neighbour === smallest) {
      break;
    }
    mergeAt(working, neighbour, smallest);
  }
  return working;
}

/**
 * Remove the two given clusters and append their union. The pair is read before
 * either index is spliced out, so the merge never touches a stale slot.
 */
function mergeAt(clusters: ModelCluster[], i: number, j: number): void {
  const merged = mergeTwo(clusters[i], clusters[j]);
  clusters.splice(Math.max(i, j), 1);
  clusters.splice(Math.min(i, j), 1);
  clusters.push(merged);
}

function indexOfSmallest(clusters: ModelCluster[]): number {
  let smallest = 0;
  for (let i = 1; i < clusters.length; i++) {
    if (clusters[i].entities.length < clusters[smallest].entities.length) {
      smallest = i;
    }
  }
  return smallest;
}

function nearestClusterIndex(clusters: ModelCluster[], from: number): number {
  let best = from;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < clusters.length; i++) {
    if (i === from) {
      continue;
    }
    const distance = centreDistance(clusters[i].bounds, clusters[from].bounds);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

function centreDistance(a: Bounds, b: Bounds): number {
  const dx = (a.minX + a.maxX) / 2 - (b.minX + b.maxX) / 2;
  const dy = (a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2;
  return Math.hypot(dx, dy);
}

function mergeTwo(a: ModelCluster, b: ModelCluster): ModelCluster {
  return {
    entities: [...a.entities, ...b.entities],
    bounds: unionBounds([a.bounds, b.bounds]),
  };
}

function unionBounds(boxes: Bounds[]): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  return { minX, minY, maxX, maxY };
}
