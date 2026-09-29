/**
 * Minimal in-memory per-IP rate limiting for the conversion endpoint.
 * Pure reference implementation; for multi-process deployments replace this
 * with a shared store (Redis etc.), which the interface supports.
 */
interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Only reaped when it grows past this size, to preserve the hot path. */
const MAX_WINDOWS = 10_000;

export function takeRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  pruneExpired(now);

  const current = windows.get(ip);
  if (!current || now >= current.resetAt) {
    windows.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= maxRequests) {
    return false;
  }
  current.count += 1;
  return true;
}

/** Drop expired windows when the map gets large so memory stays bounded. */
function pruneExpired(now: number): void {
  if (windows.size < MAX_WINDOWS) {
    return;
  }
  for (const [ip, window] of windows) {
    if (now >= window.resetAt) {
      windows.delete(ip);
    }
  }
}

export function clearRateLimits(): void {
  windows.clear();
}

/**
 * Best-effort caller IP from proxy headers, falling back to a shared bucket.
 *
 * Prefers Vercel's own headers, then the right-most `x-forwarded-for` entry so
 * a caller cannot fake a new bucket by appending to a header the proxy fills.
 */
export function clientIpFrom(headers: Headers): string {
  const verified = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (verified) {
    return lastIp(verified) ?? "unknown";
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return lastIp(forwarded) ?? "unknown";
  }

  return "local";
}

function lastIp(value: string): string | null {
  const trimmed = value.split(",").at(-1)?.trim();
  return trimmed ? trimmed : null;
}