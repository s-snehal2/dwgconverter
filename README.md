# DWG → PNG Converter

A small self-hosted web app that converts DWG drawings to PNG images. The
whole stack is **TypeScript/JavaScript (Next.js + Node.js)** — no Python, no
separate API service. Conversion happens in-process inside the Next.js route,
so nothing is ever sent to a third party.

> **Developer documentation:** in-depth architecture, data models, API
> reference, configuration, and error taxonomy live in
> [`docs/DEVELOPMENT.mdx`](docs/DEVELOPMENT.mdx).

## How it works

The pipeline is deliberately modular so each stage does one thing:

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

- DWG versions **R13 (AC1012)** through **AC1032** (AutoCAD 2018 and later),
  as supported by the parser.
- **Multi-sheet DWGs.** Every paper-space layout becomes its own PNG (plus
  model-space crops); a DWG with more layouts than `MAX_LAYOUTS` (default 100)
  is rejected with a clear "multiple layouts" message.
- Modelspace entities: **LINE, CIRCLE, ARC, LWPOLYLINE/POLYLINE/2D/3D,
  POINT, ELLIPSE, TEXT, MTEXT**, and **INSERT** (expanded to their block's
  entities, capped to avoid runaway recursion).
- Older pre-R13 DWGs (r1.x–r12) and password-protected files are rejected.
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
| `TEMP_DIR` | `./temp` | Directory for outputs/cache. Ignored when Supabase is configured |
| `SUPABASE_URL` | *(empty)* | Supabase project URL; enables bucket-backed storage when set |
| `SUPABASE_SERVICE_ROLE_KEY` | *(empty)* | Server-only Supabase key (`sb_secret_...`); never sent to the browser |
| `SUPABASE_STORAGE_BUCKET` | `dwg-files` | Private bucket holding outputs, AI images and the AI cache |
| `MAX_FILE_SIZE_MB` | `80` | Maximum DWG size the convert route accepts. The platform's request-body cap (~4.5 MB) bites first, since direct upload is removed |
| `MAX_LAYOUTS` | `100` | Max sheets converted per DWG; more layouts are rejected |
| `DROP_BLANK_SHEETS` | *(unset)* | Set to `true` to drop sheets showing no drawing; default keeps every sheet as a PNG |
| `MAX_PNG_DIMENSION` | `4500` | Max output width/height in px for paper-space layout sheets |
| `MODEL_PNG_DIMENSION` | *(falls back to `MAX_PNG_DIMENSION`)* | Max output width/height in px for model-space crops only. A crop frames the whole drawing, so its labels are sub-pixel and benefit from extra resolution |
| `MIN_TEXT_CAP_PX` | `4` | Legibility floor for label cap height in px. Labels draw at `max(true size, this)`; on a large drawing a true-size label is sub-pixel and would be invisible |
| `MAX_TEXT_CAP_PX` | `48` | Ceiling for label cap height in px. With `STRICT_TEXT_SCALE` on there is no legibility floor, so one mis-scaled entity height otherwise renders as type larger than the sheet |
| `MARGIN_PX` | `50` | Padding around the drawing, in px |
| `CLEANUP_AGE_MINUTES` | `43200` | Age after which converted outputs are swept (default 30 days). Covers **both** the converted sheet PNGs (`outputs/{id}.png`) and the generated AI images (`outputs/{id}.ai.png`), so either can be downloaded for 30 days from the moment of conversion |
| `CACHE_AGE_MINUTES` | `43200` | AI-image cache retention (default 30 days): re-uploading the same drawing reuses its earlier generated image instead of calling Gemini |
| `UPLOAD_AGE_MINUTES` | `60` | Age after which a staged inbound DWG is swept; normally deleted as soon as its conversion finishes |
| `RATE_LIMIT_PER_MINUTE` | `30` | Per-IP convert requests/minute |
| `COLOR_MODE` | unset | Monochrome (unset) draws black line work and black labels, with substantial filled regions in light grey so highlights still read as highlights. Set to `color` for colored (layer-based) output |
| `GEMINI_API_KEY` | *(empty)* | Google AI API key; when set, enables AI image generation via Gemini 3.1 Flash (Nano Banana 2) |
| `GEMINI_MODEL` | `gemini-3.1-flash-image` | Gemini model id used for AI image generation |
| `GEMINI_PROMPT` | *(built-in)* | Prompt sent to Gemini verbatim for architectural visualization; see `src/server/config.ts` for the default |
| `AI_GENERATION_LIMIT` | `3` | Max AI image generations per conversion; `0` means unlimited — reuse is decided by the 30-day AI pair cache instead |
| `STRICT_TEXT_SCALE` | `true` | Draw labels at their true DWG size; set to `false` to enforce the `MIN_TEXT_CAP_PX` legibility floor instead |

