import type { Drawing } from "../models/drawing";
import { collectDrawingNotes } from "./drawingNotes";
import { DEFAULT_MIN_TEXT_CAP_PX, TEXT_CAP_HEIGHT_RATIO } from "./textMetrics";

/**
 * Text-coverage auditor.
 *
 * Answers the one question that eyeballing a sheet cannot: did every string the
 * sheet is supposed to show actually make it into the rendered artifact, and
 * did it survive at a legible size?
 *
 * Two independent failure modes are separated deliberately:
 *
 *  - a string that is absent from the SVG was dropped by the pipeline (layer
 *    off/frozen, outside the viewport window, decimation);
 *  - a string that is present but rendered under the legibility floor is
 *    effectively invisible, which looks identical to a drop in the raster.
 *
 * Comparing the SVG (what the renderer emitted) rather than only the PNG is what
 * makes the difference between those two diagnosable.
 */

/** Collapse whitespace the same way `drawingNotes` does, so both sides agree. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function unescapeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#[xX]([\da-fA-F]+));/g, (match, dec, hex) => {
    if (dec) {
      return String.fromCodePoint(Number.parseInt(dec, 10));
    }
    if (hex) {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return XML_ENTITIES[match] ?? match;
  });
}

/** Every visible string the emitted SVG contains, whitespace-normalized. */
export function svgTextStrings(svg: string): Set<string> {
  const found = new Set<string>();
  // A label is either a bare <text> body or one <tspan> per wrapped line.
  const pattern = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  for (const match of svg.matchAll(pattern)) {
    const inner = match[1];
    const lines = inner.includes("<tspan")
      ? [...inner.matchAll(/<tspan\b[^>]*>([\s\S]*?)<\/tspan>/g)].map((m) => m[1])
      : [inner];
    const decoded: string[] = [];
    for (const line of lines) {
      // Strip any remaining markup and decode entities.
      const text = normalize(unescapeXml(line.replace(/<[^>]*>/g, "")));
      if (text.length > 0) {
        found.add(text);
        decoded.push(text);
      }
    }
    // Also index the block as a whole. An MTEXT block is wrapped to its
    // rectangle width, so the same label can reach the raster as one tspan
    // ("ISLAND KITCHEN") from one entity and as two wrapped lines from another.
    // Coverage is about the words surviving, not about which entity won the
    // wrap, so the joined form has to count as evidence too.
    if (decoded.length > 1) {
      const joined = normalize(decoded.join(" "));
      if (joined.length > 0) {
        found.add(joined);
      }
    }
  }
  return found;
}

/** Whether `haystack` contains `needle` as a run of whole words. */
function containsWordRun(haystack: string, needle: string): boolean {
  const words = needle.split(" ").filter((word) => word.length > 0);
  if (words.length === 0) {
    return false;
  }
  const hay = ` ${haystack.toLowerCase().split(/\s+/).join(" ")} `;
  return hay.includes(` ${words.join(" ").toLowerCase()} `);
}

/** Font sizes used by the emitted labels, so a floor regression is visible. */
export function svgFontSizes(svg: string): number[] {
  const sizes: number[] = [];
  for (const match of svg.matchAll(/<text\b[^>]*\bfont-size="([\d.]+)"/g)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > 0) {
      sizes.push(value);
    }
  }
  return sizes;
}

/**
 * Count labels whose geometry or size is not a number.
 *
 * A renderer fed a non-finite margin or scale emits `x="NaN" font-size="NaN"`
 * for every label. Rasterizers skip such elements silently, so the sheet comes
 * out blank of text while still containing all the right strings — string
 * matching alone scores that as perfect coverage. This is the check that catches
 * it, so it must never be folded into the "below floor" count.
 */
export function svgInvalidLabelCount(svg: string): number {
  let invalid = 0;
  for (const match of svg.matchAll(/<text\b[^>]*>/g)) {
    if (/\b(?:x|y|font-size)="(?:NaN|Infinity|-Infinity)"/.test(match[0])) {
      invalid += 1;
    }
  }
  return invalid;
}

export interface SheetTextCoverage {
  /** Sheet name, or "Model" for the model-space view. */
  sheet: string;
  isModel: boolean;
  /** Distinct strings the sheet is expected to show. */
  expected: number;
  /** Of those, how many reached the SVG. */
  present: number;
  /** present / expected, 0..1. */
  coverage: number;
  /** Expected strings that never reached the SVG. */
  missing: string[];
  /** Smallest cap height, in output pixels, across the emitted labels. */
  minCapHeightPx: number;
  /** Emitted labels below the legibility floor; must be 0. */
  belowFloor: number;
  /** Labels whose emitted geometry or size is not a number; must be 0. */
  invalid: number;
  /** True only when every expected string is present, valid and above the floor. */
  ok: boolean;
}

/**
 * Audit one rendered sheet.
 *
 * `expected` comes from the same scoped, deduplicated collection that builds the
 * AI brief, so the auditor and the product agree on what a sheet should show.
 */
export function auditSheetTextCoverage(
  drawing: Drawing,
  svg: string,
  options: { sheetName?: string; isModel?: boolean; minCapHeightPx?: number } = {},
): SheetTextCoverage {
  const minCapHeightPx = options.minCapHeightPx ?? DEFAULT_MIN_TEXT_CAP_PX;
  const notes = collectDrawingNotes(drawing, Number.MAX_SAFE_INTEGER);
  const emitted = svgTextStrings(svg);

  const expected = notes.map((note) => normalize(note.text));
  const expectedSet = new Set(expected);
  const emittedList = [...emitted];
  const missing: string[] = [];
  for (const text of expectedSet) {
    if (emitted.has(text)) {
      continue;
    }
    // Fall back to a whole-word run anywhere in the emitted set, which covers a
    // note whose block was wrapped differently by the entity it came from.
    if (emittedList.some((candidate) => containsWordRun(candidate, text))) {
      continue;
    }
    missing.push(text);
  }
  const present = expectedSet.size - missing.length;

  const fontSizes = svgFontSizes(svg);
  // font-size is an em size; cap height is the smaller ratio the renderer uses.
  const floorFontSize = minCapHeightPx / TEXT_CAP_HEIGHT_RATIO;
  const belowFloor = fontSizes.filter((size) => size < floorFontSize - 0.01).length;
  const invalid = svgInvalidLabelCount(svg);

  return {
    sheet: options.sheetName ?? "Model",
    isModel: options.isModel ?? false,
    expected: expectedSet.size,
    present,
    coverage: expectedSet.size === 0 ? 1 : present / expectedSet.size,
    missing,
    minCapHeightPx: fontSizes.length === 0 ? 0 : Math.min(...fontSizes) * TEXT_CAP_HEIGHT_RATIO,
    belowFloor,
    invalid,
    ok: missing.length === 0 && belowFloor === 0 && invalid === 0,
  };
}