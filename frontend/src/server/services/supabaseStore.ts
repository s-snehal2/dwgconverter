import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "@/server/utils/errors";

/**
 * Supabase Storage backend.
 *
 * Converted PNGs, AI images, their display names and the AI-image cache all
 * live in a single private bucket so they survive the convert → preview →
 * generate → download request flow on an ephemeral serverless filesystem.
 *
 * The bucket is private and the secret key never leaves the server, so every
 * byte is only reachable through the conversion-id routes, each of which
 * requires an unguessable UUID.
 *
 * Keys are grouped by prefix so retention can differ per group: `outputs/` and
 * `ai-outputs/` are kept for the configured window, while `uploads/` is a
 * transient staging area for inbound DWGs.
 *
 * When `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are absent the caller is expected
 * to fall back to local disk (see `outputStore`), which is what local dev uses.
 */

const DEFAULT_BUCKET = "dwg-files";

/** Supabase caps a single list page at 1000 rows and pages by offset. */
const LIST_PAGE_SIZE = 1000;

/**
 * Ceiling on pages walked per folder, so a mis-sized bucket cannot turn the
 * retention sweep into an unbounded scan on a request's hot path. 50 pages is
 * 50k objects; the 30-day window holds far fewer than that at any sane volume.
 */
const LIST_MAX_PAGES = 50;

/** Objects deleted per request, well under Supabase's per-call array limit. */
const REMOVE_CHUNK_SIZE = 100;

function envValue(name: string): string {
  const raw = (process.env[name] ?? "").trim();
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1).trim();
    }
  }
  return raw;
}

export function supabaseUrl(): string {
  return envValue("SUPABASE_URL");
}

/**
 * Server-only secret key. A `sb_secret_…` value is preferred: it bypasses RLS
 * like the legacy `service_role` key but additionally refuses to authenticate
 * from a browser, so a leaked copy cannot be used client-side.
 */
export function supabaseSecretKey(): string {
  return envValue("SUPABASE_SERVICE_ROLE_KEY");
}

export function supabaseBucket(): string {
  return envValue("SUPABASE_STORAGE_BUCKET") || DEFAULT_BUCKET;
}

export function isSupabaseEnabled(): boolean {
  const enabled = Boolean(supabaseUrl() && supabaseSecretKey());
  logStorageBackend(enabled);
  return enabled;
}

let loggedBackendFor = "";

/**
 * Log which storage backend is live, once per credential set. Bucket-backed
 * output only survives on Vercel when the env names match exactly
 * (`SUPABASE_URL`, not `PUBLIC_SUPABASE_URL`), so state the mode in the
 * server logs where a misconfigured deploy can be diagnosed.
 */
function logStorageBackend(enabled: boolean): void {
  const fingerprint = `${enabled}|${supabaseUrl()}|${supabaseBucket()}`;
  if (loggedBackendFor === fingerprint) {
    return;
  }
  loggedBackendFor = fingerprint;
  if (enabled) {
    console.info(`[storage] backend=supabase bucket="${supabaseBucket()}"`);
  } else {
    console.info("[storage] backend=disk (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)");
  }
}

let cachedClient: SupabaseClient | null = null;
let cachedFor = "";

/**
 * Build the client once per credential pair. Constructing a Supabase client is
 * not free, and every store call goes through here, but re-reading the env on
 * each call means dev tooling and tests can still swap credentials at runtime.
 */
