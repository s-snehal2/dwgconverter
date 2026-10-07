import { clamp } from "./geometry";

/** Default effective lineweight (0.25 mm) used for ByLayer/ByBlock/Default. */
const DEFAULT_LINEWEIGHT_MM = 0.25;

/**
 * Millimetres per drawing unit for each `$INSUNITS` value (the `UnitsType`
 * enum from the DWG header). Index is the header value; 0 (Unitless) and
 * out-of-range values fall through to the measurement-unit default.
 */
const MILLIMETERS_PER_UNIT: Record<number, number> = {
  1: 25.4, // Inches
  2: 304.8, // Feet
  3: 1609344, // Miles
  4: 1, // Millimeters
  5: 10, // Centimeters
  6: 1000, // Meters
  7: 1000000, // Kilometers
  8: 0.0000254, // Microinches
  9: 0.0254, // Mils
  10: 914.4, // Yards
  11: 1e-7, // Angstroms
  12: 0.000001, // Nanometers
  13: 0.001, // Microns
  14: 100, // Decimeters
  15: 10000, // Decameters
  16: 100000, // Hectometers
  17: 1e12, // Gigameters
  18: 1.495978707e14, // Astronomical units
  19: 9.4607304725808e18, // Light years
  20: 3.0856775814913673e19, // Parsecs
  21: 304.8006096012192, // US survey feet
  22: 25.4000508001016, // US survey inches
  23: 914.4018288036576, // US survey yards
};

/**
 * Drawing units per millimetre, from the DWG header.
 *
 * `$INSUNITS` is the authoritative unit declaration; when it is Unitless (0)
 * or missing, `$MEASUREMENT` (0 = English → inches, 1 = metric → millimetres)
 * is the best remaining signal, and millimetres is the final fallback. The
 * result converts a physical lineweight in millimetres into drawing units so
 * the renderer can scale it to pixels like any other geometry.
 */
export function unitsPerMmFrom(insUnits?: number | null, measurementUnits?: number | null): number {
  const mmPerUnit = MILLIMETERS_PER_UNIT[insUnits ?? -1];
  if (mmPerUnit !== undefined) {
    return 1 / mmPerUnit;
  }
  // Unitless (0) / unknown: English drawings are inches, metric are millimetres.
  return measurementUnits === 0 ? 1 / 25.4 : 1;
}

/**
 * Convert a raw DWG lineweight (1/100 mm) to a pixel width at the given
 * scale, clamped to keep hairlines visible and corrupt values harmless.
 *
 * `unitsPerMm` comes from the drawing header (see `unitsPerMmFrom`) and
 * `scale` is pixels per drawing unit, so the product is a physical,
 * plot-accurate width: 0.25 mm on a 3000 px A4 sheet lands at ~2.5 px, the
 * same line weight AutoCAD would plot. Raw 0 is a true 0.00 mm hairline and
 * floors at `minStrokePx`; negative references (ByLayer/ByBlock/Default)
 * resolve to the default 0.25 mm.
 */
export function mapLineWeightToPixels(
  lineWeightValue: number,
  unitsPerMm: number,
  scale: number,
  minStrokePx = 1,
  maxStrokePx = 16
): number {
  const millimeters = validLineWeightMillimeters(lineWeightValue);
  const px = millimeters * unitsPerMm * scale;
  if (!Number.isFinite(px) || px <= 0) {
    return minStrokePx;
  }
  return clamp(px, minStrokePx, maxStrokePx);
}

function validLineWeightMillimeters(value: number): number {
  if (value < 0) {
    return DEFAULT_LINEWEIGHT_MM;
  }
  return value / 100;
}
