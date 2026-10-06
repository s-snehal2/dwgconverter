import { getConfig } from "@/server/config";
import {
  getObject,
  getObjectText,
  isSupabaseEnabled,
  listAges,
  putObject,
  removeObjects,
} from "@/server/services/supabaseStore";
import { sha256Hex } from "@/server/utils/hash";

/**
 * The AI image cache: two objects per generation, both on Supabase.
 *
 * `ai-outputs/{aiPairId}.ai.png` is the image Gemini returned and
 * `ai-outputs/{aiPairId}.meta.json` is its identity plus the window it lives in.
 * They are the *only* things this project keeps in long-lived storage: the DWG
 * itself is never stored (it is parsed in-process and dropped), and the pair
 * exists so a repeat request for the same drawing + same prompt within the
 * retention window costs no Gemini call at all.
 *
 * The input PNG is deliberately *not* stored. It is already on disk/bucket at
 * `outputs/{id}.png`, and nothing here reads its bytes — the derived id already
 * commits to which sheet, prompt and PNG bytes this output belongs to. Keeping a
 * second copy would roughly double storage per drawing to guard against a
 * half-written pair, which the output-then-meta write order already prevents.
 *
 * The key is derived, never random. `aiPairId` is a pure function of
 * (sheet, prompt, sheet-PNG bytes), so the same input always lands on the same
 * pair, which is what makes "reuse within 30 days" a lookup rather than a
 * search.
 *
 * The key deliberately excludes `conversionId`. That id is minted per upload, so
 * including it would make every re-upload of the same drawing a cache miss and
 * pay for another Gemini call. The `sheetId` and `pngHash` below are the stable
 * identities: both are derived from the DWG's bytes, and a byte-identical DWG
 * produces a byte-identical PNG.
 */

const AI_OUTPUT_PREFIX = "ai-outputs/";

/** Valid pair ids are hex SHA-256 digests, which also keeps them path-safe. */
const AI_PAIR_ID_RE = /^[0-9a-f]{64}$/;

function assertPairId(aiPairId: string): void {
  if (!AI_PAIR_ID_RE.test(aiPairId)) {
    throw new Error("Refusing to build an AI pair key from an invalid pair id.");
  }
}

function aiOutputKey(aiPairId: string): string {
  assertPairId(aiPairId);
  return `${AI_OUTPUT_PREFIX}${aiPairId}.ai.png`;
}

function aiMetaKey(aiPairId: string): string {
  assertPairId(aiPairId);
  return `${AI_OUTPUT_PREFIX}${aiPairId}.meta.json`;
}

/**
 * The exact inputs that determine a pair's identity.
 *
 * `sheetId`/`viewName` identifies which layout of which drawing the PNG came
 * from, `promptHash` covers the verbatim prompt that was sent, and `pngHash`
 * covers the PNG bytes themselves. Any change to any of them is a different
 * generation request and must not reuse the cached image.
 *
 * No per-upload id appears here: a re-upload of the same drawing is the same
 * generation request and should reuse the pair.
 */
export interface AiPairIdentity {
  sheetId: string;
  viewName: string;
  promptHash: string;
  pngHash: string;
}

/**
 * Deterministic pair id: `sha256(sheetId:viewName:promptHash:pngHash)`.
 *
 * The field separator is a newline, which cannot occur in a sheet id or a hex
 * hash, so two different field splits cannot collide into the same digest (the
 * `viewName` is hashed separately because a layout name is arbitrary user text
 * and may contain anything).
 */
export function computeAiPairId(identity: AiPairIdentity): string {
  const viewHash = sha256Hex(Buffer.from(identity.viewName, "utf8"));
  return sha256Hex(
    Buffer.from([identity.sheetId, viewHash, identity.promptHash, identity.pngHash].join("\n"), "utf8")
  );
}

/** Hash of the verbatim prompt, for use as part of the pair identity. */
export function promptHash(prompt: string): string {
  return sha256Hex(Buffer.from(prompt, "utf8"));
}