function client(): SupabaseClient {
  if (!isSupabaseEnabled()) {
    throw new Error("Supabase storage is not configured.");
  }
  const url = supabaseUrl();
  const key = supabaseSecretKey();
  const fingerprint = `${url}|${key}`;
  if (!cachedClient || cachedFor !== fingerprint) {
    cachedClient = createClient(url, key, {
      // Nothing here uses Supabase Auth, and a serverless instance has no
      // session storage to persist a token into.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    cachedFor = fingerprint;
  }
  return cachedClient;
}

/**
 * Wrap a storage failure as a retryable error, never as a generic 500, so a
 * paused project or a full bucket surfaces to the user as a 503.
 */
function storageAppError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("STORAGE_UNAVAILABLE", message);
}

/** A missing object is a normal outcome, not a failure. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const candidate = err as { status?: unknown; statusCode?: unknown; code?: unknown };
  return candidate.status === 404 || candidate.statusCode === "404" || candidate.code === "NoSuchKey";
}

/**
 * Write an object, replacing any existing one.
 *
 * Overwriting is required rather than merely convenient: regenerating an AI
 * image reuses the same key, and Supabase rejects a second write to an existing
 * path unless `upsert` is set.
 */
export async function putObject(key: string, body: string | Buffer, contentType: string): Promise<void> {
  const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const { error } = await client().storage.from(supabaseBucket()).upload(key, buffer, {
    upsert: true,
    contentType,
    cacheControl: "max-age=60",
  });
  if (error) {
    throw storageAppError(error);
  }
}

/** Read an object. Returns null when it no longer exists. */
export async function getObject(key: string): Promise<Buffer | null> {
  const { data, error } = await client().storage.from(supabaseBucket()).download(key);
  if (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw storageAppError(error);
  }
  if (!data) {
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Read a small text object (display-name and generation-count sidecars). */
export async function getObjectText(key: string): Promise<string | null> {
  const bytes = await getObject(key);
  return bytes ? bytes.toString("utf8") : null;
}

/** Delete objects by key. Returns how many keys were removed. */
export async function removeObjects(keys: string[]): Promise<number> {
  if (keys.length === 0) {
    return 0;
  }
  const bucket = client().storage.from(supabaseBucket());
  for (let i = 0; i < keys.length; i += REMOVE_CHUNK_SIZE) {
    const chunk = keys.slice(i, i + REMOVE_CHUNK_SIZE);
    const { error } = await bucket.remove(chunk);
    if (error) {
      throw storageAppError(error);
    }
  }
  return keys.length;
}

/**
 * Mint a signed upload URL for one object.
 *
 * The browser PUTs the raw bytes straight to Supabase with no auth headers
 * (the token lives in the URL), so bodies beyond the platform's ~4.5 MB
 * request cap never pass through this function — only the tiny JSON envelope
 * does. The signed token is valid for two hours.
 *
 * The object is transient by contract: a DWG staged under `uploads/` is
 * deleted by the convert route's `finally` as soon as the conversion attempt
 * finishes, and the `uploads/` retention sweep is the backstop if the request
 * dies between upload and convert.
 */
export async function createSignedUploadUrl(key: string): Promise<string> {
  const { data, error } = await client().storage.from(supabaseBucket()).createSignedUploadUrl(key);
  if (error) {
    throw storageAppError(error);
  }
  if (!data?.signedUrl) {
    throw storageAppError(new Error("Supabase returned no signed upload URL."));
  }
  return data.signedUrl;
}

export interface StoredObjectAge {
  /** Full bucket-relative key, ready to hand back to `removeObjects`. */
  key: string;
  createdAtMs: number;
}

/**
 * Every object under a prefix, with its creation time — the age signal the
 * retention sweep needs.
 *
 * Three Supabase specifics this has to absorb: `list` is hierarchical, so
 * results come back relative to the prefix and must be re-joined; folder rows
 * are returned with a null `id` and null timestamps, so they are descended
 * into rather than treated as objects (a nested prefix would otherwise never be
 * listed, and therefore never swept); and listing is offset-paged, so a global
 * page ceiling bounds the whole walk.
 */
export async function listAges(prefix: string): Promise<StoredObjectAge[]> {
  const bucket = client().storage.from(supabaseBucket());
  const base = prefix.replace(/^\/+|\/+$/g, "");
  const found: StoredObjectAge[] = [];
  let pagesUsed = 0;
  let hitCeiling = false;

  async function walk(folder: string, depth: number): Promise<void> {
    if (depth > 8) {
      return;
    }
    for (let page = 0; ; page++) {
      if (pagesUsed >= LIST_MAX_PAGES) {
        hitCeiling = true;
        return;
      }
      pagesUsed += 1;
      const { data, error } = await bucket.list(folder, {
        limit: LIST_PAGE_SIZE,
        offset: page * LIST_PAGE_SIZE,
      });
      if (error) {
        throw storageAppError(error);
      }
      if (!data || data.length === 0) {
        break;
      }

      for (const entry of data) {
        if (entry.id === null) {
          await walk(folder ? `${folder}/${entry.name}` : entry.name, depth + 1);
          if (hitCeiling) {
            return;
          }
          continue;
        }
        if (!entry.created_at) {
          continue;
        }
        const createdAtMs = Date.parse(entry.created_at);
        if (!Number.isFinite(createdAtMs)) {
          continue;
        }
        found.push({ key: folder ? `${folder}/${entry.name}` : entry.name, createdAtMs });
      }

      if (data.length < LIST_PAGE_SIZE) {
        break;
      }
    }
  }

  await walk(base, 0);

  if (hitCeiling || found.length >= LIST_MAX_PAGES * LIST_PAGE_SIZE) {
    console.warn(
      `[supabaseStore] stopped listing "${base}" at the ${LIST_MAX_PAGES}-page ceiling; ` +
        "older objects in this prefix may not be swept this pass."
    );
  }

  return found;
}

