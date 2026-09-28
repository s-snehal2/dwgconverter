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

export function takeRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
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

export function clearRateLimits(): void {
  windows.clear();
}

/** Best-effort caller IP from proxy headers, falling back to a shared bucket. */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return headers.get("x-real-ip") ?? "local";
}