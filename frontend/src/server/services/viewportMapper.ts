import type { PageViewport } from "../models/page";
import type { CadPoint, Entity } from "../models/entity";

/**
 * Maps model-space geometry into a paper-space viewport. A paper-space
 * viewport is a scale + rotation + translation of the model plane:
 *
 *   page = center + R(twist) * (model - viewCenter) * (height / viewHeight)
 *
 * All shapes are re-expressed in page coordinates so they can be rendered with
 * the exact same pipeline as the paper-space entities (they share the page
 * bounds/scale when converted to pixels).
 */

function viewportScale(vp: PageViewport): number {
  return vp.viewHeight === 0 || !Number.isFinite(vp.viewHeight) ? 1 : vp.height / vp.viewHeight;
}

/** Map one model point into page coordinates through a viewport window. */
export function modelToPagePoint(vp: PageViewport, x: number, y: number): CadPoint {
  const scale = viewportScale(vp);
  const dx = x - vp.viewCenterX;
  const dy = y - vp.viewCenterY;
  if (vp.twist !== 0) {
    const cos = Math.cos(vp.twist);
    const sin = Math.sin(vp.twist);
    return {
      x: vp.centerX + (dx * cos - dy * sin) * scale,
      y: vp.centerY + (dx * sin + dy * cos) * scale,
    };
  }
  return { x: vp.centerX + dx * scale, y: vp.centerY + dy * scale };
}

/** Map a direction vector (e.g. an ellipse major axis) into page coordinates. */
export function modelVectorToPage(vp: PageViewport, vx: number, vy: number): CadPoint {
  const scale = viewportScale(vp);
  if (vp.twist !== 0) {
    const cos = Math.cos(vp.twist);
    const sin = Math.sin(vp.twist);
    return { x: (vx * cos - vy * sin) * scale, y: (vx * sin + vy * cos) * scale };
  }
  return { x: vx * scale, y: vy * scale };
}

/**
 * Project a normalized model entity into a page viewport's coordinate space.
 * Curved shapes (arcs, ellipse) are sampled downstream from their (rotated)
 * start/end angles, so only their points/angles need adjusting here.
 */
export function projectEntityToPage(entity: Entity, vp: PageViewport): Entity {
  const scale = viewportScale(vp);
  switch (entity.type) {
    case "LINE": {
      return { ...entity, start: modelToPagePoint(vp, entity.start.x, entity.start.y), end: modelToPagePoint(vp, entity.end.x, entity.end.y) };
    }
    case "CIRCLE": {
      return { ...entity, center: modelToPagePoint(vp, entity.center.x, entity.center.y), radius: entity.radius * scale };
    }
    case "ARC": {
      return {
        ...entity,
        center: modelToPagePoint(vp, entity.center.x, entity.center.y),
        radius: entity.radius * scale,
        startAngle: entity.startAngle + vp.twist,
        endAngle: entity.endAngle + vp.twist,
      };
    }
    case "ELLIPSE": {
      return {
        ...entity,
        center: modelToPagePoint(vp, entity.center.x, entity.center.y),
        majorAxisEndPoint: modelVectorToPage(vp, entity.majorAxisEndPoint.x, entity.majorAxisEndPoint.y),
        startAngle: entity.startAngle + vp.twist,
        endAngle: entity.endAngle + vp.twist,
      };
    }
    case "POINT": {
      return { ...entity, position: modelToPagePoint(vp, entity.position.x, entity.position.y) };
    }
    case "POLYLINE": {
      return { ...entity, vertices: entity.vertices.map((v) => modelToPagePoint(vp, v.x, v.y)) };
    }
    case "SOLID": {
      return { ...entity, vertices: entity.vertices.map((v) => modelToPagePoint(vp, v.x, v.y)) };
    }
    case "IMAGE": {
      return { ...entity, vertices: entity.vertices.map((v) => modelToPagePoint(vp, v.x, v.y)) };
    }
    case "TEXT":
    case "MTEXT": {
      return {
        ...entity,
        position: modelToPagePoint(vp, entity.position.x, entity.position.y),
        height: entity.height * scale,
        rotation: entity.rotation + vp.twist,
      };
    }
  }
}