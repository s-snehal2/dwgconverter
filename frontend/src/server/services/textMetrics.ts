import type { Bounds } from "../models/bounds";
import type { MTextEntity, TextEntity } from "../models/entity";

/**
 * CAD text height is the cap height (height of a capital letter), while an SVG
 * `font-size` is the em height. Rendering one as the other makes every label
 * ~40% too large, so the renderer divides the CAD height by this ratio.
 */
export const TEXT_CAP_HEIGHT_RATIO = 0.7;

/**
 * Smallest cap height, in output pixels, that still renders as readable ink.
 *
 * This is a deliberate deviation from true DWG scale, and the reason is
 * arithmetic rather than taste. Annotation on a large drawing is millimetres
 * tall: measured on a real architectural DWG whose model crop spans ~63,000
 * units, the median label is 3 units tall, which is 0.15px on a 3000px sheet and
 * still only 0.29px at 6000px. A label drawn at its true size is therefore
 * sub-pixel — present in the SVG, invisible in the PNG — and no practical output
 * width fixes that (an 84,000px canvas would be needed to render 4px honestly).
 *
 * So the floor trades exact relative sizing for legibility. Measured on that
 * drawing, with model crops rendered at 6000px (`MODEL_PNG_DIMENSION`) and the
 * layout sheets at 3000px:
 *
 * - 26 of 27 paper-space layouts: **1.00x** — the floor never binds, they are
 *   already at true scale and nothing is added;
 * - the whole-model crop: ~13x median, because every label there is sub-pixel.
 *
 * Lowering it makes the model crop closer to true scale but fainter; raising it
 * makes the crop more distorted. Deployments override it with `MIN_TEXT_CAP_PX`;
 * raise `MODEL_PNG_DIMENSION` alongside it if the drawing is very large, since a
 * bigger canvas shrinks how much inflation the floor has to apply.
 */
export const DEFAULT_MIN_TEXT_CAP_PX = 4;

/**
 * Largest cap height, in output pixels, any label is drawn at.
 *
 * `STRICT_TEXT_SCALE` removes the floor above, which leaves text sized purely as
 * `entity.height × viewport.scale` — and `viewport.scale` is unbounded above
 * (a small sheet produces a large scale). With no ceiling either, one bad height
 * took over the whole render: dimension values expanded from a `*D` block could
 * resolve to `DEFAULT_TEXT_HEIGHT` (1 unit), which on a 36-unit sheet at 3000px
 * is ~80px of cap height, ~115px of type, where a real annotation is 8px.
 *
 * 48px of cap height (~69px font) sits far above any label that is genuinely part
 * of a drawing — title blocks and section marks are the largest — while still
 * capping a runaway at a size that leaves the rest of the sheet readable. This
 * is a safety net, not a target: correct labels sit below it and are untouched.
 */
export const DEFAULT_MAX_TEXT_CAP_PX = 48;

/** Line pitch for wrapped MTEXT, as a multiple of the font size. */
export const MTEXT_LINE_PITCH = 1.5;

/** Same pitch expressed in cap heights, i.e. in DWG units. */
export const MTEXT_LINE_PITCH_CAP = MTEXT_LINE_PITCH / TEXT_CAP_HEIGHT_RATIO;

/**
 * Effective paragraph line-spacing factor of a text entity (`MTEXT.lineSpacing`).
 *
 * The DWG stores the spacing as a factor of the line height — 1.0 is the
 * compact single-spacing of `MTEXT_LINE_PITCH`, 1.5 spreads lines 50% wider,
 * and drawings use the field for anything from tight schedules to airy title
 * text. Ignoring it stacked every multi-line label on the same rows no matter
 * what the drawing asked for, so both the renderer's `dy` and the bounds
 * multiply the pitch by this factor. TEXT has no such field and returns 1.
 */
export function mtextLineSpacing(entity: TextEntity | MTextEntity): number {
  if (entity.type !== "MTEXT") {
    return 1;
  }
  const spacing = (entity as { lineSpacing?: number }).lineSpacing;
  return typeof spacing === "number" && Number.isFinite(spacing) && spacing > 0 ? spacing : 1;
}

