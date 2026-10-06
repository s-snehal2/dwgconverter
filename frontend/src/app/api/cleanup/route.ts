import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { sweepExpiredOutputs } from "@/server/services/outputStore";
import { sweepExpiredAiPairs } from "@/server/services/aiPairCache";

export const runtime = "nodejs";

function log(message: string): void {
  console.info(`[cleanup] ${message}`);
}

function isCronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return false;
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * GET /api/cleanup
 *
 * Daily Vercel Cron target, and the single cleanup entrypoint for the project.
 * Sweeps the Supabase Storage bucket (or disk temp dirs) so it never fills up:
 * `outputs/` on the CLEANUP_AGE_MINUTES clock, cached AI images on their own
 * 30-day `expiresAt`, plus any `uploads/` orphaned by a crashed conversion on the
 * shorter UPLOAD_AGE_MINUTES clock. Only ever runs when Vercel invokes it with
 * the CRON_SECRET bearer token; everyone else gets a 401.
 */
export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    log("Cleanup requested without a valid CRON_SECRET bearer token.");
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const config = getConfig();
  try {
    const removed = await sweepExpiredOutputs(config.cleanupAgeMs, config.uploadAgeMs);
    // Cached AI images expire on their own recorded `expiresAt` rather than on a
    // storage timestamp, so a pair rewritten mid-window is not culled early.
    const aiRemoved = await sweepExpiredAiPairs();
    log(`Cleaned up ${removed} expired output(s) and ${aiRemoved} cached AI image object(s).`);
    return Response.json({ success: true, removed, aiRemoved }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Cleanup failed: ${message}`);
    // Never echo the underlying error (file paths, store names) back to a
    // caller, even an authenticated cron one.
    return Response.json(
      { success: false, error: "Cleanup failed." },
      { status: 500, headers: { "retry-after": "3600" } },
    );
  }
}

export async function POST() {
  return Response.json(
    { success: false, error: "Use GET /api/cleanup." },
    { status: 405, headers: { allow: "GET" } },
  );
}
