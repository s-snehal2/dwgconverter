/**
 * Minimal in-memory per-IP rate limiting for the conversion endpoints.
 * Pure reference implementation; for multi-process deployments replace this
 * with a shared store (Redis etc.), which the interface supports.
 */
interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/**
 * Hard ceiling on tracked clients. A fixed window only ever *expires* entries,
 * so a caller rotating identity headers could otherwise grow this map without
 * bound inside a single window and exhaust the instance's heap. Once the map is
 * full the entry closest to expiry is evicted to make room.
 */
const MAX_WINDOWS = 10_000;

export function takeRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  pruneExpired(now);

  const current = windows.get(ip);
  if (!current || now >= current.resetAt) {
    admit(ip, now, windowMs);
    return true;
  }
  if (current.count >= maxRequests) {
    return false;
  }
  current.count += 1;
  return true;
}

/**
 * Register a fresh window for `ip`, first shedding expired entries and then, if
 * the map is still at capacity, the entry that would expire soonest.
 */
function admit(ip: string, now: number, windowMs: number): void {
  while (windows.size >= MAX_WINDOWS) {
    let oldestIp: string | undefined;
    let oldestResetAt = Infinity;
    for (const [key, window] of windows) {
      if (window.resetAt < oldestResetAt) {
        oldestResetAt = window.resetAt;
        oldestIp = key;
      }
    }
    // The map is full of live windows and none is expired, so the least
    // recently throttled client is dropped rather than the new one.
    if (oldestIp === undefined) {
      break;
    }
    windows.delete(oldestIp);
  }
  windows.set(ip, { count: 1, resetAt: now + windowMs });
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
 * Trust order matters: `x-vercel-forwarded-for` is stamped by the platform
 * itself, so it wins outright. Otherwise the *right-most* `x-forwarded-for`
 * entry is the one the last trusted proxy appended — the left-most entries are
 * supplied by the caller and are ignored so a forged header cannot mint a new
 * bucket per request. `x-real-ip` is an nginx convention rather than a
 * platform guarantee, so it is only consulted when nothing better is present.
 */
export function clientIpFrom(headers: Headers): string {
  const verified = headers.get("x-vercel-forwarded-for");
  if (verified) {
    return normalizeIp(lastIp(verified)) ?? "unknown";
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return normalizeIp(lastIp(forwarded)) ?? "unknown";
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return normalizeIp(lastIp(realIp)) ?? "unknown";
  }

  return "local";
}

function lastIp(value: string): string | null {
  const trimmed = value.split(",").at(-1)?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Collapse the several textual spellings of one address to a single key, so a
 * caller cannot rotate `1.2.3.4`, `::ffff:1.2.3.4` and the expanded/compressed
 * IPv6 forms to hold independent buckets for the same machine.
 */
function normalizeIp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  // `[::1]:443` -> `::1`, while a bare address is left untouched.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  const address = bracketed ? bracketed[1] : value;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  return mapped ? mapped[1] : address;
}
