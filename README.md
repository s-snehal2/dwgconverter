# DWG → PNG Converter

A small self-hosted web app that converts DWG drawings to PNG images. The
whole stack is **TypeScript/JavaScript (Next.js + Node.js)** — no Python, no
separate API service. Conversion happens in-process inside the Next.js route,
so nothing is ever sent to a third party.

> **Developer documentation:** in-depth architecture, data models, API
> reference, configuration, and error taxonomy live in
> [`docs/DEVELOPMENT.mdx`](docs/DEVELOPMENT.mdx).

## How it works

The pipeline is deliberately modular so each stage is unit-testable:

```
Browser ─► POST /api/convert ─► reader  (acad-ts:  DWG  → normalized model)
                                   │
                                   ▼
                            parser  (Drawing: entities, exploded inserts)
                                   │
                                   ▼
                            bounds  (fit viewport + margin)
                                   │
                                   ▼
                            renderer (own SVG renderer → clean SVG)
                                   │
                                   ▼
                            sharp   (SVG → white PNG)
                                   │
                                   ▼
              save output + sidecar → GET /api/download/[id] (one-shot)
```

Rather than relying on acad-ts's own SVG writer, we normalize its parsed model
into a small internal `Drawing` model and render our own SVG. That decouples
the rasterization from the DWG parser and keeps the renderer fully ours.

- **Reader** — `@node-projects/acad-ts` (MIT, pure TypeScript) parses the DWG,
  sitting behind a port so it could be swapped later.
- **Parser** — extracts MVP entities into a normalized model; `INSERT`s are
  expanded via `insert.explode()`. Unsupported entity types are **counted as
  skipped** with a warning; identical warnings are aggregated into one line per
  type (`Unsupported entity "HATCH" was skipped (37 occurrences).`) so large
  drawings don't produce a wall of repeated messages.
- **Renderer** — our own SVG generator (arcs/ellipses/bulges are sampled
  polylines, Y axis flipped, text rotation applied, XML escaped). The output
  **adopts the drawing's own aspect ratio** — within `MAX_PNG_DIMENSION` each
  dimension is capped independently, so a wide or tall drawing keeps its true
  proportions instead of being letterboxed or padded into a different shape.
- **Raster** — [sharp](https://sharp.pixelplumbing.com/) (Apache-2.0, via
  libvips) flattens the SVG onto a white PNG.

### Supported files & entities (MVP)

- DWG versions **R14 (AC1014)** through **AC1032** (AutoCAD 2018).
- **Single-sheet DWGs only.** A DWG with more paper-space layouts than
  `MAX_LAYOUTS` (default 1) is rejected with a clear "multiple layouts"
  message instead of being converted — no sheet picker, one PNG per upload.
- Modelspace entities: **LINE, CIRCLE, ARC, LWPOLYLINE/POLYLINE/2D/3D,
  POINT, ELLIPSE, TEXT, MTEXT**, and **INSERT** (expanded to their block's
  entities, capped to avoid runaway recursion).
- Older pre-R14 DWGs (r1.x–r13) and password-protected files are rejected.
- Other entity types (HATCH, SPLINE, SOLID, dimension objects, …) are skipped
  with a warning rather than failing.

### Known limitations

- MTEXT formatting (`\P` line breaks) is flattened to spaces; alignment and
  per-character formatting beyond the base height aren't applied.
- Text uses the drawing's insertion point/height with a default font; text
  style baselines aren't fully modeled.
- When the DWG has a paper-space layout, that layout is rendered (the
  "sheet"); otherwise raw model space is used. Multi-sheet DWGs (more pages
  than `MAX_LAYOUTS`) are rejected.
- DWG is a reverse-engineered format; acad-ts does not decode 100% of every
  feature of every version. Most files convert cleanly; a rare one may surface
  as skipped entities or a friendly error — never a hang.

## Configuration

Settings are read from the environment at runtime (see `src/server/config.ts`)
and live in a `.env` file in `frontend/` (Next.js loads it automatically).
Start from the template: `cp frontend/.env.example frontend/.env`.

