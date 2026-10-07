# DWG to PNG Converter - Comprehensive Analysis Report

## 1. Overall Project Structure

### Language and Frameworks
- **Language**: TypeScript/JavaScript
- **Framework**: Next.js 16.3.4 (App Router)
- **Runtime**: Node.js (in-process conversion)
- **UI**: React 19, shadcn/ui, Tailwind CSS 4

### Key Libraries Used
- **DWG Parser**: @node-projects/acad-ts v3.1.0 (MIT, pure TypeScript) - reads and parses DWG files (R13/AC1012 through AC1032)
- **Rasterization**: sharp v0.35.4 (Apache-2.0, via libvips) - converts SVG to PNG
- **Storage**: @supabase/supabase-js v2.117.2 - optional bucket-backed storage
- **AI Generation**: Gemini 3.1 Flash (Nano Banana 2) via Google AI API


### Conversion Pipeline (from README)

1. **Browser** → POST /api/convert`r
2. **Reader** (dwgReader.ts): @node-projects/acad-ts DWG → normalized CadDocument
3. **Parser** (dwgParser.ts): Extract entities into internal Drawing model; INSERTs exploded via insert.explode()`r
4. **Bounds** (oundsCalculator.ts): Calculate viewport/fit with margins
5. **Renderer** (enderer.ts): Own SVG renderer (arcs/ellipses/bulges → sampled polylines, Y flipped, text handling)
6. **Sharp** (pngGenerator.ts): SVG → white PNG
7. **Output**: Save + sidecar, GET /api/download/[id] (one-shot)



## 2. DWG → PNG Conversion - Code Details

### Reader (rontend/src/server/services/dwgReader.ts)
- Interface RawDwgData { version, document: CadDocument }
- AcadDwgReader.read() uses DwgReader.readFromStream(arrayBuffer) from acad-ts
- Abstraction via port allows swapping engines later

### Parser (rontend/src/server/services/dwgParser.ts) - Lines 1-905
**Key classes/functions:**
- WarningCollector (lines 98-125): Aggregates unsupported entities into one warning per type with counts (prevents spam)
- parseViews() (849-875): Enumerates all renderable views (model space + named paper-space layouts)
- parseDwg() (878-905): Legacy single-drawing pipeline
- 
ormalizeEntity() (206-556): Converts acad-ts entities to internal model; handles INSERT expansion (depth-limited to 16), HATCH, DIMENSION, LEADER, MLINE, etc.
- esolveInfiniteLines() (157-198): Stretches XLINE/RAY to sheet bounds
- xpandDimensionBlock() (582-631): Extracts dimension geometry from *D blocks, passes dimension text height
- MAX_BLOCK_EXPANSION_DEPTH = 16 to prevent stack overflow
- pushAll() (140-144): Avoids V8 argument limit for large arrays

**Multi-sheet support:** DWG layouts are enumerated; each paper-space layout becomes its own view. Model space and layouts are handled separately.



### Entity Extraction (rontend/src/server/services/entityExtractor.ts) - Lines 1-1253
**Core extraction logic:**
- xtractEntity() (1111-1228): Maps acad-ts entity types to normalized model
- **Supported primitives:** LINE, CIRCLE, ARC, POINT, ELLIPSE, LWPOLYLINE/POLYLINE/2D/3D, TEXT, MTEXT, SPLINE (tessellated), SOLID, FACE3D, INSERT (expanded), HATCH, LEADER, DIMENSION (via block expansion), MLINE, MULTILEADER, TOLERANCE, MESH/POLYGONMESH/POLYFACEMESH (decomposed), MODELERGEOMETRY (wires), TABLE, OLE2FRAME, SHAPE, WALL, UNDERLAYENTITY, RASTERIMAGE
- **MTEXT handling:**
  - mtextPlainText() (138-225): Custom parser for MText formatting - strips inline codes, handles stacked fractions (\\S), Unicode escapes (\\U+), legacy %% codes, \\P/\\n line breaks, non-breaking spaces (\\~). Notably has fix for acad-ts infinite loop on unterminated codes
  - Fractions like 1/2, 1/4 etc mapped to Unicode vulgar fractions (lines 82-101)
- **Text positioning:** 	extPosition() (368-377): Correctly chooses between alignmentPoint and insertPoint based on alignment (was critical fix - see comments)
- **Text height:** 	extEntityHeight() (397-412): Consults entity height, then style heights, then dimension style, then fallback
- **HATCH:** xtractHatch() (491-545): Pattern hatches exploded to segments; solid hatches become filled polygons per boundary loop
- **LEADER:** xtractLeader() (552-609): Polyline + optional arrowhead (sized from style with segment constraints)
- **MESH/meshes:** Decomposed to face polygons
- **Color handling:** esolveColorHex() (240-251): Near-white (>=240,240,240) converted to black for monochrome readability


