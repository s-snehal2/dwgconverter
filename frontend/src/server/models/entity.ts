export interface CadPoint {
  x: number;
  y: number;
  z?: number;
}

export interface TextAlignment {
  horizontal: "left" | "center" | "right";
  vertical: "baseline" | "middle" | "top" | "bottom";
}

interface EntityBase {
  /** Resolved CSS color, e.g. "#000000". ByLayer/ByBlock already resolved. */
  color: string;
  /** Name of the DWG layer this entity belongs to. */
  layer: string;
  /** Raw DWG lineweight value in 1/100 mm (see LineWeightType). */
  lineWeight: number;
  lineType?: string;
  /** Original DWG entity class name (for reporting). */
  sourceType: string;
}

export interface LineEntity extends EntityBase {
  type: "LINE";
  start: CadPoint;
  end: CadPoint;
}

export interface CircleEntity extends EntityBase {
  type: "CIRCLE";
  center: CadPoint;
  radius: number;
}

export interface ArcEntity extends EntityBase {
  type: "ARC";
  center: CadPoint;
  radius: number;
  /** Radians, CCW from +X in model plane. */
  startAngle: number;
  endAngle: number;
}

export interface PointEntity extends EntityBase {
  type: "POINT";
  position: CadPoint;
}

export interface EllipseEntity extends EntityBase {
  type: "ELLIPSE";
  center: CadPoint;
  /** Endpoint of the major axis relative to the model plane (vector from center). */
  majorAxisEndPoint: CadPoint;
  /** Minor/major radius ratio (0..1). */
  radiusRatio: number;
  /** Parametric start/end angles (radians) along the major axis direction. */
  startAngle: number;
  endAngle: number;
  full: boolean;
}

export interface PolylineEntity extends EntityBase {
  type: "POLYLINE";
  vertices: CadPoint[];
  closed: boolean;
  /** Bulge of the segment from vertices[i] to vertices[(i+1) % length]. */
  bulges: number[];
}

export interface TextEntity extends EntityBase {
  type: "TEXT";
  position: CadPoint;
  rotation: number;
  height: number;
  text: string;
  alignment: TextAlignment;
}

export interface MTextEntity extends EntityBase {
  type: "MTEXT";
  position: CadPoint;
  rotation: number;
  height: number;
  text: string;
  width: number;
  alignment: TextAlignment;
}

/**
 * A filled or outlined polygon: maps DWG SOLID / 3DFACE entities and solid
 * hatch fills. `filled` shapes get a solid fill; otherwise only the outline
 * is stroked.
 */
export interface SolidEntity extends EntityBase {
  type: "SOLID";
  /** 3 or 4 corner points (in model space). */
  vertices: CadPoint[];
  filled: boolean;
}

/**
 * A raster IMAGE entity. The DWG only stores a reference to an external image
 * file (no pixel data is available to the parser), so the image is normalized
 * to its placement quadrilateral and rendered as a placeholder frame.
 */
export interface ImageEntity extends EntityBase {
  type: "IMAGE";
  /** The image quadrilateral corners (insert, insert+u, insert+u+v, insert+v). */
  vertices: CadPoint[];
}

export type Entity =
  | LineEntity
  | CircleEntity
  | ArcEntity
  | PointEntity
  | EllipseEntity
  | PolylineEntity
  | TextEntity
  | MTextEntity
  | SolidEntity
  | ImageEntity;

export const SUPPORTED_ENTITY_TYPES: ReadonlySet<Entity["type"]> = new Set([
  "LINE",
  "CIRCLE",
  "ARC",
  "POINT",
  "ELLIPSE",
  "POLYLINE",
  "SOLID",
  "TEXT",
  "MTEXT",
  "IMAGE",
]);

export function isSupportedEntity(entity: Entity): boolean {
  return SUPPORTED_ENTITY_TYPES.has(entity.type);
}