import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareNames } from "./order.js";

export interface CachedImage { name: string; eTag: string; path: string }

interface IndexEntry { name: string; eTag: string }

function checkName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name === "index.json") {
    throw new Error(`invalid image name: ${JSON.stringify(name)}`);
  }
}

function readIndex(dir: string): IndexEntry[] {
  try { return JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as IndexEntry[]; } catch { return []; }
}

function toImages(dir: string, entries: IndexEntry[]): CachedImage[] {
  return entries
    .filter((e) => existsSync(join(dir, e.name)))
    .sort((a, b) => compareNames(a.name, b.name))
    .map((e) => ({ name: e.name, eTag: e.eTag, path: join(dir, e.name) }));
}

export class StagedSet {
  private entries = new Map<string, IndexEntry>();

  constructor(private cache: ImageCache) {}

  /** Write a downloaded image into the staging area. */
  async add(name: string, eTag: string, data: Buffer): Promise<void> {
    checkName(name);
    await writeFile(join(this.cache.stagingDir, name), data);
    this.entries.set(name, { name, eTag });
  }

  /** Carry an unchanged image over from the live set. */
  keep(name: string): void {
    checkName(name);
    const live = readIndex(this.cache.liveDir).find((e) => e.name === name);
    if (!live) throw new Error(`cannot keep ${name}: not in live set`);
    copyFileSync(join(this.cache.liveDir, name), join(this.cache.stagingDir, name));
    this.entries.set(name, live);
  }

  /** Replace the live set with this one in a single directory swap. */
  commit(): CachedImage[] {
    const { liveDir, stagingDir, oldDir } = this.cache;
    writeFileSync(join(stagingDir, "index.json"), JSON.stringify([...this.entries.values()]));
    rmSync(oldDir, { recursive: true, force: true });
    if (existsSync(liveDir)) renameSync(liveDir, oldDir);
    renameSync(stagingDir, liveDir);
    rmSync(oldDir, { recursive: true, force: true });
    return toImages(liveDir, [...this.entries.values()]);
  }

  abort(): void {
    rmSync(this.cache.stagingDir, { recursive: true, force: true });
  }
}

export class ImageCache {
  readonly liveDir: string;
  readonly stagingDir: string;
  readonly oldDir: string;

  constructor(private dir: string) {
    this.liveDir = join(dir, "live");
    this.stagingDir = join(dir, "staging");
    this.oldDir = join(dir, "live.old");
  }

  load(): CachedImage[] {
    rmSync(this.stagingDir, { recursive: true, force: true });
    // A swap interrupted between the two renames leaves only live.old.
    if (!existsSync(this.liveDir) && existsSync(this.oldDir)) renameSync(this.oldDir, this.liveDir);
    return toImages(this.liveDir, readIndex(this.liveDir));
  }

  stage(): StagedSet {
    rmSync(this.stagingDir, { recursive: true, force: true });
    mkdirSync(this.stagingDir, { recursive: true });
    return new StagedSet(this);
  }
}
