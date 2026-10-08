import type { Drawing } from "../models/drawing";
import type { Entity } from "../models/entity";
import { entityVisibleOnSheet } from "./renderer";
import { textBlockSize, textHeight } from "./textMetrics";

/**
 * Collects the text a DWG actually contains, as a plain list of strings.
 *
 * Converted sheets no longer render glyphs, so this records what the source
 * drawing *says* — the text still exists in the parsed model even though it
 * never reaches the PNG. Not an AI input: the image model sees the rendered
 * PNG and nothing else.
 */

export interface DrawingNote {
  /** The string as written in the DWG, whitespace collapsed. */
  text: string;
  /** Layer the label sits on; often names the product or the discipline. */
  layer: string;
  /** Whether the label is sheet annotation or model geometry. */
  sheet: "page" | "model";
  /** Cap height in DWG units — a proxy for how prominent the label is. */
  height: number;
}

/** Collapse runs of whitespace so a multi-line note reads as one string. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function collectFrom(entities: readonly Entity[], sheet: DrawingNote["sheet"], into: DrawingNote[]): void {
  for (const entity of entities) {
    if (entity.type !== "TEXT" && entity.type !== "MTEXT") {
      continue;
    }
    // Reuse the renderer's own line splitting/wrapping so the brief lists the
    // strings that are genuinely visible on the sheet.
    const height = textHeight(entity);
    for (const line of textBlockSize(entity).lines) {
      const text = normalize(line);
      if (text.length === 0) {
        continue;
      }
      into.push({ text, layer: entity.layer, sheet, height });
    }
  }
}

/**
 * The model text a sheet can actually show.
 *
 * A layout frames the model through its viewport windows, so without this the
 * brief for every sheet listed every label in the whole drawing — two unrelated
 * sheets ended up with identical notes. Model text outside every viewport is
 * dropped; title-block and sheet annotation on the page itself is always kept,
 * and the full model is returned whenever no usable window exists (a pure model
 * view, or viewports whose window cannot be derived).
 *
 * Visibility is decided per viewport, by the same rule the renderer culls with,
 * rather than against `pageModelWindow`'s union — on a multi-viewport sheet the
 * union also spans the empty gap between the windows, so labels no viewport
 * frames were being passed to the image model as if they were on the sheet.
 */
function modelTextForSheet(drawing: Drawing): Entity[] {
  const page = drawing.page;
  const text = drawing.entities.filter((entity) => entity.type === "TEXT" || entity.type === "MTEXT");
  if (!page) {
    return text;
  }
  return text.filter((entity) => entityVisibleOnSheet(page, entity));
}

/**
 * Every distinct text string on the sheet, most prominent first.
 *
 * Deduplicated case-insensitively because title blocks and dimension strings
 * repeat the same product name many times, and a deduplicated brief is both
 * cheaper and far easier for the model to act on.
 */
export function collectDrawingNotes(drawing: Drawing, maxNotes = 150): DrawingNote[] {
  const all: DrawingNote[] = [];
  collectFrom(drawing.page?.entities ?? [], "page", all);
  collectFrom(modelTextForSheet(drawing), "model", all);

  const seen = new Set<string>();
  const unique: DrawingNote[] = [];
  for (const note of all) {
    const key = note.text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(note);
  }

  // Larger labels carry titles and product names, so they lead the brief.
  unique.sort((a, b) => b.height - a.height || a.text.length - b.text.length);
  return unique.slice(0, Math.max(0, maxNotes));
}