/** Height used when a DWG stores 0 (AutoCAD then falls back to the style). */
export const DEFAULT_TEXT_HEIGHT = 1;

/**
 * Glyph advance widths as a fraction of the cap height, for a generic sans
 *-serif CAD text face.
 *
 * These are deliberately the *cap-height* ratios of the advances that the
 * renderer actually asks the rasteriser for: an advance of `a` em on a face
 * whose em is `cap / TEXT_CAP_HEIGHT_RATIO` occupies `a / TEXT_CAP_HEIGHT_RATIO`
 * cap heights. Underestimating here is what makes text get culled by the
 * viewport window or clipped at the canvas edge, so the values are padded
 * slightly above the true face metrics.
 */
const ADVANCE_NARROW = 0.34;
const ADVANCE_WIDE = 1.16;
const ADVANCE_UPPER = 0.98;
const ADVANCE_LOWER = 0.79;
const ADVANCE_DIGIT = 0.98;
const ADVANCE_SPACE = 0.42;

const NARROW_CHARS = new Set([..."ijlI.,;:'`|!()[]{}/\\-\u00b7"]);
const WIDE_CHARS = new Set([..."mwMW@%"]);

/** Advance width of one character, as a multiple of the cap height. */
export function glyphAdvanceCap(ch: string): number {
  if (NARROW_CHARS.has(ch)) {
    return ADVANCE_NARROW;
  }
  if (WIDE_CHARS.has(ch)) {
    return ADVANCE_WIDE;
  }
  // Non-breaking space is how the renderer draws an interior blank line —
  // it must measure like the space it stands in for.
  if (ch === " " || ch === "\u00a0") {
    return ADVANCE_SPACE;
  }
  if (ch >= "0" && ch <= "9") {
    return ADVANCE_DIGIT;
  }
  if (ch >= "A" && ch <= "Z") {
    return ADVANCE_UPPER;
  }
  return ADVANCE_LOWER;
}

/** Advance width of a whole string, in DWG units. */
export function textAdvanceWidth(text: string, height: number, widthFactor = 1): number {
  if (text.length === 0) {
    return 0;
  }
  let advances = 0;
  for (const ch of text) {
    advances += glyphAdvanceCap(ch);
  }
  const factor = widthFactor > 0 ? widthFactor : 1;
  return advances * height * factor;
}

/** Effective cap height of a text entity, guarding against a stored 0. */
export function textHeight(entity: TextEntity | MTextEntity): number {
  return entity.height > 0 && Number.isFinite(entity.height) ? entity.height : DEFAULT_TEXT_HEIGHT;
}

/** Width factor of a text entity, guarding against a stored 0. */
export function textWidthFactor(entity: TextEntity | MTextEntity): number {
  // Only DWG TEXT carries a horizontal character scale; MTEXT is controlled by
  // its rectangle width instead, so the field is simply absent there.
  const factor = (entity as { widthFactor?: number }).widthFactor;
  return typeof factor === "number" && factor > 0 && Number.isFinite(factor) ? factor : 1;
}

/**
 * The lines a text entity is drawn as, exactly as `renderText` splits them.
 *
 * MTEXT keeps its paragraph structure: only *trailing* blank lines are
 * dropped, while a leading or interior blank line is a real line break the
 * drawing asked for and occupies its own row (the renderer inks it as a
 * non-breaking space so the stack advances). Trimming every blank line, as
 * this did before, pulled the lines below an indented paragraph up and moved
 * labels the drawing deliberately spaced out. Leading whitespace is preserved
 * for the same reason — the `<text>` element carries `xml:space="preserve"`
 * so SVG does not collapse it away. Single-line TEXT is flattened to one row
 * and dropped entirely when it carries no ink.
 */
export function textLines(entity: TextEntity | MTextEntity): string[] {
  if (entity.type !== "MTEXT") {
    return [(entity.text ?? "").replace(/\r|\n/g, " ").trimEnd()].filter((line) => line.length > 0);
  }
  const lines = (entity.text ?? "").split(/\r\n|\r|\n/).map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines;
}

