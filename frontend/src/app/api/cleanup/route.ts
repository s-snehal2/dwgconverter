import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { sweepExpiredOutputs, sweepExpiredCache } from "@/server/services/outputStore";

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
 * Daily Vercel Cron target. Sweeps outputs older than CLEANUP_AGE_MINUTES so
 * Vercel Blob (or disk temp dirs) never fill up. Only ever runs when Vercel
 * invokes it with the CRON_SECRET bearer token; everyone else gets a 401.
 */
export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    log("Cleanup requested without a valid CRON_SECRET bearer token.");
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const config = getConfig();
  try {
    const removed = await sweepExpiredOutputs(config.cleanupAgeMs);
    const cacheRemoved = await sweepExpiredCache(config.cacheAgeMs);
    log(
      `Cleaned up ${removed} expired output(s) and ${cacheRemoved} cached image(s).`
    );
    return Response.json({ success: true, removed, cacheRemoved }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Cleanup failed: ${message}`);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST() {
  return Response.json({ success: false, error: "Use GET /api/cleanup." }, { status: 405 });
}