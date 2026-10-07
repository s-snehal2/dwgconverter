import type { Bounds } from "../models/bounds";
import type { CadPoint } from "../models/entity";

export const TAU = Math.PI * 2;

/** Normalize an angle into [0, 2π). */
export function normalizeAngle(angle: number): number {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface BulgeArc {
  center: CadPoint;
  radius: number;
  startAngle: number;
  endAngle: number;
  /** True if the arc is CCW (bulge > 0). */
  clockwise: boolean;
}

/**
 * Convert a polyline bulge segment into an exact arc.
 * bulge = tan(includedAngle / 4). Positive bulge = counter-clockwise arc.
 * Returns null when the two points coincide (no arc possible).
 */
export function arcFromBulge(p1: CadPoint, p2: CadPoint, bulge: number): BulgeArc | null {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const chord = Math.hypot(dx, dy);
  if (!Number.isFinite(chord) || chord < 1e-9) {
    return null;
  }
  if (Math.abs(bulge) < 1e-6) {
    return null;
  }
  const half = chord / 2;
  const sagitta = Math.abs(bulge) * half;
  const radius = (half * half + sagitta * sagitta) / (2 * sagitta);

  // Unit perpendicular to p1 -> p2 (rotated -90°: "left").
  const perpX = -dy / chord;
  const perpY = dx / chord;

  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const sign = bulge > 0 ? 1 : -1;
  const centerOffset = (radius - sagitta) * sign;

  const center: CadPoint = {
    x: midX + perpX * centerOffset,
    y: midY + perpY * centerOffset,
  };

  const startAngle = Math.atan2(p1.y - center.y, p1.x - center.x);
  const endAngle = Math.atan2(p2.y - center.y, p2.x - center.x);

  return {
    center,
    radius,
    startAngle,
    endAngle,
    clockwise: bulge < 0,
  };
}

/** Angular span of an entity arc, normalized CCW into (0, 2π]. */
export function arcSpan(startAngle: number, endAngle: number): number {
  const span = normalizeAngle(endAngle - startAngle);
  return span <= 0 ? TAU : span;
}

export interface Point2 {
  x: number;
  y: number;
}

/**
 * Extremes (axis-aligned) of the circular arc centered at `center` with the
 * given radius and angular span. `startAngle`/`endAngle` define a CCW sweep.
 */
export function arcBounds(
  center: Point2,
  radius: number,
  startAngle: number,
  endAngle: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  const span = arcSpan(startAngle, endAngle);
  const start = normalizeAngle(startAngle);

  const points: Point2[] = [
    { x: center.x + radius * Math.cos(start), y: center.y + radius * Math.sin(start) },
    {
      x: center.x + radius * Math.cos(start + span),
      y: center.y + radius * Math.sin(start + span),
    },
  ];

  // Include axis-aligned extremes when the sweep crosses 0/π/π/2/3π/2.
  const candidates = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  for (const angle of candidates) {
    if (sweepContains(span, start, angle)) {
      points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
    }
  }

  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function sweepContains(span: number, start: number, angle: number): boolean {
  const rel = normalizeAngle(angle - start);
  return rel <= span + 1e-9;
}

/** Expand a bounds rectangle. */
export function expandBounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  bounds: Bounds
): Bounds {
  return {
    minX: Math.min(minX, bounds.minX),
    minY: Math.min(minY, bounds.minY),
    maxX: Math.max(maxX, bounds.maxX),
    maxY: Math.max(maxY, bounds.maxY),
  };
}