export const runtime = "nodejs";

/**
 * GET /api/upload — direct uploads are permanently disabled.
 *
 * DWGs must never be persisted to Supabase Storage, so there is no signed-URL
 * path to mint and nothing for the client to negotiate. `directUpload: false`
 * makes the browser fall back to a multipart POST to `/api/convert`, where the
 * DWG bytes are parsed in-process and then discarded.
 */
export async function GET() {
  return Response.json({ success: false, directUpload: false }, { status: 404 });
}

/**
 * POST /api/upload — permanently disabled.
 *
 * The previous signed-URL mint is gone on purpose: a signed URL is a durable
 * public handle on DWG bytes, which is exactly what must not exist. Re-uploading
 * a DWG goes through `/api/convert` as multipart form data instead.
 */
export async function POST() {
  return Response.json({ success: false, error: "Direct uploads are not enabled." }, { status: 404 });
}