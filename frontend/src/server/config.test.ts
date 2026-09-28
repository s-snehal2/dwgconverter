import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, ensureTempDirs } from "./config";

const ENV_KEYS = ["TEMP_DIR", "VERCEL"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    if (!(key in values)) {
      delete process.env[key];
    } else {
      process.env[key] = values[key]!;
    }
  }
}

describe("temp root resolution", () => {
  afterEach(() => {
    setEnv(saved);
    saved = {};
  });

  it("honours an explicit TEMP_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "dwg2png-cfg-"));
    saved = { TEMP_DIR: process.env.TEMP_DIR, VERCEL: process.env.VERCEL };
    setEnv({ TEMP_DIR: dir });
    expect(getConfig().tempRootDir).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses ./temp next to the app outside Vercel", () => {
    saved = { TEMP_DIR: process.env.TEMP_DIR, VERCEL: process.env.VERCEL };
    setEnv({});
    expect(getConfig().tempRootDir).toBe(join(process.cwd(), "temp"));
  });

  it("falls back to the OS temp dir on Vercel, where cwd is read-only", () => {
    saved = { TEMP_DIR: process.env.TEMP_DIR, VERCEL: process.env.VERCEL };
    setEnv({ VERCEL: "1" });
    // The bundle lives in a read-only /var/task, so cwd/temp cannot be created.
    expect(getConfig().tempRootDir).toBe(tmpdir());
  });
});

describe("ensureTempDirs", () => {
  afterEach(() => {
    setEnv(saved);
    saved = {};
  });

  it("creates the upload and output directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "dwg2png-cfg-"));
    saved = { TEMP_DIR: process.env.TEMP_DIR, VERCEL: process.env.VERCEL };
    setEnv({ TEMP_DIR: dir });

    const config = getConfig();
    expect(() => ensureTempDirs(config)).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not throw when the temp root cannot be created", () => {
    // A file where a directory is expected: mkdir fails even with recursive.
    const dir = mkdtempSync(join(tmpdir(), "dwg2png-cfg-"));
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    saved = { TEMP_DIR: process.env.TEMP_DIR, VERCEL: process.env.VERCEL };
    setEnv({ TEMP_DIR: blocked });

    // Blob-backed output does not need local files, so this must stay non-fatal.
    expect(() => ensureTempDirs(getConfig())).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
