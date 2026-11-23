import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeKioskFiles } from "../src/kiosk-files.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kiosk-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const image = (name: string) => ({ name, url: `/images/${name}` });

describe("kiosk files for the native image viewer", () => {
  it("lists slides in display order and leaves the status empty when healthy", async () => {
    writeKioskFiles(dir, "/data/images/live", { images: [image("2.png"), image("10.png")], banner: null });
    expect(await readFile(join(dir, "slides.txt"), "utf8")).toBe("/data/images/live/2.png\n/data/images/live/10.png\n");
    expect(await readFile(join(dir, "status.txt"), "utf8")).toBe("");
    expect((await readdir(dir)).sort()).toEqual(["slides.txt", "status.txt"]);
  });

  it("shows the banner while keeping cached slides, or the empty message without images", async () => {
    const since = new Date();
    writeKioskFiles(dir, "/live", { images: [image("a.png")], banner: { kind: "offline", since, text: "No connection since 2:14 PM" } });
    expect(await readFile(join(dir, "slides.txt"), "utf8")).toBe("/live/a.png\n");
    expect(await readFile(join(dir, "status.txt"), "utf8")).toBe("No connection since 2:14 PM\n");
    writeKioskFiles(dir, "/live", { images: [], banner: null, message: "No images found" });
    expect(await readFile(join(dir, "slides.txt"), "utf8")).toBe("");
    expect(await readFile(join(dir, "status.txt"), "utf8")).toBe("No images found\n");
  });
});