Every value has a safe default, so you only need to change what matters to you:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEMP_DIR` | `./temp` | Directory for staged uploads/outputs |
| `MAX_FILE_SIZE_MB` | `50` | Maximum upload size |
| `MAX_LAYOUTS` | `1` | Maximum paper-space layouts accepted; more single-sheet rejections |
| `MAX_PNG_DIMENSION` | `3000` | Max output width/height in px |
| `MARGIN_PX` | `50` | Padding around the drawing, in px |
| `CLEANUP_AGE_MINUTES` | `43200` | Age after which converted outputs are swept (default 30 days); results stay downloadable for that window, storage grows with conversion volume |
| `CACHE_AGE_MINUTES` | `43200` | AI-image cache retention (default 30 days): re-uploading the same drawing reuses its earlier generated image instead of calling Gemini |
| `RATE_LIMIT_PER_MINUTE` | `30` | Per-IP convert requests/minute |
| `COLOR_MODE` | *(unset)* | Set to `color` for colored (layer-based) output; default is monochrome |
| `GEMINI_API_KEY` | *(empty)* | Google AI API key; when set, enables AI image generation via Gemini 3.1 Flash (Nano Banana 2) |
| `GEMINI_MODEL` | `gemini-3.1-flash-image` | Gemini model id used for AI image generation |
| `GEMINI_PROMPT` | *(built-in)* | Static prompt sent to Gemini for architectural visualization; see `src/server/config.ts` for the default |
| `AI_GENERATION_LIMIT` | `3` | Max AI image generations per converted drawing; cache hits do not consume a generation |

> Note: `GEMINI_PROMPT` is optional. Leaving it empty uses the built-in
> architectural-visualization prompt, so you never need to paste the full text
> in.

**Where the env file goes:** edit `frontend/.env` (Next.js auto-loads it from
the `frontend/` directory).

Start from the template: `cp frontend/.env.example frontend/.env`

Output files are download-safe: `/api/download/[id]` serves the PNG multiple
times (no deletion on download) and temp files are swept after
`CLEANUP_AGE_MINUTES` (default 30 days).

### Reusing generated images (AI cache)

When a user converts a drawing they've converted before and clicks **Generate AI
image**, the app does not call Gemini again. The converted PNG is hashed
(SHA-256) and looked up in a cache; a hit replays the earlier generated image
instantly (response includes `cached: true`, and it does not consume a
generation). Cached images live under a separate `cache/` namespace and expire
after `CACHE_AGE_MINUTES` (default 30 days). Storage grows with the number of
*unique* drawings seen within that window (~1–2 MB each), so on Vercel's free
Blob allowance keep the volume of unique drawings moderate or lower
`CACHE_AGE_MINUTES`.

### Keeping Vercel Blob under its free limit

On Vercel the converted PNGs, AI images, the AI-image cache and sidecars are
stored in Vercel Blob (switched on when `BLOB_READ_WRITE_TOKEN`/`BLOB_STORE_ID`
is set). Outputs expire once they are older than
`CLEANUP_AGE_MINUTES`; a throttled sweep runs opportunistically on
`/api/convert`, `/api/generate`, `/api/download` and `/api/download-ai`, plus a
guaranteed daily pass from the Vercel Cron job in `vercel.json` that also ages
out cached AI images older than `CACHE_AGE_MINUTES`.

So old outputs are removed proactively, not only by coincidence:

1. **One-off purge** (reclaim space immediately, e.g. after hitting 100%):
   from `frontend/`, run
   `$env:BLOB_READ_WRITE_TOKEN = "<token>"` then
   `node scripts/cleanup-blobs.mjs` (add `--older-than-minutes 43200` or `--all`
   to widen the net — see the script header).
2. **Daily cron** — deploy the app to **production**; on Hobby the `0 4 * * *`
   job runs once per day within the 04:00–04:59 UTC window. Set a
   `CRON_SECRET` environment variable on Vercel (≥16 random chars); the cron
   calls `/api/cleanup` with it as a bearer token and anything else gets a 401.
   Note that schedules more frequent than daily fail to deploy on Hobby.

## Run it

You only need Node.js (18+, LTS recommended) installed. The whole app runs in
one Next.js process.

```bash
# 1. Create your local env file (edit it, e.g. add GEMINI_API_KEY)
cp frontend/.env.example frontend/.env

# 2. Install dependencies
cd frontend
npm install

# 3. Run it
npm run dev              # development server with hot reload
# or for production:
# npm run build && npm start
```

Then open `http://localhost:3000`.

Temporary uploads/outputs go to `frontend/temp/` by default (`TEMP_DIR=./temp`),
and the same API endpoints are used (`/api/convert`, `/api/generate/[id]`,
`/api/download/[id]`, `/api/download-ai/[id]`).

## Project structure

```
dwg2png/
├── .gitignore
├── README.md
└── frontend/
    ├── .env.example              # template (copy + edit)
    ├── next.config.ts            # serverExternalPackages for sharp + acad-ts
    └── src/
        ├── app/
        │   ├── page.tsx                     # the conversion screen
        │   ├── api/convert/route.ts         # POST: DWG → PNG + conversionId
        │   ├── api/cleanup/route.ts         # GET: Vercel Cron sweep of expired outputs
        │   ├── api/generate/[id]/route.ts   # POST: DWG PNG → AI photorealistic image (Gemini)
        │   ├── api/download/[id]/route.ts   # GET: one-shot PNG download
        │   └── api/download-ai/[id]/route.ts # GET: Gemini AI image download
        ├── components/                      # DwgUploader / ConversionProgress /
        │                                    #   ConversionResult / ImagePreviewCard /
        │                                    #   ImageLightbox / ErrorMessage
        ├── services/api.ts, types/conversion.ts
        └── server/
            ├── config.ts
            ├── services/        # dwgReader (acad-ts port), dwgParser,
            │                    #   entityExtractor, boundsCalculator,
            │                    #   coordinateMapper, renderer, pngGenerator,
            │                    #   convertDwg (orchestrator), fileCleanup,
            │                    #   geminiImage (AI image generation, Gemini)
            ├── models/          # normalized Drawing / Entity / Bounds /
            │                    #   Layer / Block
            └── utils/           # geometry, errors, fileValidation, lineWeight,
                                 #   rateLimit, storage
```# dwgconverter
