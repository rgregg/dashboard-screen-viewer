import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "../src/sync.js";
import { ImageCache } from "../src/cache.js";
import { AccessError, NetworkError, type RemoteImage } from "../src/blob.js";

const img = (name: string, eTag = "e1"): RemoteImage => ({ name, eTag, size: 3 });
const instances: { engine: SyncEngine; dir: string }[] = [];

function setup(pollSeconds = 300) {
  const source = {
    listImages: vi.fn<() => Promise<RemoteImage[]>>(async () => []),
    download: vi.fn(async (_i: RemoteImage) => Buffer.from("abc")),
  };
  const dir = mkdtempSync(join(tmpdir(), "sync-"));
  const cache = new ImageCache(dir);
  const engine = new SyncEngine({ source, cache }, { pollSeconds });
  instances.push({ engine, dir });
  return { source, cache, engine };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T14:14:00")); });
afterEach(() => {
  for (const { engine, dir } of instances.splice(0)) {
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe("SyncEngine", () => {
  it("downloads only new or changed eTags and commits atomically", async () => {
    const { source, engine } = setup();
    source.listImages.mockResolvedValueOnce([img("a.png"), img("b.png")]);
    await engine.trigger();
    expect(source.download).toHaveBeenCalledTimes(2);
    source.listImages.mockResolvedValueOnce([img("a.png"), img("b.png", "e2")]);
    await engine.trigger();
    expect(source.download).toHaveBeenCalledTimes(3);
    expect(source.download.mock.calls[2][0].name).toBe("b.png");
    expect(engine.getState().images.map((i) => i.url)).toEqual(["/images/a.png?v=e1", "/images/b.png?v=e2"]);
  });

  it("keeps the previous set and sets an offline banner when listing throws NetworkError", async () => {
    const { source, engine } = setup();
    source.listImages.mockResolvedValueOnce([img("a.png")]);
    await engine.trigger();
    source.listImages.mockRejectedValueOnce(new NetworkError());
    await engine.trigger();
    const s = engine.getState();
    expect(s.images).toHaveLength(1);
    expect(s.banner).toMatchObject({ kind: "offline" });
    expect(s.banner!.text).toMatch(/^No connection since /);
  });

  it("discards a partial download set when a blob changes or fails mid-sync", async () => {
    const { source, cache, engine } = setup();
    source.listImages.mockResolvedValueOnce([img("old.png")]);
    await engine.trigger();
    source.listImages.mockResolvedValueOnce([img("a.png"), img("b.png")]);
    source.download.mockResolvedValueOnce(Buffer.from("new")).mockRejectedValueOnce(new NetworkError());
    await engine.trigger();
    expect(engine.getState().images.map((i) => i.name)).toEqual(["old.png"]);
    expect(cache.load().map((i) => i.name)).toEqual(["old.png"]);
  });

  it("loads the persistent cache immediately when restarting offline", async () => {
    const { source, cache, engine } = setup();
    const staged = cache.stage();
    await staged.add("cached.png", "v1", Buffer.from("abc"));
    staged.commit();
    source.listImages.mockRejectedValue(new NetworkError());
    engine.start();
    expect(engine.getState().images.map((i) => i.name)).toEqual(["cached.png"]);
    await vi.waitFor(() => expect(engine.getState().banner?.kind).toBe("offline"));
  });

  it("clears the banner and re-syncs on the next successful attempt", async () => {
    const { source, engine } = setup();
    source.listImages.mockRejectedValueOnce(new NetworkError());
    await engine.trigger();
    expect(engine.getState().banner).not.toBeNull();
    source.listImages.mockResolvedValueOnce([img("a.png")]);
    await vi.advanceTimersByTimeAsync(5000);
    // The retry writes real files, which fake timers cannot flush.
    await vi.waitFor(() => expect(engine.getState().banner).toBeNull());
    expect(engine.getState().images).toHaveLength(1);
  });

  it("shows a SAS access banner and keeps the cached set when access expires", async () => {
    const { source, engine } = setup();
    source.listImages.mockResolvedValueOnce([img("a.png")]);
    await engine.trigger();
    source.listImages.mockRejectedValueOnce(new AccessError());
    await engine.trigger();
    expect(engine.getState().banner).toMatchObject({ kind: "access", text: "Can't access Blob container - check SAS expiry and permissions" });
    expect(engine.getState().images).toHaveLength(1);
  });

  it("retries with exponential backoff capped at 5 minutes while failing", async () => {
    const { source, engine } = setup();
    source.listImages.mockRejectedValue(new NetworkError());
    await engine.trigger();
    expect(source.listImages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(source.listImages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.listImages).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(source.listImages).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.listImages).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(300_000);
    const calls = source.listImages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(source.listImages.mock.calls.length).toBe(calls + 1);
  });

  it("trigger() during an in-flight sync does not run concurrently, but re-syncs once afterwards", async () => {
    const { source, engine } = setup();
    let release!: (v: RemoteImage[]) => void;
    source.listImages.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const first = engine.trigger();
    const second = engine.trigger();
    const third = engine.trigger();
    expect(source.listImages).toHaveBeenCalledTimes(1);
    release([]);
    await Promise.all([first, second, third]);
    expect(source.listImages).toHaveBeenCalledTimes(2);
  });

  it("shows message 'No images found' when the container and cache are both empty", async () => {
    const { engine } = setup();
    await engine.trigger();
    expect(engine.getState().message).toBe("No images found");
  });

  it("honors cfg.pollSeconds without a push connection", async () => {
    const a = setup(300);
    await a.engine.trigger();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(a.source.listImages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.source.listImages).toHaveBeenCalledTimes(2);

    const b = setup(30);
    await b.engine.trigger();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.source.listImages).toHaveBeenCalledTimes(2);
  });

  it("emits a state event when the state changes", async () => {
    const { source, engine } = setup();
    const seen = vi.fn();
    engine.on("state", seen);
    source.listImages.mockResolvedValueOnce([img("a.png")]);
    await engine.trigger();
    expect(seen).toHaveBeenCalled();
    expect(seen.mock.lastCall![0].images).toHaveLength(1);
  });
});
