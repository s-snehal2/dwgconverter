import type { Bounds } from "../models/bounds";
import type { Entity, CadPoint } from "../models/entity";
import {
  arcBounds,
  arcFromBulge,
  arcSpan,
  expandBounds,
  normalizeAngle,
  sweepContains,
} from "../utils/geometry";
import { textEntityBounds } from "./textMetrics";

/**
 * Axis-aligned bounds of a single normalized entity. Every bounds
 * consideration is computed from the normalized model — never from the raw DWG.
 */
export function entityBounds(entity: Entity): Bounds {
  switch (entity.type) {
    case "LINE": {
      const a = entity.start;
      const b = entity.end;
      return rect(
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.max(a.x, b.x),
        Math.max(a.y, b.y)
      );
    }
    case "CIRCLE":
      return arcBox(entity.center, entity.radius, 0, Math.PI * 2);
    case "ARC":
      return arcBox(entity.center, entity.radius, entity.startAngle, entity.endAngle);
    case "POINT": {
      const p = entity.position;
      return rect(p.x, p.y, p.x, p.y);
    }
    case "ELLIPSE":
      return ellipseBox(entity);
    case "POLYLINE": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const vertex of entity.vertices) {
        minX = Math.min(minX, vertex.x);
        minY = Math.min(minY, vertex.y);
        maxX = Math.max(maxX, vertex.x);
        maxY = Math.max(maxY, vertex.y);
      }
      let result = rect(minX, minY, maxX, maxY);
      // Bulge segments bulge beyond their vertices.
      const vertices = entity.vertices;
      for (let i = 0; i < vertices.length; i++) {
        const j = (i + 1) % vertices.length;
        if (i === vertices.length - 1 && !entity.closed) {
          break;
        }
        const bulge = entity.bulges[i] ?? 0;
        if (Math.abs(bulge) < 1e-6) {
          continue;
        }
        const arc = arcFromBulge(vertices[i], vertices[j], bulge);
        if (arc) {
          // Bulge>0 arcs travel CCW; bulge<0 arcs travel CW (equivalent to a
          // CCW arc from p2 back to p1).
          const ccw = bulge > 0;
          const box = arcBox(
            arc.center,
            arc.radius,
            ccw ? arc.startAngle : arc.endAngle,
            ccw ? arc.endAngle : arc.startAngle
          );
          result = expandBounds(box.minX, box.minY, box.maxX, box.maxY, result);
        }
      }
      return result;
    }
    case "TEXT":
    case "MTEXT":
      // Shared with the renderer's viewport culler so page fit and entity
      // culling can never disagree about how much room a label occupies.
      return textEntityBounds(entity);
    case "SOLID": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const vertex of entity.vertices) {
        minX = Math.min(minX, vertex.x);
        minY = Math.min(minY, vertex.y);
        maxX = Math.max(maxX, vertex.x);
        maxY = Math.max(maxY, vertex.y);
      }
      return rect(minX, minY, maxX, maxY);
    }
    case "IMAGE": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const vertex of entity.vertices) {
        minX = Math.min(minX, vertex.x);
        minY = Math.min(minY, vertex.y);
        maxX = Math.max(maxX, vertex.x);
        maxY = Math.max(maxY, vertex.y);
      }
      return rect(minX, minY, maxX, maxY);
    }
    default:
      return rect(0, 0, 0, 0);
  }
}

function arcBox(center: CadPoint, radius: number, startAngle: number, endAngle: number): Bounds {
  const span = arcSpan(startAngle, endAngle);
  const box = arcBounds({ x: center.x, y: center.y }, radius, startAngle, startAngle + span);
  return rect(box.minX, box.minY, box.maxX, box.maxY);
}

/**
 * Axis-aligned bounds of an ellipse, computed from the same parametric model
 * the renderer uses: point(t) = center + major·cos(t) + minor·sin(t) where
 * `majorAxisEndPoint` is the major-axis vector from the center and the minor
 * axis is the perpendicular vector scaled by `radiusRatio`.
 */
function ellipseBox(entity: Extract<Entity, { type: "ELLIPSE" }>): Bounds {
  const { center, majorAxisEndPoint, radiusRatio, startAngle, endAngle, full } = entity;
  const c = center;
  const majX = majorAxisEndPoint.x;
  const majY = majorAxisEndPoint.y;
  const majorLen = Math.hypot(majX, majY);
  if (majorLen < 1e-9) {
    return rect(c.x, c.y, c.x, c.y);
  }
  const minorLen = majorLen * radiusRatio;
  const minX = (-majY / majorLen) * minorLen;
  const minY = (majX / majorLen) * minorLen;

  const span =
    full || Math.abs(arcSpan(startAngle, endAngle) - Math.PI * 2) < 1e-6
      ? Math.PI * 2
      : arcSpan(startAngle, endAngle);
  if (span >= Math.PI * 2 - 1e-6) {
    // Exact axis-aligned box of a (possibly rotated) full ellipse.
    const halfW = Math.hypot(majX, minX);
    const halfH = Math.hypot(majY, minY);
    return rect(c.x - halfW, c.y - halfH, c.x + halfW, c.y + halfH);
  }

  // Partial ellipse: the box is attained at the sweep endpoints or at the
  // tangent parameters where dx/dt = 0 (tan(t) = minX/majX) and dy/dt = 0
  // (tan(t) = minY/majY).
  let bounds: Bounds | null = null;
  const start = startAngle;
  const extremeTs = [
    start,
    start + span,
    Math.atan2(minX, majX),
    Math.atan2(minX, majX) + Math.PI,
    Math.atan2(minY, majY),
    Math.atan2(minY, majY) + Math.PI,
  ];
  for (const t of extremeTs) {
    const n = normalizeAngle(t);
    if (!sweepContains(span, start, n)) {
      continue;
    }
    const x = c.x + majX * Math.cos(n) + minX * Math.sin(n);
    const y = c.y + majY * Math.cos(n) + minY * Math.sin(n);
    bounds = bounds === null ? rect(x, y, x, y) : expandBounds(x, y, x, y, bounds);
  }
  return bounds ?? rect(c.x, c.y, c.x, c.y);
}

function rect(minX: number, minY: number, maxX: number, maxY: number): Bounds {
  return { minX, minY, maxX, maxY };
}

/** Union of all entity bounds; null when there are no entities. */
export function drawingBounds(entities: Entity[]): Bounds | null {
  if (entities.length === 0) {
    return null;
  }
  let bounds: Bounds | null = null;
  for (const entity of entities) {
    // Text is parsed but never rendered, so its glyph extents must not pad the
    // fit: the frame hugs the line work alone. Per-entity `entityBounds` still
    // measures labels for viewport culling and AI-note scoping.
    if (entity.type === "TEXT" || entity.type === "MTEXT") {
      continue;
    }
    const box = entityBounds(entity);
    if (bounds === null) {
      bounds = box;
    } else {
      bounds = {
        minX: Math.min(bounds.minX, box.minX),
        minY: Math.min(bounds.minY, box.minY),
        maxX: Math.max(bounds.maxX, box.maxX),
        maxY: Math.max(bounds.maxY, box.maxY),
      };
    }
  }
  if (
    bounds &&
    (!Number.isFinite(bounds.maxX - bounds.minX) ||
      !Number.isFinite(bounds.maxY - bounds.minY) ||
      bounds.maxX < bounds.minX ||
      bounds.maxY < bounds.minY)
  ) {
    return null;
  }
  return bounds;
}