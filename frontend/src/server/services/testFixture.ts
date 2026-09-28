import { DxfReader, DwgWriter } from "@node-projects/acad-ts";

/**
 * DXF for a dense grid of `n` horizontal + `n` vertical lines over the unit
 * square (0..1000). The grid is dense so tests exercise realistic ink levels
 * rather than tripping the blank-sheet threshold: the ink fraction shrinks as
 * the render canvas grows (fixed stroke width, growing area), so the grid must
 * be dense enough to stay above `blankSheetInkFraction` at the largest
 * configured canvas.
 */
function gridDxf(n: number): string {
  const parts = ["0", "SECTION", "2", "ENTITIES"];
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    store: string[]
  ): void => {
    // 370 = explicit 1mm lineweight so hairlines stay dark after anti-aliasing
    // on large canvases (a DXF default is a sub-pixel hairline that greys out).
    store.push(
      "0", "LINE", "8", "0", "370", "100",
      "10", x1.toFixed(3), "20", y1.toFixed(3), "30", "0.0",
      "11", x2.toFixed(3), "21", y2.toFixed(3), "31", "0.0"
    );
  };
  const step = 1000 / n;
  for (let i = 1; i <= n; i++) {
    line(0, i * step, 1000, i * step, parts);
    line(i * step, 0, i * step, 1000, parts);
  }
  parts.push("0", "ENDSEC", "0", "EOF");
  return parts.join("\n");
}

/** A grid header-only DWG so the DXF below only needs the minimum tables. */
function baseDxfHeader(): string {
  return `0
SECTION
2
HEADER
9
$ACADVER
1
AC1027
9
$INSBASE
10
0.0
20
0.0
30
0.0
0
ENDSEC
0
SECTION
2
CLASSES
0
ENDSEC
0
SECTION
2
TABLES
0
ENDSEC
0
SECTION
2
BLOCKS
0
ENDSEC
`.trim();
}

/**
 * Build a real DWG byte array from a dense model-space grid via acad-ts.
 * Shared by route/integration tests.
 */
export function minimalDwgBytes(gridLines = 200): Uint8Array {
  const dxf = `${baseDxfHeader()}\n${gridDxf(gridLines)}`;
  const document = DxfReader.readFromStream(new TextEncoder().encode(dxf));
  // The DxfReader returns a document with empty symbol tables; the DWG writer
  // requires the standard entries (text style, linetypes, layers, dimstyles,
  // model/paper space blocks), so re-create the defaults before writing.
  for (const collection of [
    document.lineTypes,
    document.layers,
    document.textStyles,
    document.dimensionStyles,
    document.blockRecords,
  ]) {
    if (collection && typeof collection.createDefaultEntries === "function") {
      collection.createDefaultEntries();
    }
  }
  return DwgWriter.writeToBuffer(document);
}