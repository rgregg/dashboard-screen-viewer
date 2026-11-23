import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageCache } from "../src/cache.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cache-")); });

async function seed(c: ImageCache, files: Record<string, string>) {
  const s = c.stage();
  for (const [n, d] of Object.entries(files)) await s.add(n, `etag-${n}`, Buffer.from(d));
  return s.commit();
}

describe("ImageCache", () => {
  it("load returns the previous set after a new process starts", async () => {
    await seed(new ImageCache(dir), { "b.png": "B", "a.png": "A" });
    const loaded = new ImageCache(dir).load();
    expect(loaded.map((i) => i.name)).toEqual(["a.png", "b.png"]);
    expect(loaded[0].eTag).toBe("etag-a.png");
    expect(readFileSync(loaded[0].path, "utf8")).toBe("A");
  });

  it("abort leaves the live set untouched", async () => {
    const c = new ImageCache(dir);
    await seed(c, { "a.png": "A" });
    const s = c.stage();
    await s.add("z.png", "e", Buffer.from("Z"));
    s.abort();
    expect(c.load().map((i) => i.name)).toEqual(["a.png"]);
  });

  it("commit removes files not in the staged set", async () => {
    const c = new ImageCache(dir);
    await seed(c, { "a.png": "A", "b.png": "B" });
    const set = await seed(c, { "b.png": "B2" });
    expect(set.map((i) => i.name)).toEqual(["b.png"]);
    expect(readdirSync(join(dir, "live")).filter((f) => f.endsWith(".png"))).toEqual(["b.png"]);
  });

  it("keep carries an unchanged file over from the live set", async () => {
    const c = new ImageCache(dir);
    await seed(c, { "a.png": "A" });
    const s = c.stage();
    s.keep("a.png");
    await s.add("b.png", "e", Buffer.from("B"));
    const set = s.commit();
    expect(set.map((i) => i.name)).toEqual(["a.png", "b.png"]);
    expect(readFileSync(set[0].path, "utf8")).toBe("A");
    expect(set[0].eTag).toBe("etag-a.png");
  });

  it("a crash mid-stage (staged dir left behind) is cleaned on next load", async () => {
    const c = new ImageCache(dir);
    await seed(c, { "a.png": "A" });
    c.stage().add("partial.png", "e", Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(dir, "staging"))).toBe(true);
    const loaded = new ImageCache(dir).load();
    expect(loaded.map((i) => i.name)).toEqual(["a.png"]);
    expect(existsSync(join(dir, "staging"))).toBe(false);
  });

  it("rejects names containing path separators", async () => {
    const s = new ImageCache(dir).stage();
    await expect(s.add("../evil.png", "e", Buffer.from("x"))).rejects.toThrow(/name/);
  });

  it("recovers the old set if a swap was interrupted after moving live aside", () => {
    mkdirSync(join(dir, "live.old"), { recursive: true });
    writeFileSync(join(dir, "live.old", "a.png"), "A");
    writeFileSync(join(dir, "live.old", "index.json"), JSON.stringify([{ name: "a.png", eTag: "e" }]));
    expect(new ImageCache(dir).load().map((i) => i.name)).toEqual(["a.png"]);
  });

  it("load returns an empty list for a fresh directory", () => {
    expect(new ImageCache(dir).load()).toEqual([]);
  });
});