> Note: `GEMINI_PROMPT` is optional. Leaving it empty uses the built-in
> architectural-visualization prompt, so you never need to paste the full text
> in. It is sent to Gemini exactly as written, together with the selected sheet
> PNG and nothing else — no extracted drawing text, no per-request prompt — so a
> repeat of the same request within 30 days is served from `ai-outputs/` in
> Supabase without a Gemini call.

**Where the env file goes:** edit `frontend/.env` (Next.js auto-loads it from
the `frontend/` directory).

Start from the template: `cp frontend/.env.example frontend/.env`

Output files are download-safe: `/api/download/[id]` serves the PNG multiple
times (no deletion on download) and temp files are swept after
`CLEANUP_AGE_MINUTES` (default 30 days).

### Reusing generated images (AI cache)

When a user converts a drawing they've converted before and clicks **Generate AI
image**, the app does not call Gemini again. The request identity (sheet,
prompt, PNG bytes) is hashed into an `aiPairId` and looked up; a hit replays the
earlier generated image instantly (response includes `cached: true`, and it does
not consume a generation). The key excludes the per-upload conversion id, so
re-uploading the same DWG resolves to the same entry. Only the generated image is
stored, under `ai-outputs/` in the private Supabase Storage bucket, and it
expires after `CACHE_AGE_MINUTES` (default 30 days). Without Supabase there is
no bucket, so the cache is skipped and a miss simply costs a Gemini call.
Storage grows with the number of *unique* drawings seen within that window
(~1–2 MB each).

### Keeping storage under control

Converted PNGs, AI images, and their sidecars live in a private Supabase Storage
bucket when credentials are present. Without them, the app falls back to
`TEMP_DIR` on disk (and skips the AI cache). Objects in `outputs/` expire after
`CLEANUP_AGE_MINUTES`; `ai-outputs/` entries expire after `CACHE_AGE_MINUTES`;
uploads are deleted immediately after conversion but have a short
`UPLOAD_AGE_MINUTES` cap to catch crashes. The throttled sweep runs opportunistically on
`/api/convert`, `/api/generate`, `/api/download` and `/api/download-ai`, plus a
guaranteed daily pass from the Vercel Cron job in `vercel.json` that also ages
out cached images. `CRON_SECRET` must be set on Vercel for the cron to pass.

1. **Daily cron** — deploy the app to **production**; on Hobby the `0 4 * * *`
   job runs once per day. Set a `CRON_SECRET` environment variable on Vercel;
   the cron calls `/api/cleanup` with it as a bearer token and anything else
   gets a 401. That endpoint is the only cleanup entrypoint — it sweeps every
   group in one pass, including the AI pair cache.

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

Outputs (and, with Supabase unset, the AI cache) go to `frontend/temp/` by
default (`TEMP_DIR=./temp`); with Supabase credentials present they go to the
bucket instead. The same API endpoints are used (`/api/upload`,
`/api/convert`, `/api/generate/[id]`, `/api/download/[id]`,
`/api/download-ai/[id]`).

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
        │   ├── api/upload/route.ts            # 404 tombstone (direct uploads removed)
        │   ├── api/cleanup/route.ts           # GET: Vercel Cron sweep of expired objects
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
            │                    #   geminiImage (AI image generation, Gemini),
            │                    #   supabaseStore (bucket adapter),
            │                    #   outputStore (outputs),
            │                    #   aiPairCache (AI image reuse)
            ├── models/          # normalized Drawing / Entity / Bounds /
            │                    #   Layer / Block
            └── utils/           # geometry, errors, fileValidation, lineWeight,
                                 #   rateLimit, storage
```# dwgconverter