/** Pair metadata; `expiresAt` is the single authority on whether a pair is live. */
export interface AiPairMeta {
  aiPairId: string;
  sheetId: string;
  viewName: string;
  promptHash: string;
  pngHash: string;
  fileName: string;
  createdAt: number;
  expiresAt: number;
}

function parseAiPairMeta(stored: string | null, aiPairId: string): AiPairMeta | null {
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<AiPairMeta>;
    if (
      typeof parsed.aiPairId !== "string" ||
      parsed.aiPairId !== aiPairId ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }
    return {
      aiPairId,
      sheetId: typeof parsed.sheetId === "string" ? parsed.sheetId : "",
      viewName: typeof parsed.viewName === "string" ? parsed.viewName : "",
      promptHash: typeof parsed.promptHash === "string" ? parsed.promptHash : "",
      pngHash: typeof parsed.pngHash === "string" ? parsed.pngHash : "",
      fileName: typeof parsed.fileName === "string" ? parsed.fileName : "",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Write a cached AI image and its metadata.
 *
 * The image goes first and the metadata last, so a pair is never observable as
 * live while its image is missing: `readAiPair` requires the metadata, so a crash
 * between the two writes costs a redundant Gemini call rather than a wrong cache
 * hit.
 */
export async function saveAiPair(
  meta: Omit<AiPairMeta, "expiresAt" | "createdAt">,
  outputPng: Uint8Array,
  ttlMs: number = getConfig().cacheAgeMs
): Promise<AiPairMeta> {
  const now = Date.now();
  const record: AiPairMeta = { ...meta, createdAt: now, expiresAt: now + ttlMs };
  if (isSupabaseEnabled()) {
    await putObject(aiOutputKey(record.aiPairId), Buffer.from(outputPng), "image/png");
    await putObject(aiMetaKey(record.aiPairId), JSON.stringify(record), "application/json");
    return record;
  }
  // Without Supabase there is no bucket to keep the pair in; the request-scoped
  // outputs dir already holds the PNG for this request, so a miss simply costs a
  // Gemini call on the next one.
  return record;
}

/** The live pair for this id, or null when absent, malformed or expired. */
export interface AiPair {
  meta: AiPairMeta;
  output: Buffer;
}

export async function readAiPair(aiPairId: string): Promise<AiPair | null> {
  if (!isSupabaseEnabled() || !AI_PAIR_ID_RE.test(aiPairId)) {
    return null;
  }
  const meta = parseAiPairMeta(await getObjectText(aiMetaKey(aiPairId)), aiPairId);
  if (!meta || meta.expiresAt <= Date.now()) {
    return null;
  }
  const output = await getObject(aiOutputKey(aiPairId));
  if (!output || output.byteLength === 0) {
    return null;
  }
  return { meta, output };
}

/** Delete a single cached pair (image plus metadata). */
export async function removeAiPair(aiPairId: string): Promise<number> {
  if (!isSupabaseEnabled() || !AI_PAIR_ID_RE.test(aiPairId)) {
    return 0;
  }
  return removeObjects([aiOutputKey(aiPairId), aiMetaKey(aiPairId)]);
}

/**
 * Drop every pair whose `expiresAt` has passed.
 *
 * Expiry is read from the metadata rather than inferred from the object's
 * storage timestamp, because a pair may legitimately be rewritten (a
 * regeneration on the same key resets the window) and the storage clock cannot
 * see that. Keys are collected before anything is removed: Supabase pages
 * `list` by offset, so deleting mid-scan would shift the window and skip live
 * pairs.
 */
export async function sweepExpiredAiPairs(): Promise<number> {
  if (!isSupabaseEnabled()) {
    return 0;
  }
  let removed = 0;
  for (const entry of await listAges(AI_OUTPUT_PREFIX)) {
    const id = entry.key
      .slice(AI_OUTPUT_PREFIX.length)
      .replace(/\.ai\.png$/i, "")
      .replace(/\.meta\.json$/i, "");
    if (!AI_PAIR_ID_RE.test(id)) {
      continue;
    }
    const meta = parseAiPairMeta(await getObjectText(aiMetaKey(id)), id);
    if (meta && meta.expiresAt > Date.now()) {
      continue;
    }
    removed += await removeAiPair(id);
  }
  return removed;
}