### Bounds & Coordinate Mapping
- **boundsCalculator.ts** (1-208): Computes axis-aligned bounds for all entity types; handles bulge segments in polylines, arcs, ellipses (full/partial with extrema sampling), text bounds via textMetrics
- **coordinateMapper.ts** (1-93):
  - computeViewport(): Fits bounds maintaining aspect ratio; caps independently by maxWidth/maxHeight; applies margin; uses drawing's own aspect ratio (not letterboxed)
  - worldToPixel(): Y axis inverted (CAD +Y up → pixel Y down), offset for margins



### Text Metrics (rontend/src/server/services/textMetrics.ts) - Lines 1-282
**Key for text rendering and sizing:**
- TEXT_CAP_HEIGHT_RATIO = 0.7 (CAD cap height vs SVG font-size)
- DEFAULT_MIN_TEXT_CAP_PX = 4 - Legibility floor for sub-pixel annotations (critical for large drawings)
- DEFAULT_MAX_TEXT_CAP_PX = 48 - Ceiling to prevent runaway oversized text (safety net)
- MTEXT_LINE_PITCH = 1.5, MTEXT_LINE_PITCH_CAP = MTEXT_LINE_PITCH / TEXT_CAP_HEIGHT_RATIO`r
- DEFAULT_TEXT_HEIGHT = 1 (used when DWG stores 0)
- Glyph advance widths defined per character class for layout calculations
- 	extEntityBounds() (228-282): Computes rotated axis-aligned bounds based on alignment (left/center/right, top/middle/bottom/baseline)
- 	extBlockSize() (185-219): Handles MTEXT wrapping to rectangle width; splits into lines as renderer will

**Important behavior:** The minTextCapPx is a floor applied when not in strict mode - trades exact scale for legibility on large drawings where labels are < 1px.



### Renderer (rontend/src/server/services/renderer.ts) - Lines 1-952
**Own SVG renderer (key design choice - decoupled from acad-ts SVG writer):**
- Renders to SVG with Y inverted, margins applied, monochrome by default
- Handles paper-space pages: renders sheet entities + clips model content in each viewport window
- Arc/ellipse/bulge flattening via sampling (chord error ~0.25px, arcStep uses asin)
- Polyline bulge handling (lines 592-661 in context): Properly computes arc spans
- **Text rendering** (lines 859-908):
  - Applies min/max cap height with strictTextScale flag (strict means no floor)
  - Handles rotation, oblique skew, widthFactor (stretches glyphs via textLength)
  - MTEXT lines as tspans with proper line pitch
  - Baseline shift by alignment (top/middle/bottom/baseline)
- **Supersampling** (resolveSupersample): Optional quality boost; capped at MAX_SUPERSAMPLED_EDGE (6144px) to avoid huge SVGs
- **Fills** (lines 729-829):
  - Monochrome: substantial filled regions (>= 0.0005 of sheet area) filled with #d4d4d4 (light grey) so line work remains visible; small fills (arrows) remain stroke-only
  - Color mode: fills at HIGHLIGHT_FILL_OPACITY (0.2) with entity color
- **Lite mode** for thumbnails: decimates model in viewports, skips certain types, fast preview for large models
- **Entity passes** in z-order: POLYLINE, LINE, CIRCLE, ARC, ELLIPSE, SOLID, IMAGE, POINT, TEXT, MTEXT

**Critical behavior**: entityVisibleOnSheet() checks if entity is framed by untwisted viewports (with frozen layer handling). modelWindowRect() unions projected spans to avoid over-culling.


### Rasterization & Conversion Orchestration
- **pngGenerator.ts**: Uses sharp to convert SVG to PNG (white background). Configurable max width/height.
- **convertDwg.ts** (1-405):
  - inspectDwg(): Validates DWG signature, reads, parses views
  - enderViewPng(): Renders one view with appropriate max dimension (model gets modelPngDimension for better resolution, layouts get maxPngDimension)
  - convertDwg(): Multi-sheet orchestrator. Selects views, optionally drops blank sheets (partitionRenderable), renders each, checks ink fraction if dropping enabled. Has budget checking (ssertWithinBudget) to fail early before platform timeout.
  - supersampleForEntities(): For >= 15000 entities, forces supersample=1 to avoid slow huge renders
  - selectViewsForConversion(): Handles layouts + model clusters (model space split into clusters for tight crops)
- **blankSheet.ts**: Detects if sheets show drawing content (hasSheetDrawing checks if model geometry lands in viewport windows for layouts)
- **rasterInkFraction**: Measures percentage of non-white pixels in PNG to detect near-empty sheets



## 3. Accuracy Issues, TODOs, Hardcoded Values

### Known Limitations (from README)
- MTEXT formatting (\\P line breaks) flattened to spaces; per-character formatting beyond base height not fully applied
- Text uses insertion point/height with default font; text style baselines not fully modeled
- Multi-sheet DWGs with > MAX_LAYOUTS rejected
- Older pre-R13 DWGs and password-protected rejected
- DWG is reverse-engineered; some features may be skipped (warnings aggregated)

### Hardcoded Values Found in Code
**renderer.ts:**
- LITE_VIEWPORT_MAX_ENTITIES = 3500 (line ~66)
- LITE_FAST_PREVIEW_ENTITIES = 12000 (line ~69)
- MAX_SUPERSAMPLED_EDGE = 6144 (line ~76)
- HIGHLIGHT_FILL_OPACITY = 0.2 (line ~732)
- MONOCHROME_HIGHLIGHT_FILL = 

### Notes on Accuracy/Edge Cases (from code comments)
- **Text alignment fix**: 	extPosition() (entityExtractor) only honors alignmentPoint if it's not a unit direction vector (magnitude not near 0 or 1) - this fixed dimension text being drawn at origin. Important detail for accuracy.
- **INSERT transform for ATTRIB** (dwgParser line 258-261): Insert.explode() doesn't transform ATTRIB entities; code applies subEntity.applyTransform(transform) to put attributes in correct position.
- **Dimension text height**: For entities from dimension blocks, dimension style text height is passed down to avoid default 1-unit height making dimensions oversized.
- **Infinite lines (XLINE/RAY)**: Stretched to sheet bounds via resolveInfiniteLines after collecting all finite geometry - direction preserved.
- **Closed polylines with bulges**: Careful handling to avoid drawing spurious chords across arcs when closing.
- **TableEntity checked before INSERT** (entityExtractor checks TableEntity instanceof before Insert branch) because TableEntity extends Insert.
- **HATCH pattern vs solid**: Pattern hatches exploded to line segments; falls back to boundary if explode fails.
- **Mesh face extraction**: Falls back to generic vertex path if polyface mesh face indices inconsistent.


### TODOs/FIXMEs/BUGs
No TODO/FIXME/BUG/XXX comments found in the source code (rontend/src/**/*.ts, rontend/src/**/*.tsx).



## 4. Existing Tests

**Test discovery:** Searched for *.test.* and *.spec.* files under rontend/ excluding 
ode_modules. No test files were found in the source tree (only test files exist in node_modules dependencies).
**No project-specific test suite present.** The package.json shows only dev/build/lint scripts - no test script.
Available scripts (rontend/package.json):
- dev - next dev
- uild - next build
- start - next start
- lint - eslint

To run checks: cd frontend && npm run lint (eslint available). There are no unit/integration tests defined in the codebase as checked.



## 5. README/Docs Describing the Conversion Pipeline

### README.md (225 lines)
- Complete overview of pipeline with ASCII diagram
- Lists supported entities and versions (R13-AC1032)
- Known limitations
- Configuration reference (all env vars with defaults)
- Storage/cleanup behavior, AI cache
- Setup and run instructions
- Project structure

### docs/DEVELOPMENT.mdx
Referenced as in-depth architecture, data models, API reference, configuration, error taxonomy. (File exists at docs/DEVELOPMENT.mdx - should contain detailed pipeline docs)

### Key Documentation Points
- **Modular pipeline**: reader → parser → bounds → renderer → raster
- **Own SVG renderer** (not acad-ts SVG) for decoupling
- **INSERT explosion** with depth limit
- **Warning aggregation** (count-based for unsupported entities)
- **Multi-sheet**: each layout becomes a PNG; > MAX_LAYOUTS rejected
- **Model clustering**: model space split into clusters for tight crops (in convertDwg logic)
- **Blank sheet detection**: optional via DROP_BLANK_SHEETS + ink fraction check
- **Text fidelity**: detailed notes on minTextCapPx trade-off, strictTextScale

All pipeline stages are documented in README. The code matches the documented behavior closely (with extensive inline comments explaining design decisions, especially around text positioning/alignment, fills, etc.).



## Final Summary

**Core DWG→PNG conversion implementation is complete and well-structured.** The design prioritizes fidelity, performance for large drawings, and clear error handling.

**Key strengths:**
- Clean separation: reader → parser → renderer → raster with normalized internal models
- Own SVG renderer with careful text positioning, alignment, and metric calculations (addressing several edge cases)
- Smart handling of sub-pixel text via configurable min cap height + strict mode option
- Good performance safeguards (block expansion depth limit, pushAll to avoid V8 arg limit, supersample reduction for huge drawings, budget checks)
- Accurate geometric handling (bulges, arcs, ellipses, infinite lines stretched to bounds)
- Thoughtful monochrome fill logic (substantial regions only, small fills like arrows remain crisp)
- Multi-sheet and model clustering support
- Warning aggregation to avoid spam

**Test coverage:** None in the project source (no test files under frontend/src, no test script in package.json). Only linting available.