/** Greedy word wrap of one line to `maxWidth`, honouring CAD word wrapping. */
function wrapLine(line: string, maxWidth: number, height: number, widthFactor: number): string[] {
  if (maxWidth <= 0 || textAdvanceWidth(line, height, widthFactor) <= maxWidth) {
    return [line];
  }
  const words = line.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [line];
  }
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (textAdvanceWidth(candidate, height, widthFactor) <= maxWidth || current.length === 0) {
      current = candidate;
      continue;
    }
    out.push(current);
    current = word;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

export interface TextBlockSize {
  /** Drawn lines, after MTEXT wrapping. */
  lines: string[];
  /** Width of the widest drawn line, in DWG units. */
  width: number;
  /** Cap height of the first line plus the wrapped line pitch. */
  totalHeight: number;
  /** True when the text was wrapped to the MTEXT rectangle width. */
  wrapped: boolean;
}

/**
 * The drawn size of a text entity: the lines that will be emitted, the widest of
 * them, and the stacked height. MTEXT with a fixed rectangle width is wrapped
 * here so the renderer, the bounds and the culler all agree on how many lines
 * there are.
 */
export function textBlockSize(entity: TextEntity | MTextEntity): TextBlockSize {
  const height = textHeight(entity);
  const widthFactor = textWidthFactor(entity);
  const natural = textLines(entity);
  const lineCap = height * MTEXT_LINE_PITCH_CAP * mtextLineSpacing(entity);

  const fixedWidth = entity.type === "MTEXT" && entity.width > 0 ? entity.width : 0;
  if (fixedWidth > 0) {
    const wrapped: string[] = [];
    let wrappedAny = false;
    for (const line of natural) {
      const pieces = wrapLine(line, fixedWidth, height, widthFactor);
      wrappedAny = wrappedAny || pieces.length > 1;
      wrapped.push(...pieces);
    }
    if (wrapped.length > 0 && wrappedAny) {
      return {
        lines: wrapped,
        width: fixedWidth,
        totalHeight: height + (wrapped.length - 1) * lineCap,
        wrapped: true,
      };
    }
  }

  let width = 0;
  for (const line of natural) {
    width = Math.max(width, textAdvanceWidth(line, height, widthFactor));
  }
  return {
    lines: natural,
    width,
    totalHeight: height + Math.max(0, natural.length - 1) * lineCap,
    wrapped: false,
  };
}

/**
 * Axis-aligned bounds of a drawn text entity, in the coordinate space the
 * entity lives in (model space, or page space once a viewport has projected
 * it). The box is built from the real glyph extents — not the anchor point —
 * and then rotated about the anchor, so a rotated or centre/right-aligned
 * label is never smaller than the ink it actually puts on the sheet.
 */
export function textEntityBounds(entity: TextEntity | MTextEntity): Bounds {
  const { width, totalHeight } = textBlockSize(entity);
  const { horizontal, vertical } = entity.alignment;

  let x0 = 0;
  let x1 = width;
  if (horizontal === "center") {
    x0 = -width / 2;
    x1 = width / 2;
  } else if (horizontal === "right") {
    x0 = -width;
    x1 = 0;
  }

  let y0 = 0;
  let y1 = totalHeight;
  if (vertical === "top") {
    y0 = -totalHeight;
    y1 = 0;
  } else if (vertical === "middle") {
    y0 = -totalHeight / 2;
    y1 = totalHeight / 2;
  }

  const rotation = entity.rotation;
  if (!Number.isFinite(rotation) || rotation === 0 || (width === 0 && totalHeight === 0)) {
    return {
      minX: entity.position.x + x0,
      minY: entity.position.y + y0,
      maxX: entity.position.x + x1,
      maxY: entity.position.y + y1,
    };
  }

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ] as const) {
    const rx = cx * cos - cy * sin;
    const ry = cx * sin + cy * cos;
    minX = Math.min(minX, entity.position.x + rx);
    maxX = Math.max(maxX, entity.position.x + rx);
    minY = Math.min(minY, entity.position.y + ry);
    maxY = Math.max(maxY, entity.position.y + ry);
  }
  return { minX, minY, maxX, maxY };
}